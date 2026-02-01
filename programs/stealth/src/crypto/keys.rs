//! Key validation for the on-chain program
//!
//! Note: Full DKSAP cryptographic operations happen off-chain in the CLI.
//! The on-chain program validates that public keys are well-formed.

/// Field prime for Curve25519: p = 2^255 - 19
const FIELD_PRIME: [u8; 32] = [
    0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
];

/// Validate that bytes could represent a valid compressed Edwards Y point
///
/// Performs multiple validation checks:
/// 1. Not the identity point (all zeros)
/// 2. Not obviously invalid (all ones)
/// 3. Y-coordinate is less than the field prime (2^255 - 19)
/// 4. Not a known small-order point
///
/// Note: Full decompression would be ideal but is expensive on-chain.
/// The actual cryptographic verification happens off-chain when the
/// recipient scans for payments.
pub fn validate_curve_point(bytes: &[u8; 32]) -> bool {
    // Check 1: Reject identity point (all zeros)
    if bytes.iter().all(|&b| b == 0) {
        return false;
    }

    // Check 2: Reject all ones (obviously invalid)
    if bytes.iter().all(|&b| b == 0xFF) {
        return false;
    }

    // Check 3: Y-coordinate must be less than field prime
    // Compare in little-endian (as stored)
    if !is_less_than_field_prime(bytes) {
        return false;
    }

    // Check 4: Reject known small-order points
    // These are the 8 small-order points on Curve25519
    if is_small_order_point(bytes) {
        return false;
    }

    true
}

/// Check if y-coordinate is less than field prime (2^255 - 19)
/// Bytes are in little-endian order
fn is_less_than_field_prime(bytes: &[u8; 32]) -> bool {
    // Clear the sign bit for comparison (bit 255)
    let mut y = *bytes;
    y[31] &= 0x7F;

    // Compare in big-endian order (most significant byte first)
    for i in (0..32).rev() {
        if y[i] < FIELD_PRIME[i] {
            return true;
        }
        if y[i] > FIELD_PRIME[i] {
            return false;
        }
    }
    // Equal to prime is invalid
    false
}

/// Check if the point is one of the 8 small-order points
/// Small-order points can be used in certain attacks
fn is_small_order_point(bytes: &[u8; 32]) -> bool {
    // Known small-order points on Ed25519 (compressed Y coordinates)
    const SMALL_ORDER_POINTS: [[u8; 32]; 8] = [
        // Identity (already checked, but include for completeness)
        [0; 32],
        // Point of order 2
        [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
        ],
        // Points of order 4
        [
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ],
        [
            0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
        ],
        // Points of order 8
        [
            0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0,
            0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0,
            0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39,
            0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05,
        ],
        [
            0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f,
            0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f,
            0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6,
            0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
        ],
        [
            0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0,
            0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0,
            0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39,
            0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x85,
        ],
        [
            0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f,
            0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f,
            0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6,
            0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0xfa,
        ],
    ];

    SMALL_ORDER_POINTS.iter().any(|p| p == bytes)
}

/// Stealth meta-address containing scan and spend public keys
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StealthMetaAddress {
    /// Scan public key (S = s·G)
    pub scan_pubkey: [u8; 32],
    /// Spend public key (B = b·G)
    pub spend_pubkey: [u8; 32],
}

impl StealthMetaAddress {
    /// Create a new meta-address from scan and spend public keys
    pub fn new(scan_pubkey: [u8; 32], spend_pubkey: [u8; 32]) -> Option<Self> {
        if !validate_curve_point(&scan_pubkey) || !validate_curve_point(&spend_pubkey) {
            return None;
        }

        Some(Self {
            scan_pubkey,
            spend_pubkey,
        })
    }

    /// Encode meta-address to bytes (64 bytes total)
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut bytes = [0u8; 64];
        bytes[..32].copy_from_slice(&self.scan_pubkey);
        bytes[32..].copy_from_slice(&self.spend_pubkey);
        bytes
    }

    /// Decode meta-address from bytes
    pub fn from_bytes(bytes: &[u8; 64]) -> Option<Self> {
        let mut scan_pubkey = [0u8; 32];
        let mut spend_pubkey = [0u8; 32];
        scan_pubkey.copy_from_slice(&bytes[..32]);
        spend_pubkey.copy_from_slice(&bytes[32..]);

        Self::new(scan_pubkey, spend_pubkey)
    }
}

// ============================================================================
// STEALTH ADDRESS DERIVATION (On-chain verification)
// ============================================================================
//
// Full ECDH is expensive on-chain, so we use a hash-based approach:
// 1. Off-chain: Sender computes full stealth address using ECDH
// 2. On-chain: Program verifies using deterministic hash
//
// The stealth address is: hash(scan_pubkey || spend_pubkey || ephemeral_pubkey)
// This is verified on-chain, while the actual ECDH happens off-chain.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

/// Derive stealth address from meta-address and ephemeral key
///
/// On-chain we use a deterministic derivation that can be verified.
/// The actual ECDH computation happens off-chain.
///
/// Returns the derived Pubkey for the stealth address.
pub fn derive_stealth_address(
    scan_pubkey: &[u8; 32],
    spend_pubkey: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
) -> Result<Pubkey> {
    // Validate inputs
    if !validate_curve_point(scan_pubkey) {
        return Err(error!(crate::error::StealthError::InvalidScanPubkey));
    }
    if !validate_curve_point(spend_pubkey) {
        return Err(error!(crate::error::StealthError::InvalidSpendPubkey));
    }
    if !validate_curve_point(ephemeral_pubkey) {
        return Err(error!(crate::error::StealthError::InvalidEphemeralKey));
    }

    // Deterministic derivation: hash(scan || spend || ephemeral)
    // This creates a unique address for each (recipient, ephemeral) pair
    let mut hasher_input = Vec::with_capacity(96);
    hasher_input.extend_from_slice(scan_pubkey);
    hasher_input.extend_from_slice(spend_pubkey);
    hasher_input.extend_from_slice(ephemeral_pubkey);

    let hash = keccak::hash(&hasher_input);

    // Convert hash to Pubkey
    Ok(Pubkey::new_from_array(hash.0))
}

/// Compute stealth commitment for announcement verification
///
/// commitment = hash(scan_pubkey || spend_pubkey || ephemeral_pubkey || "commitment")
pub fn compute_stealth_commitment(
    scan_pubkey: &[u8; 32],
    spend_pubkey: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
) -> [u8; 32] {
    let mut hasher_input = Vec::with_capacity(107);
    hasher_input.extend_from_slice(scan_pubkey);
    hasher_input.extend_from_slice(spend_pubkey);
    hasher_input.extend_from_slice(ephemeral_pubkey);
    hasher_input.extend_from_slice(b"commitment");

    keccak::hash(&hasher_input).0
}
