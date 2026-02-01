//! Withdrawal Commitment State
//!
//! Implements a commit-reveal scheme for randomized withdrawal timing.
//! This prevents timing analysis attacks by decoupling the intent to withdraw
//! from the actual withdrawal execution.
//!
//! ## Flow
//!
//! 1. User commits: hash(proof || recipient || user_random || nonce)
//! 2. User waits minimum delay (enforced on-chain)
//! 3. User reveals within time window and executes withdrawal
//!
//! ## Privacy Benefits
//!
//! - User chooses their own random delay within allowed window
//! - No on-chain VRF request that could be linked to withdrawal
//! - Observer sees commitment, but doesn't know when execution will happen

use anchor_lang::prelude::*;

/// Commitment for a pending withdrawal
///
/// Created when user commits to withdraw, executed when they reveal.
/// The delay between commit and reveal provides timing privacy.
#[account]
#[derive(Default)]
pub struct WithdrawalCommitment {
    /// Owner who created this commitment
    pub owner: Pubkey,

    /// Hash of (proof || recipient || user_random || nonce)
    /// This binds the commitment to specific withdrawal parameters
    pub commitment_hash: [u8; 32],

    /// Slot when commitment was created
    pub commit_slot: u64,

    /// Unix timestamp when commitment was created
    pub commit_timestamp: i64,

    /// Minimum delay in seconds before withdrawal can execute
    /// Enforced on-chain - cannot be bypassed
    pub min_delay_seconds: i64,

    /// Maximum delay in seconds - must execute before this
    /// Prevents commitments from being held indefinitely
    pub max_delay_seconds: i64,

    /// Pool denomination this withdrawal is for (1, 10, or 100 SOL)
    pub denomination: u64,

    /// Whether this commitment has been executed
    pub executed: bool,

    /// Whether this commitment has been cancelled
    pub cancelled: bool,

    /// Bump seed for PDA
    pub bump: u8,
}

impl WithdrawalCommitment {
    pub const SEED: &'static [u8] = b"withdrawal_commitment";

    /// Account discriminator (8) + owner (32) + commitment_hash (32) + commit_slot (8)
    /// + commit_timestamp (8) + min_delay_seconds (8) + max_delay_seconds (8)
    /// + denomination (8) + executed (1) + cancelled (1) + bump (1)
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1;

    /// Default minimum delay: 1 hour (3600 seconds)
    pub const DEFAULT_MIN_DELAY: i64 = 3600;

    /// Default maximum delay: 24 hours (86400 seconds)
    pub const DEFAULT_MAX_DELAY: i64 = 86400;

    /// Absolute minimum delay allowed: 30 minutes
    pub const ABSOLUTE_MIN_DELAY: i64 = 1800;

    /// Absolute maximum delay allowed: 7 days
    pub const ABSOLUTE_MAX_DELAY: i64 = 604800;

    /// Check if the commitment can be executed now
    pub fn can_execute(&self, current_timestamp: i64) -> bool {
        if self.executed || self.cancelled {
            return false;
        }

        let elapsed = current_timestamp - self.commit_timestamp;
        elapsed >= self.min_delay_seconds && elapsed <= self.max_delay_seconds
    }

    /// Check if the commitment has expired
    pub fn is_expired(&self, current_timestamp: i64) -> bool {
        let elapsed = current_timestamp - self.commit_timestamp;
        elapsed > self.max_delay_seconds
    }

    /// Time remaining until commitment can be executed (0 if already executable)
    pub fn time_until_executable(&self, current_timestamp: i64) -> i64 {
        let elapsed = current_timestamp - self.commit_timestamp;
        if elapsed >= self.min_delay_seconds {
            0
        } else {
            self.min_delay_seconds - elapsed
        }
    }
}

/// Keeper intent for randomized withdrawal execution
///
/// Used when the user wants a keeper network to execute their withdrawal
/// at a random time within their specified window.
#[account]
pub struct KeeperIntent {
    /// Owner who created this intent
    pub owner: Pubkey,

    /// Encrypted withdrawal data (encrypted to keeper network's threshold key)
    /// Contains: proof, recipient, and other withdrawal params
    /// Max 512 bytes for encrypted payload
    pub encrypted_payload: [u8; 512],

    /// Actual length of encrypted_payload (may be less than 512)
    pub payload_length: u16,

    /// Unix timestamp - earliest execution time
    pub window_start: i64,

    /// Unix timestamp - latest execution time
    pub window_end: i64,

    /// Pool denomination
    pub denomination: u64,

    /// Fee offered to keeper (in lamports)
    pub keeper_fee: u64,

    /// Whether this intent has been executed
    pub executed: bool,

    /// Keeper that executed (if any)
    pub executed_by: Option<Pubkey>,

    /// Execution timestamp (if executed)
    pub executed_at: Option<i64>,

    /// Bump seed for PDA
    pub bump: u8,
}

impl KeeperIntent {
    pub const SEED: &'static [u8] = b"keeper_intent";

    /// Account discriminator (8) + owner (32) + encrypted_payload (512)
    /// + payload_length (2) + window_start (8) + window_end (8)
    /// + denomination (8) + keeper_fee (8) + executed (1)
    /// + executed_by (1 + 32) + executed_at (1 + 8) + bump (1)
    pub const SIZE: usize = 8 + 32 + 512 + 2 + 8 + 8 + 8 + 8 + 1 + 33 + 9 + 1;

    /// Minimum keeper fee: 0.001 SOL
    pub const MIN_KEEPER_FEE: u64 = 1_000_000;

    /// Maximum window duration: 7 days
    pub const MAX_WINDOW_DURATION: i64 = 604800;

    /// Check if keeper can execute this intent now
    pub fn can_execute(&self, current_timestamp: i64) -> bool {
        !self.executed
            && current_timestamp >= self.window_start
            && current_timestamp <= self.window_end
    }
}

/// Compute commitment hash for withdrawal
///
/// commitment = SHA256(domain || proof_hash || recipient || user_random || nonce)
pub fn compute_withdrawal_commitment(
    proof_hash: &[u8; 32],
    recipient: &Pubkey,
    user_random: &[u8; 32],
    nonce: u64,
) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hashv;

    let domain = b"stealthsol_withdrawal_commit_v1";
    let nonce_bytes = nonce.to_le_bytes();

    let hash = hashv(&[
        domain,
        proof_hash,
        recipient.as_ref(),
        user_random,
        &nonce_bytes,
    ]);

    hash.to_bytes()
}
