//! Privacy Pool State
//!
//! The privacy pool holds all deposited funds and tracks commitments
//! in a Merkle tree. This enables private withdrawals using ZK proofs.
//!
//! FIXED DENOMINATION DESIGN:
//! Each pool has a fixed denomination (e.g., 1 SOL, 10 SOL, 100 SOL).
//! All deposits and withdrawals MUST be exactly this amount.
//! This hides the amount because everyone in the pool transacts the same amount.
//!
//! Uses zero-copy deserialization to avoid stack overflow in Solana BPF.

use anchor_lang::prelude::*;
use crate::crypto::merkle::MERKLE_DEPTH;

/// Historical roots count - reduced to fit in BPF stack
/// 30 roots allows ~30 blocks for proof generation (typical Solana latency)
pub const ROOT_HISTORY_SIZE: usize = 30;

/// Supported pool denominations (in lamports)
/// 1 SOL = 1_000_000_000 lamports
pub const DENOMINATION_0_1_SOL: u64 = 100_000_000;      // 0.1 SOL
pub const DENOMINATION_0_5_SOL: u64 = 500_000_000;      // 0.5 SOL
pub const DENOMINATION_1_SOL: u64 = 1_000_000_000;      // 1 SOL
pub const DENOMINATION_5_SOL: u64 = 5_000_000_000;      // 5 SOL
pub const DENOMINATION_10_SOL: u64 = 10_000_000_000;    // 10 SOL
pub const DENOMINATION_50_SOL: u64 = 50_000_000_000;    // 50 SOL
pub const DENOMINATION_100_SOL: u64 = 100_000_000_000;  // 100 SOL
pub const DENOMINATION_500_SOL: u64 = 500_000_000_000;  // 500 SOL
pub const DENOMINATION_1000_SOL: u64 = 1_000_000_000_000; // 1000 SOL

/// Default valid denominations array for validation
/// These are the standard denominations; additional ones can be enabled via DenominationRegistry
pub const DEFAULT_DENOMINATIONS: [u64; 9] = [
    DENOMINATION_0_1_SOL,
    DENOMINATION_0_5_SOL,
    DENOMINATION_1_SOL,
    DENOMINATION_5_SOL,
    DENOMINATION_10_SOL,
    DENOMINATION_50_SOL,
    DENOMINATION_100_SOL,
    DENOMINATION_500_SOL,
    DENOMINATION_1000_SOL,
];

/// Legacy alias for backwards compatibility
pub const VALID_DENOMINATIONS: [u64; 3] = [
    DENOMINATION_1_SOL,
    DENOMINATION_10_SOL,
    DENOMINATION_100_SOL,
];

/// Denomination Registry - allows dynamic configuration of allowed denominations
/// The authority can enable/disable specific denominations without redeploying
#[account]
pub struct DenominationRegistry {
    /// Authority that can modify the registry
    pub authority: Pubkey,
    /// Enabled denominations (up to 16)
    pub enabled_denominations: Vec<u64>,
    /// Whether custom denominations are allowed (beyond defaults)
    pub allow_custom: bool,
    /// Minimum allowed denomination (spam protection)
    pub min_denomination: u64,
    /// Maximum allowed denomination
    pub max_denomination: u64,
    /// Bump for PDA
    pub bump: u8,
}

impl DenominationRegistry {
    pub const SEED: &'static [u8] = b"denomination_registry";
    pub const MAX_DENOMINATIONS: usize = 16;
    pub const SIZE: usize = 8 + // discriminator
        32 + // authority
        4 + (8 * Self::MAX_DENOMINATIONS) + // enabled_denominations vec
        1 + // allow_custom
        8 + // min_denomination
        8 + // max_denomination
        1; // bump

    /// Check if a denomination is enabled in the registry
    pub fn is_enabled(&self, denomination: u64) -> bool {
        self.enabled_denominations.contains(&denomination)
    }
}

/// Privacy pool account - holds deposited funds and Merkle tree state
/// Uses zero-copy for efficient memory access without stack allocation.
/// Uses reduced root_history to fit within BPF stack limits (4096 bytes)
///
/// FIXED DENOMINATION: Each pool has a fixed amount (1, 10, or 100 SOL).
/// This ensures all deposits/withdrawals are identical, hiding amounts.
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct PrivacyPool {
    /// Authority that can update pool parameters
    pub authority: Pubkey,

    /// Fixed denomination for this pool (in lamports)
    /// All deposits and withdrawals MUST be exactly this amount
    pub denomination: u64,

    /// Current Merkle root
    pub merkle_root: [u8; 32],

    /// Next leaf index in the Merkle tree
    pub next_leaf_index: u64,

    /// Filled subtrees for incremental Merkle tree
    pub filled_subtrees: [[u8; 32]; MERKLE_DEPTH],

    /// Total amount deposited (in lamports)
    pub total_deposited: u64,

    /// Total amount withdrawn
    pub total_withdrawn: u64,

    /// Number of deposits
    pub deposit_count: u64,

    /// Number of withdrawals
    pub withdrawal_count: u64,

    /// Whether the pool is active
    pub is_active: bool,

    /// Historical Merkle roots (for async proof generation)
    /// Keeps last ROOT_HISTORY_SIZE roots (reduced from 100 for BPF stack limits)
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_history_index: u8,

    /// Bump for PDA
    pub bump: u8,
}

impl PrivacyPool {
    pub const SEED: &'static [u8] = b"privacy_pool";

    /// Size calculation for account allocation
    /// Total: ~1738 bytes with MERKLE_DEPTH=10, ROOT_HISTORY_SIZE=30
    pub const SIZE: usize = 8 + // discriminator
        32 + // authority
        8 + // denomination (NEW)
        32 + // merkle_root
        8 + // next_leaf_index
        (32 * MERKLE_DEPTH) + // filled_subtrees (10 * 32 = 320)
        8 + // total_deposited
        8 + // total_withdrawn
        8 + // deposit_count
        8 + // withdrawal_count
        1 + // is_active
        (32 * ROOT_HISTORY_SIZE) + // root_history (30 * 32 = 960)
        1 + // root_history_index
        1; // bump

    /// Check if a denomination is valid (uses expanded default list)
    /// For dynamic configuration, use DenominationRegistry.is_enabled()
    pub fn is_valid_denomination(denomination: u64) -> bool {
        DEFAULT_DENOMINATIONS.contains(&denomination)
    }

    /// Check if a denomination is valid with optional registry override
    /// If registry is provided, uses its configuration; otherwise falls back to defaults
    pub fn is_valid_denomination_with_registry(
        denomination: u64,
        registry: Option<&DenominationRegistry>,
    ) -> bool {
        match registry {
            Some(reg) => {
                // Check if within bounds
                if denomination < reg.min_denomination || denomination > reg.max_denomination {
                    return false;
                }
                // Check if explicitly enabled or if custom allowed
                if reg.is_enabled(denomination) {
                    return true;
                }
                // If custom allowed, accept any denomination within bounds
                if reg.allow_custom {
                    return true;
                }
                // Fall back to default check
                DEFAULT_DENOMINATIONS.contains(&denomination)
            }
            None => DEFAULT_DENOMINATIONS.contains(&denomination),
        }
    }

    /// Check if a Merkle root is valid (current or in history)
    #[inline(never)]
    pub fn is_valid_root(&self, root: &[u8; 32]) -> bool {
        // Check current root
        if self.merkle_root == *root {
            return true;
        }

        // Check historical roots
        for historical in self.root_history.iter() {
            if *historical == *root && *historical != [0u8; 32] {
                return true;
            }
        }

        false
    }

    /// Save current root to history before updating
    #[inline(never)]
    pub fn save_root_to_history(&mut self) {
        self.root_history[self.root_history_index as usize] = self.merkle_root;
        self.root_history_index = (self.root_history_index + 1) % (ROOT_HISTORY_SIZE as u8);
    }
}

/// Nullifier record - tracks spent notes to prevent double-spending
#[account]
pub struct NullifierRecord {
    /// The nullifier hash
    pub nullifier_hash: [u8; 32],

    /// Timestamp when spent
    pub spent_at: i64,

    /// Bump for PDA
    pub bump: u8,
}

impl NullifierRecord {
    pub const SEED: &'static [u8] = b"nullifier";
    pub const SIZE: usize = 8 + 32 + 8 + 1;
}

/// Commitment leaf record - stores commitment with metadata
#[account]
pub struct CommitmentLeaf {
    /// The commitment hash (Poseidon hash of nullifier, secret, amount, recipient)
    pub commitment: [u8; 32],

    /// Index in the Merkle tree
    pub leaf_index: u64,

    /// Timestamp when deposited
    pub timestamp: i64,

    /// Optional encrypted note for recipient
    /// Format: [nonce(24)] || [ciphertext(variable)]
    pub encrypted_note: [u8; 128],

    /// Pedersen commitment to the amount: C = amount*G + blinding*H
    /// This hides the actual amount while allowing verification
    pub amount_commitment: [u8; 33],

    /// Range proof showing 0 <= amount < 2^64 (compressed)
    /// Verified via oracle attestation
    pub range_proof_hash: [u8; 32],

    /// Bump for PDA
    pub bump: u8,
}

impl CommitmentLeaf {
    pub const SEED: &'static [u8] = b"commitment";
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 128 + 33 + 32 + 1;
}

/// Confidential balance account (for ShadowWire integration)
#[account]
pub struct ConfidentialBalance {
    /// Owner of this balance
    pub owner: Pubkey,

    /// Pedersen commitment to the balance: C = balance·G + blinding·H
    pub balance_commitment: [u8; 32],

    /// Encrypted balance (only owner can decrypt)
    pub encrypted_balance: [u8; 64],

    /// Last update timestamp
    pub last_update: i64,

    /// Bump for PDA
    pub bump: u8,
}

impl ConfidentialBalance {
    pub const SEED: &'static [u8] = b"confidential_balance";
    pub const SIZE: usize = 8 + 32 + 32 + 64 + 8 + 1;
}

/// Pool configuration
#[account]
pub struct PoolConfig {
    /// Authority that can update config
    pub authority: Pubkey,

    /// Minimum deposit amount (in lamports)
    pub min_deposit: u64,

    /// Maximum deposit amount
    pub max_deposit: u64,

    /// Fee percentage (basis points, e.g., 30 = 0.3%)
    pub fee_bps: u16,

    /// Fee recipient
    pub fee_recipient: Pubkey,

    /// Whether deposits are paused
    pub deposits_paused: bool,

    /// Whether withdrawals are paused
    pub withdrawals_paused: bool,

    /// Bump for PDA
    pub bump: u8,
}

impl PoolConfig {
    pub const SEED: &'static [u8] = b"pool_config";
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 2 + 32 + 1 + 1 + 1;

    /// Default minimum deposit (0.001 SOL)
    pub const DEFAULT_MIN_DEPOSIT: u64 = 1_000_000;

    /// Default maximum deposit (1000 SOL)
    pub const DEFAULT_MAX_DEPOSIT: u64 = 1_000_000_000_000;

    /// Default fee (0.1%)
    pub const DEFAULT_FEE_BPS: u16 = 10;
}
