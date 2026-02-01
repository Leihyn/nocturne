//! Groth16 Proof Verification
//!
//! Implements Groth16 verification using Solana's alt_bn128 syscalls.
//! The verification equation is:
//!
//! e(A, B) = e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
//!
//! Where:
//! - e() is the pairing function
//! - vk_x = IC[0] + sum(public_inputs[i] * IC[i+1])
//!
//! Reference: https://eprint.iacr.org/2016/260.pdf
//!
//! NOTE: This implementation requires Solana 2.0+ for the alt_bn128 module.
//! For Solana 1.18, ZK verification is disabled (returns error).

use anchor_lang::prelude::*;
use super::types::*;
use crate::error::StealthError;

/// BN254 curve scalar field modulus (r)
/// r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
pub const SCALAR_FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// Negate a G1 point by negating the y-coordinate
/// On BN254, if P = (x, y), then -P = (x, p - y)
/// where p is the field modulus
pub fn negate_g1(point: &[u8; G1_SIZE]) -> [u8; G1_SIZE] {
    let mut result = *point;

    // BN254 base field modulus p (in LITTLE-ENDIAN)
    // p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
    let p_le: [u8; 32] = [
        0x47, 0xfd, 0x7c, 0xd8, 0x16, 0x8c, 0x20, 0x3c,
        0x8d, 0xca, 0x71, 0x68, 0x91, 0x6a, 0x81, 0x97,
        0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8,
        0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
    ];

    // y coordinate is at bytes 32..64 (big-endian)
    let mut y_le = [0u8; 32];
    y_le.copy_from_slice(&point[32..64]);
    y_le.reverse(); // Convert to little-endian

    // Compute p - y in little-endian
    let mut borrow = 0u16;
    let mut neg_y_le = [0u8; 32];
    for i in 0..32 {
        let temp = 256u16 + (p_le[i] as u16) - (y_le[i] as u16) - borrow;
        neg_y_le[i] = temp as u8;
        borrow = if temp < 256 { 1 } else { 0 };
    }

    // Convert back to big-endian
    neg_y_le.reverse();
    result[32..64].copy_from_slice(&neg_y_le);

    result
}

/// Verify a Groth16 proof
///
/// This function verifies that a Groth16 proof is valid for the given
/// public inputs and verification key.
///
/// # Arguments
/// * `proof` - The Groth16 proof (A, B, C points)
/// * `public_inputs` - The public inputs (field elements)
/// * `vk` - The verification key
///
/// # Returns
/// * `Ok(true)` if the proof is valid
/// * `Ok(false)` if the proof is invalid
/// * `Err(...)` if verification failed due to an error
///
/// # Verification Equation
/// The Groth16 verification equation is:
/// e(A, B) = e(α, β) · e(Σ(public_input_i · IC_i), γ) · e(C, δ)
///
/// Rearranged for multi-pairing check:
/// e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1
///
/// Where vk_x = IC[0] + Σ(public_inputs[i] · IC[i+1])
pub fn verify_groth16(
    proof: &Groth16Proof,
    public_inputs: &[[u8; 32]],
    vk: &VerificationKey,
) -> Result<bool> {
    // Validate inputs
    require!(
        public_inputs.len() + 1 == vk.ic.len(),
        StealthError::InvalidProofInputs
    );

    // Validate that public inputs are in the scalar field
    for input in public_inputs {
        if !is_valid_scalar(input) {
            return Ok(false);
        }
    }

    // Validate proof points are not empty
    if proof.pi_a.iter().all(|&b| b == 0) ||
       proof.pi_b.iter().all(|&b| b == 0) ||
       proof.pi_c.iter().all(|&b| b == 0) {
        return Ok(false);
    }

    // Use Solana's alt_bn128 syscalls for verification
    // Available in solana-program 1.16+
    #[cfg(target_os = "solana")]
    {
        use anchor_lang::solana_program::alt_bn128::{
            prelude::*,
            AltBn128Error,
        };

        // Step 1: Compute vk_x = IC[0] + Σ(public_inputs[i] · IC[i+1])
        let mut vk_x = vk.ic[0];
        msg!("Computing vk_x with {} public inputs and {} IC points", public_inputs.len(), vk.ic.len());

        for (i, input) in public_inputs.iter().enumerate() {
            // Scalar multiplication: public_input[i] * IC[i+1]
            let mut mul_input = [0u8; 96]; // 64 bytes point + 32 bytes scalar
            mul_input[0..64].copy_from_slice(&vk.ic[i + 1]);
            mul_input[64..96].copy_from_slice(input);

            let scaled_ic = match alt_bn128_multiplication(&mul_input) {
                Ok(result) => {
                    let mut point = [0u8; G1_SIZE];
                    point.copy_from_slice(&result);
                    point
                }
                Err(e) => {
                    msg!("Scalar mul failed for input {}: {:?}", i, e);
                    return Ok(false);
                }
            };

            // Point addition: vk_x + scaled_ic
            let mut add_input = [0u8; 128]; // 64 bytes + 64 bytes
            add_input[0..64].copy_from_slice(&vk_x);
            add_input[64..128].copy_from_slice(&scaled_ic);

            vk_x = match alt_bn128_addition(&add_input) {
                Ok(result) => {
                    let mut point = [0u8; G1_SIZE];
                    point.copy_from_slice(&result);
                    point
                }
                Err(e) => {
                    msg!("Point add failed for input {}: {:?}", i, e);
                    return Ok(false);
                }
            };
        }
        msg!("vk_x computed successfully");

        // Step 2: Negate A for the pairing equation
        let neg_a = negate_g1(&proof.pi_a);

        // Step 3: Prepare pairing input
        // Format: [(G1, G2), (G1, G2), (G1, G2), (G1, G2)]
        // Pairs: (-A, B), (α, β), (vk_x, γ), (C, δ)
        let mut pairing_input = Vec::with_capacity(768);

        // Pair 1: e(-A, B)
        pairing_input.extend_from_slice(&neg_a);
        pairing_input.extend_from_slice(&proof.pi_b);

        // Pair 2: e(α, β)
        pairing_input.extend_from_slice(&vk.alpha);
        pairing_input.extend_from_slice(&vk.beta);

        // Pair 3: e(vk_x, γ)
        pairing_input.extend_from_slice(&vk_x);
        pairing_input.extend_from_slice(&vk.gamma);

        // Pair 4: e(C, δ)
        pairing_input.extend_from_slice(&proof.pi_c);
        pairing_input.extend_from_slice(&vk.delta);

        // Step 4: Perform multi-pairing check
        // Result should be 1 (identity) if proof is valid
        msg!("Pairing input size: {} bytes (expected 768)", pairing_input.len());
        match alt_bn128_pairing(&pairing_input) {
            Ok(result) => {
                // Check if result equals 1 (identity element)
                // The result is 32 bytes: 0x00...001 for true, 0x00...000 for false
                let is_valid = result[31] == 1 && result[0..31].iter().all(|&b| b == 0);
                msg!("Groth16 verification result: {}", is_valid);
                Ok(is_valid)
            }
            Err(e) => {
                msg!("Pairing check failed: {:?}", e);
                Ok(false)
            }
        }
    }

    // Non-Solana target (tests): fall back to stub
    #[cfg(not(target_os = "solana"))]
    {
        msg!("Groth16 verification: running in non-Solana environment");
        msg!("Use oracle attestation for off-chain verification");
        err!(StealthError::ZkVerificationNotSupported)
    }
}

/// Check if a scalar is valid (less than the scalar field modulus)
fn is_valid_scalar(scalar: &[u8; 32]) -> bool {
    // Compare in big-endian
    for i in 0..32 {
        if scalar[i] < SCALAR_FIELD_MODULUS[i] {
            return true;
        }
        if scalar[i] > SCALAR_FIELD_MODULUS[i] {
            return false;
        }
    }
    false // Equal to modulus is invalid
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_scalar() {
        // Zero is valid
        let zero = [0u8; 32];
        assert!(is_valid_scalar(&zero));

        // One is valid
        let mut one = [0u8; 32];
        one[31] = 1;
        assert!(is_valid_scalar(&one));

        // Modulus - 1 is valid
        let mut max_valid = SCALAR_FIELD_MODULUS;
        // Subtract 1
        for i in (0..32).rev() {
            if max_valid[i] > 0 {
                max_valid[i] -= 1;
                break;
            }
            max_valid[i] = 0xFF;
        }
        assert!(is_valid_scalar(&max_valid));

        // Modulus itself is invalid
        assert!(!is_valid_scalar(&SCALAR_FIELD_MODULUS));

        // Larger than modulus is invalid
        let mut too_large = SCALAR_FIELD_MODULUS;
        too_large[31] = too_large[31].wrapping_add(1);
        assert!(!is_valid_scalar(&too_large));
    }
}
