//! Zero-Knowledge Proof Verification Module
//!
//! This module implements Groth16 proof verification for stealth address
//! derivation proofs. It uses Solana's alt_bn128 syscalls for elliptic
//! curve operations on the BN254 curve.
//!
//! ## Overview
//!
//! The ZK circuit proves that a stealth address was correctly derived
//! from a meta-address without revealing private inputs:
//!
//! Public inputs:
//! - commitment_hash: Hash of the payment parameters
//!
//! Private inputs (hidden in proof):
//! - ephemeral_pubkey
//! - scan_pubkey
//! - spend_pubkey
//! - stealth_address
//!
//! ## Usage
//!
//! 1. Off-chain: Generate proof using snarkjs with the Circom circuit
//! 2. On-chain: Submit proof with `verify_stealth_send` instruction
//! 3. The program verifies the proof before processing the payment

pub mod groth16;
pub mod types;
pub mod verifier;

pub use groth16::*;
pub use types::*;
pub use verifier::*;
