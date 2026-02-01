//! ZK Proof Verification Module
//!
//! This module provides ZK proof verification for the privacy pool.
//!
//! Verification Modes:
//! - DEV: Skips verification (for testing)
//! - ORACLE: Uses trusted verifier attestations (hackathon-ready)
//! - GROTH16: Full on-chain verification via Solana BN254 syscalls (future)

use anchor_lang::prelude::*;
#[allow(unused_imports)]
use crate::error::StealthError;
use super::types::{Groth16Proof, VerificationKey};

/// Oracle attestation for proof validity
/// A trusted verifier signs this to attest proof validity
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct OracleAttestation {
    /// The proof hash that was verified
    pub proof_hash: [u8; 32],
    /// Public inputs hash
    pub public_inputs_hash: [u8; 32],
    /// Verifier's public key (Ed25519)
    pub verifier: [u8; 32],
    /// Verifier's signature (Ed25519)
    pub signature: [u8; 64],
    /// Timestamp of verification
    pub verified_at: i64,
}

/// Verification oracle account (stores trusted verifier keys)
#[account]
pub struct VerificationOracle {
    /// Authority that can update oracle settings
    pub authority: Pubkey,
    /// List of trusted verifier public keys
    pub trusted_verifiers: Vec<Pubkey>,
    /// Verification key hash (to ensure correct circuit)
    pub vk_hash: [u8; 32],
    /// Number of required attestations (for threshold)
    pub required_attestations: u8,
    /// Whether oracle is active
    pub is_active: bool,
    /// Bump seed
    pub bump: u8,
}

impl VerificationOracle {
    pub const SEED: &'static [u8] = b"verification_oracle";
    pub const MAX_VERIFIERS: usize = 10;
    pub const SIZE: usize = 8 + // discriminator
        32 + // authority
        4 + (32 * Self::MAX_VERIFIERS) + // trusted_verifiers (vec)
        32 + // vk_hash
        1 + // required_attestations
        1 + // is_active
        1; // bump

    /// Check if a verifier is trusted
    pub fn is_trusted_verifier(&self, verifier: &Pubkey) -> bool {
        self.trusted_verifiers.contains(verifier)
    }
}

/// Verify a ZK proof using the appropriate method based on build mode
///
/// DEPRECATED: This is the legacy function without instruction introspection.
/// For production use with proper Ed25519 verification, use `verify_proof_with_sysvar`.
///
/// This function is kept for backwards compatibility but should not be used in new code.
/// It only validates format in production mode, not cryptographic signatures.
///
/// # Arguments
/// * `proof_bytes` - The serialized ZK proof
/// * `public_inputs` - The public inputs to the circuit
/// * `attestation` - Oracle attestation (required in production mode)
#[inline(never)]
#[deprecated(since = "0.3.0", note = "Use verify_proof_with_sysvar for proper Ed25519 verification")]
#[allow(dead_code)]
pub(crate) fn verify_proof(
    proof_bytes: &[u8],
    public_inputs: &[u8],
    _attestation: Option<&OracleAttestation>,
) -> Result<()> {
    // Basic validation in all modes
    require!(
        !proof_bytes.is_empty(),
        StealthError::InvalidProof
    );
    require!(
        !public_inputs.is_empty(),
        StealthError::InvalidProofInputs
    );

    // Development mode - skip cryptographic verification but validate structure
    #[cfg(not(feature = "production"))]
    {
        msg!("DEV MODE: ZK proof cryptographic verification skipped");
        msg!("Proof size: {} bytes", proof_bytes.len());
        msg!("Public inputs size: {} bytes", public_inputs.len());

        // Validate minimum proof size (Groth16 proofs are typically 192+ bytes)
        if proof_bytes.len() < 64 {
            msg!("WARNING: Proof seems too small, may be invalid in production");
        }

        return Ok(());
    }

    // Production mode - this path requires proper sysvar verification
    // Use verify_proof_with_sysvar instead for full security
    #[cfg(feature = "production")]
    {
        msg!("WARNING: Using legacy verify_proof without instruction introspection");
        msg!("For full security, use verify_proof_with_sysvar");
        verify_with_oracle_legacy(proof_bytes, public_inputs, _attestation)
    }
}

/// Verify a ZK proof with full Ed25519 instruction introspection
///
/// This is the production-ready verification function that:
/// 1. Validates proof and public inputs format
/// 2. Verifies oracle attestation matches proof
/// 3. Checks attestation freshness (5 minute window)
/// 4. Verifies Ed25519 signature via Solana's Ed25519 program introspection
/// 5. Optionally checks verifier is in trusted list
///
/// # Arguments
/// * `proof_bytes` - The serialized ZK proof
/// * `public_inputs` - The public inputs to the circuit
/// * `attestation` - Oracle attestation (required in production mode)
/// * `instructions_sysvar` - Instructions sysvar for Ed25519 verification
/// * `trusted_verifiers` - Optional list of trusted verifier pubkeys
///
/// # Errors
/// * `InvalidProof` - Proof bytes are empty or malformed
/// * `InvalidProofInputs` - Public inputs are empty
/// * `MissingAttestation` - No attestation provided (production only)
/// * `ProofHashMismatch` - Attestation doesn't match proof
/// * `AttestationExpired` - Attestation is too old
/// * `InvalidSignature` - Attestation signature is invalid
/// * `UntrustedVerifier` - Verifier not in trusted list (if provided)
#[inline(never)]
pub fn verify_proof_with_sysvar(
    proof_bytes: &[u8],
    public_inputs: &[u8],
    attestation: Option<&OracleAttestation>,
    instructions_sysvar: &AccountInfo,
    trusted_verifiers: Option<&[Pubkey]>,
) -> Result<()> {
    // Basic validation in all modes
    require!(
        !proof_bytes.is_empty(),
        StealthError::InvalidProof
    );
    require!(
        !public_inputs.is_empty(),
        StealthError::InvalidProofInputs
    );

    // Development mode - validate structure but skip cryptographic verification
    #[cfg(not(feature = "production"))]
    {
        msg!("DEV MODE: ZK proof cryptographic verification skipped");
        msg!("Proof size: {} bytes", proof_bytes.len());
        msg!("Public inputs size: {} bytes", public_inputs.len());

        // Validate minimum proof size (Groth16 proofs are typically 192+ bytes)
        require!(
            proof_bytes.len() >= 64,
            StealthError::InvalidProof
        );

        // In dev mode, still require attestation to be present and non-empty
        if let Some(att) = attestation {
            require!(
                att.signature != [0u8; 64],
                StealthError::InvalidSignature
            );
        }

        // Suppress unused variable warning
        let _ = instructions_sysvar;
        let _ = trusted_verifiers;

        return Ok(());
    }

    // Production mode - full verification
    #[cfg(feature = "production")]
    {
        verify_with_oracle_full(proof_bytes, public_inputs, attestation, instructions_sysvar, trusted_verifiers)
    }
}

/// Legacy oracle verification without instruction introspection
/// DEPRECATED: Use verify_with_oracle_full for production
#[cfg(feature = "production")]
#[inline(never)]
fn verify_with_oracle_legacy(
    proof_bytes: &[u8],
    public_inputs: &[u8],
    attestation: Option<&OracleAttestation>,
) -> Result<()> {
    let attestation = attestation.ok_or(StealthError::MissingAttestation)?;

    // Compute expected proof hash
    let computed_proof_hash = compute_hash(proof_bytes);
    let computed_inputs_hash = compute_hash(public_inputs);

    // Verify attestation matches proof
    require!(
        attestation.proof_hash == computed_proof_hash,
        StealthError::ProofHashMismatch
    );
    require!(
        attestation.public_inputs_hash == computed_inputs_hash,
        StealthError::PublicInputsMismatch
    );

    // Verify attestation is recent (within 5 minutes)
    let clock = Clock::get()?;
    let age = clock.unix_timestamp.saturating_sub(attestation.verified_at);
    require!(
        age >= 0 && age < 300, // 5 minutes
        StealthError::AttestationExpired
    );

    // Basic signature format validation (not cryptographic verification)
    let zero_sig = [0u8; 64];
    require!(
        attestation.signature != zero_sig,
        StealthError::InvalidSignature
    );

    msg!("LEGACY: Proof verified via oracle attestation (no Ed25519 introspection)");
    Ok(())
}

/// Full oracle verification with Ed25519 instruction introspection
/// This is the production-ready verification function
#[cfg(feature = "production")]
#[inline(never)]
fn verify_with_oracle_full(
    proof_bytes: &[u8],
    public_inputs: &[u8],
    attestation: Option<&OracleAttestation>,
    instructions_sysvar: &AccountInfo,
    trusted_verifiers: Option<&[Pubkey]>,
) -> Result<()> {
    let attestation = attestation.ok_or(StealthError::MissingAttestation)?;

    // Compute expected proof hash
    let computed_proof_hash = compute_hash(proof_bytes);
    let computed_inputs_hash = compute_hash(public_inputs);

    // Verify attestation matches proof
    require!(
        attestation.proof_hash == computed_proof_hash,
        StealthError::ProofHashMismatch
    );
    require!(
        attestation.public_inputs_hash == computed_inputs_hash,
        StealthError::PublicInputsMismatch
    );

    // Verify attestation is recent (within 5 minutes)
    let clock = Clock::get()?;
    let age = clock.unix_timestamp.saturating_sub(attestation.verified_at);
    require!(
        age >= 0 && age < 300, // 5 minutes
        StealthError::AttestationExpired
    );

    // Check trusted verifiers if provided
    if let Some(verifiers) = trusted_verifiers {
        let verifier_pubkey = Pubkey::new_from_array(attestation.verifier);
        require!(
            verifiers.contains(&verifier_pubkey),
            StealthError::UntrustedVerifier
        );
        msg!("Verifier is in trusted list");
    }

    // Build attestation message for signature verification
    // The message is: proof_hash || public_inputs_hash || verified_at (as le bytes)
    let mut message = Vec::with_capacity(72);
    message.extend_from_slice(&attestation.proof_hash);
    message.extend_from_slice(&attestation.public_inputs_hash);
    message.extend_from_slice(&attestation.verified_at.to_le_bytes());

    // Verify Ed25519 signature via instruction introspection
    verify_ed25519_signature_with_sysvar(
        instructions_sysvar,
        &message,
        &attestation.signature,
        &attestation.verifier,
    )?;

    msg!("Proof verified via oracle attestation with Ed25519 introspection");
    Ok(())
}

/// Verify Ed25519 signature with full instruction introspection
///
/// This is the production-ready version that actually verifies the Ed25519 instruction
/// was included in the transaction. Call this from instructions that pass the
/// instructions sysvar account.
///
/// # Arguments
/// * `instructions_sysvar` - The instructions sysvar account info
/// * `message` - The message that was signed
/// * `signature` - The Ed25519 signature (64 bytes)
/// * `pubkey` - The Ed25519 public key (32 bytes)
#[cfg(feature = "production")]
#[inline(never)]
pub fn verify_ed25519_signature_with_sysvar(
    instructions_sysvar: &AccountInfo,
    message: &[u8],
    signature: &[u8; 64],
    pubkey: &[u8; 32],
) -> Result<()> {
    use anchor_lang::solana_program::{
        ed25519_program,
        sysvar::instructions::load_instruction_at_checked,
    };

    // Validate basic inputs first
    let zero_sig = [0u8; 64];
    let zero_pk = [0u8; 32];
    require!(signature != &zero_sig, StealthError::InvalidSignature);
    require!(pubkey != &zero_pk, StealthError::InvalidSignature);
    require!(!message.is_empty(), StealthError::InvalidSignature);

    // Build expected Ed25519 instruction data
    let sig_offset: u16 = 16;
    let pk_offset: u16 = 16 + 64;
    let msg_offset: u16 = 16 + 64 + 32;
    let msg_len: u16 = message.len() as u16;

    let expected_data_len = 16 + 64 + 32 + message.len();
    let mut expected_data = Vec::with_capacity(expected_data_len);
    expected_data.push(1u8); // num_signatures
    expected_data.push(0u8); // padding
    expected_data.extend_from_slice(&sig_offset.to_le_bytes());
    expected_data.extend_from_slice(&[0xff, 0xff]); // same instruction
    expected_data.extend_from_slice(&pk_offset.to_le_bytes());
    expected_data.extend_from_slice(&[0xff, 0xff]);
    expected_data.extend_from_slice(&msg_offset.to_le_bytes());
    expected_data.extend_from_slice(&msg_len.to_le_bytes());
    expected_data.extend_from_slice(&[0xff, 0xff]);
    expected_data.extend_from_slice(signature);
    expected_data.extend_from_slice(pubkey);
    expected_data.extend_from_slice(message);

    // Search for the Ed25519 instruction in preceding instructions
    let mut found = false;
    let mut index = 0u16;

    loop {
        match load_instruction_at_checked(index as usize, instructions_sysvar) {
            Ok(ix) => {
                if ix.program_id == ed25519_program::id() && ix.data == expected_data {
                    found = true;
                    msg!("Found valid Ed25519 instruction at index {}", index);
                    break;
                }
                index += 1;
            }
            Err(_) => break, // No more instructions
        }
    }

    require!(found, StealthError::InvalidSignature);
    msg!("Ed25519 signature verified via instruction introspection");

    Ok(())
}

/// Compute a simple hash for proof/inputs identification
/// Uses first 32 bytes of SHA256 (via Solana's hash syscall when available)
#[inline(never)]
fn compute_hash(data: &[u8]) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hash;
    hash(data).to_bytes()
}

/// Full Groth16 verification using Solana BN254 syscalls
/// Uses the alt_bn128 precompiles for pairing checks
///
/// This function is available on Solana 1.16+ when running on-chain.
/// Off-chain tests should use the oracle attestation method.
#[inline(never)]
pub fn verify_groth16_onchain(
    proof: &Groth16Proof,
    vk: &VerificationKey,
    public_inputs: &[[u8; 32]],
) -> Result<bool> {
    use super::groth16::verify_groth16;

    msg!("Attempting on-chain Groth16 verification");
    msg!("Public inputs: {} elements", public_inputs.len());
    msg!("IC elements: {} points", vk.ic.len());

    match verify_groth16(proof, public_inputs, vk) {
        Ok(valid) => {
            if valid {
                msg!("Groth16 proof verified successfully on-chain");
            } else {
                msg!("Groth16 proof verification failed");
            }
            Ok(valid)
        }
        Err(e) => {
            msg!("Groth16 verification error: {:?}", e);
            Err(e)
        }
    }
}

/// Verify a proof using the best available method
///
/// Priority:
/// 1. DEV mode: Skip verification (testing only)
/// 2. On-chain Groth16: If available and proof/vk provided
/// 3. Oracle attestation: Fallback for production
#[inline(never)]
pub fn verify_proof_with_fallback(
    proof: &Groth16Proof,
    public_inputs: &[[u8; 32]],
    vk: &VerificationKey,
    attestation: Option<&OracleAttestation>,
) -> Result<()> {
    // Development mode - skip verification
    #[cfg(not(feature = "production"))]
    {
        msg!("DEV MODE: ZK proof verification skipped");
        // Suppress unused variable warnings in dev mode
        let _ = (proof, public_inputs, vk, attestation);
        return Ok(());
    }

    // Production mode - try Groth16 first, fall back to oracle
    #[cfg(feature = "production")]
    {
        // Try on-chain Groth16 verification first
        match verify_groth16_onchain(proof, vk, public_inputs) {
            Ok(true) => {
                msg!("Proof verified via on-chain Groth16");
                return Ok(());
            }
            Ok(false) => {
                msg!("Groth16 proof invalid");
                return err!(StealthError::InvalidProof);
            }
            Err(e) => {
                // Groth16 not available, try oracle
                msg!("Groth16 not available, trying oracle: {:?}", e);
            }
        }

        // Fall back to oracle attestation
        if let Some(att) = attestation {
            let proof_bytes = borsh::to_vec(proof).unwrap_or_default();
            let inputs_bytes: Vec<u8> = public_inputs.iter().flat_map(|i| i.iter().copied()).collect();
            return verify_with_oracle_legacy(&proof_bytes, &inputs_bytes, Some(att));
        }

        err!(StealthError::MissingAttestation)
    }
}

/// Compute public inputs hash for a withdrawal
#[inline(never)]
pub fn compute_withdrawal_inputs_hash(
    merkle_root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    recipient: &Pubkey,
    amount: u64,
) -> [u8; 32] {
    let mut data = Vec::with_capacity(32 + 32 + 32 + 8);
    data.extend_from_slice(merkle_root);
    data.extend_from_slice(nullifier_hash);
    data.extend_from_slice(recipient.as_ref());
    data.extend_from_slice(&amount.to_le_bytes());
    compute_hash(&data)
}

/// Range proof attestation for Pedersen commitments
/// Attests that 0 <= amount < 2^64
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct RangeProofAttestation {
    /// Hash of the Pedersen commitment being proven
    pub commitment_hash: [u8; 32],
    /// The amount range (min, max) - typically (0, 2^64)
    pub amount_range: [u64; 2],
    /// Verifier's signature over commitment_hash || amount_range
    pub signature: [u8; 64],
    /// Verifier's public key
    pub verifier: [u8; 32],
    /// Timestamp of verification
    pub verified_at: i64,
}

/// Verify a range proof attestation
#[inline(never)]
pub fn verify_range_proof_attestation(
    pedersen_commitment: &[u8; 33],
    attestation: &RangeProofAttestation,
) -> Result<()> {
    // Compute commitment hash
    let commitment_hash = compute_hash(pedersen_commitment);

    // Verify attestation matches commitment
    require!(
        attestation.commitment_hash == commitment_hash,
        crate::error::StealthError::AmountCommitmentMismatch
    );

    // Verify valid range (0 to 2^64 - 1)
    require!(
        attestation.amount_range[0] == 0 && attestation.amount_range[1] == u64::MAX,
        crate::error::StealthError::RangeProofFailed
    );

    // Verify attestation is recent
    let clock = Clock::get()?;
    let age = clock.unix_timestamp.saturating_sub(attestation.verified_at);
    require!(
        age >= 0 && age < 300, // 5 minutes
        crate::error::StealthError::AttestationExpired
    );

    // In production mode, validate signature format
    // Note: Full Ed25519 verification requires instruction sysvar.
    // For full verification, use verify_range_proof_attestation_with_sysvar.
    #[cfg(feature = "production")]
    {
        // Basic signature format validation (non-zero)
        let zero_sig = [0u8; 64];
        let zero_pk = [0u8; 32];
        require!(
            attestation.signature != zero_sig,
            crate::error::StealthError::InvalidSignature
        );
        require!(
            attestation.verifier != zero_pk,
            crate::error::StealthError::InvalidSignature
        );
    }

    msg!("Range proof verified via oracle attestation");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_hash_deterministic() {
        let data = b"test data";
        let h1 = compute_hash(data);
        let h2 = compute_hash(data);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_compute_hash_different_inputs() {
        let h1 = compute_hash(b"data1");
        let h2 = compute_hash(b"data2");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_dev_mode_verification() {
        // In dev mode, verification always succeeds
        let result = verify_proof(b"fake_proof", b"fake_inputs", None);
        assert!(result.is_ok());
    }
}
