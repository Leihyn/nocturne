//! DKSAP - Dual-Key Stealth Address Protocol (On-chain validation)
//!
//! The full cryptographic operations are performed off-chain by the CLI.
//! This module contains minimal on-chain validation.
//!
//! ## Protocol Overview
//!
//! ### Recipient Setup
//! 1. Generate scan key pair: (s, S) where S = s·G
//! 2. Generate spend key pair: (b, B) where B = b·G
//! 3. Publish meta-address: (S, B)
//!
//! ### Sender Flow (CLI)
//! 1. Generate ephemeral key pair: (r, R) where R = r·G
//! 2. Compute shared secret: ss = r·S = r·s·G
//! 3. Derive stealth pubkey: P = B + H(ss)·G
//! 4. Send funds to P and publish R on-chain
//!
//! ### Recipient Scanning (CLI)
//! 1. For each announcement with ephemeral key R:
//! 2. Compute shared secret: ss = s·R = s·r·G (same as sender!)
//! 3. Derive expected pubkey: P' = B + H(ss)·G
//! 4. If P' matches payment address, derive private key: p = b + H(ss)

use super::keys::StealthMetaAddress;

/// Domain separator for hashing to prevent cross-protocol attacks
pub const DOMAIN_SEPARATOR: &[u8] = b"stealthsol_v1";

/// Verify basic structure of a stealth payment
///
/// This only checks that the ephemeral key is well-formed.
/// Full cryptographic verification happens off-chain.
pub fn verify_stealth_structure(
    _meta: &StealthMetaAddress,
    ephemeral_pubkey: &[u8; 32],
    _claimed_stealth: &[u8; 32],
) -> bool {
    // Check ephemeral key is not zero
    if ephemeral_pubkey.iter().all(|&b| b == 0) {
        return false;
    }

    // The actual derivation verification happens off-chain
    // because it requires expensive curve operations
    true
}
