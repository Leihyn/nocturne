//! ZK Proof Types
//!
//! Data structures for Groth16 proofs and verification keys on BN254 curve.

use anchor_lang::prelude::*;

/// Size of a G1 point (2 * 32 bytes for x, y coordinates)
pub const G1_SIZE: usize = 64;

/// Size of a G2 point (2 * 64 bytes for x, y coordinates in Fp2)
pub const G2_SIZE: usize = 128;

/// Groth16 proof on BN254 curve
///
/// A Groth16 proof consists of three elliptic curve points:
/// - A (G1 point): First proof element
/// - B (G2 point): Second proof element
/// - C (G1 point): Third proof element
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Groth16Proof {
    /// Proof element A (G1 point: 64 bytes)
    pub pi_a: [u8; G1_SIZE],
    /// Proof element B (G2 point: 128 bytes)
    pub pi_b: [u8; G2_SIZE],
    /// Proof element C (G1 point: 64 bytes)
    pub pi_c: [u8; G1_SIZE],
}

impl Groth16Proof {
    pub const SIZE: usize = G1_SIZE + G2_SIZE + G1_SIZE; // 256 bytes
}

/// Verification key for the stealth address circuit
///
/// Generated during the trusted setup ceremony and used to verify proofs.
/// This is exported from snarkjs after the setup.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VerificationKey {
    /// Alpha (G1 point)
    pub alpha: [u8; G1_SIZE],
    /// Beta (G2 point)
    pub beta: [u8; G2_SIZE],
    /// Gamma (G2 point)
    pub gamma: [u8; G2_SIZE],
    /// Delta (G2 point)
    pub delta: [u8; G2_SIZE],
    /// IC (Input Commitment) points - array of G1 points
    /// Length depends on number of public inputs + 1
    /// For our circuit: 2 (1 public input + 1)
    pub ic: Vec<[u8; G1_SIZE]>,
}

impl VerificationKey {
    /// Minimum size: alpha + beta + gamma + delta + 2 IC points
    pub const MIN_SIZE: usize = G1_SIZE + G2_SIZE * 3 + G1_SIZE * 2;
}

/// Public inputs for the stealth address verification circuit
///
/// These are the values that are publicly known and verified against the proof.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PublicInputs {
    /// The commitment hash (field element, 32 bytes)
    /// This is Poseidon(ephemeral_pubkey, scan_pubkey, spend_pubkey, stealth_address)
    pub commitment_hash: [u8; 32],
}

impl PublicInputs {
    pub const SIZE: usize = 32;

    /// Convert to field element for proof verification
    /// The value must be less than the BN254 scalar field modulus
    pub fn to_field_elements(&self) -> Vec<[u8; 32]> {
        vec![self.commitment_hash]
    }
}

/// Stored verification key account
///
/// This account stores the verification key on-chain so it doesn't
/// need to be passed with every transaction.
#[account]
pub struct StoredVerificationKey {
    /// Authority that can update the key
    pub authority: Pubkey,
    /// The verification key data
    pub vk_data: Vec<u8>,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl StoredVerificationKey {
    /// Seeds for PDA derivation
    pub const SEEDS: &'static [u8] = b"vk";

    /// Estimated size for account allocation
    pub fn space(vk_data_len: usize) -> usize {
        8 + // discriminator
        32 + // authority
        4 + vk_data_len + // vk_data vec
        1 // bump
    }
}
