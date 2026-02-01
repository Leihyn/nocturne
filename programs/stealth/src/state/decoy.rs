//! Decoy System State
//!
//! Protocol-level decoy deposits that create fake activity to boost
//! the anonymity set. Observers cannot distinguish real users from decoys.
//!
//! ## How It Works
//!
//! 1. Users pay small fee (0.1%) on deposits to fund treasury
//! 2. Decoy bot deposits treasury funds to create fake activity
//! 3. Decoy bot withdraws funds back to treasury after random delay
//! 4. Net cost = only transaction fees (~0.001 SOL per decoy cycle)
//!
//! ## Security Properties
//!
//! - Decoys are fully isolated from user funds
//! - Decoys use valid ZK proofs (same as users)
//! - Cannot distinguish decoy from real user on-chain
//! - Protocol can continue even if decoy bot offline

use anchor_lang::prelude::*;

/// Decoy treasury configuration
#[account]
pub struct DecoyTreasury {
    /// Authority that can manage the treasury
    pub authority: Pubkey,

    /// Total SOL available for decoy operations
    pub balance: u64,

    /// Total collected from deposit fees
    pub total_collected: u64,

    /// Total spent on decoy transaction fees
    pub total_spent: u64,

    /// Number of active decoy wallets
    pub active_wallets: u32,

    /// Maximum decoy wallets allowed
    pub max_wallets: u32,

    /// Whether decoy system is active
    pub is_active: bool,

    /// Bump for PDA
    pub bump: u8,
}

impl DecoyTreasury {
    pub const SEED: &'static [u8] = b"decoy_treasury";
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 4 + 4 + 1 + 1;

    /// Default fee percentage (basis points): 10 = 0.1%
    pub const DEFAULT_FEE_BPS: u16 = 10;

    /// Maximum fee percentage: 100 = 1%
    pub const MAX_FEE_BPS: u16 = 100;
}

/// Configuration for decoy operations
#[account]
pub struct DecoyConfig {
    /// Authority that can update config
    pub authority: Pubkey,

    /// Fee percentage on deposits (basis points, 10 = 0.1%)
    pub fee_bps: u16,

    /// Minimum decoys per real deposit
    pub min_decoys_per_deposit: u8,

    /// Maximum decoys per real deposit
    pub max_decoys_per_deposit: u8,

    /// Minimum delay before decoy deposit (seconds)
    pub min_delay_seconds: u32,

    /// Maximum delay before decoy deposit (seconds)
    pub max_delay_seconds: u32,

    /// Minimum time to hold decoy in pool (seconds)
    pub min_hold_seconds: u32,

    /// Maximum time to hold decoy in pool (seconds)
    pub max_hold_seconds: u32,

    /// Whether to auto-generate decoys on deposits
    pub auto_decoy: bool,

    /// Bump for PDA
    pub bump: u8,
}

impl DecoyConfig {
    pub const SEED: &'static [u8] = b"decoy_config";
    pub const SIZE: usize = 8 + 32 + 2 + 1 + 1 + 4 + 4 + 4 + 4 + 1 + 1;

    /// Default minimum decoys
    pub const DEFAULT_MIN_DECOYS: u8 = 2;

    /// Default maximum decoys
    pub const DEFAULT_MAX_DECOYS: u8 = 5;

    /// Default minimum delay: 5 seconds
    pub const DEFAULT_MIN_DELAY: u32 = 5;

    /// Default maximum delay: 60 seconds
    pub const DEFAULT_MAX_DELAY: u32 = 60;

    /// Default minimum hold: 1 hour
    pub const DEFAULT_MIN_HOLD: u32 = 3600;

    /// Default maximum hold: 24 hours
    pub const DEFAULT_MAX_HOLD: u32 = 86400;
}

/// Registered decoy wallet
#[account]
pub struct DecoyWallet {
    /// The wallet public key
    pub wallet: Pubkey,

    /// When this wallet was registered
    pub registered_at: i64,

    /// Last time this wallet was used for decoy
    pub last_used: i64,

    /// Number of decoy operations performed
    pub operations_count: u64,

    /// Current balance in privacy pools
    pub in_pool_balance: u64,

    /// Which denomination pool funds are in (0 if none)
    pub current_denomination: u64,

    /// Whether wallet is currently active
    pub is_active: bool,

    /// Bump for PDA
    pub bump: u8,
}

impl DecoyWallet {
    pub const SEED: &'static [u8] = b"decoy_wallet";
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1;
}

/// Event emitted when decoy deposit is scheduled
#[event]
pub struct DecoyScheduled {
    /// Which denomination pool
    pub denomination: u64,

    /// Number of decoys to create
    pub count: u8,

    /// Earliest execution time
    pub earliest_time: i64,

    /// Latest execution time
    pub latest_time: i64,
}

/// Event emitted when decoy deposit is executed
#[event]
pub struct DecoyExecuted {
    /// Decoy wallet used
    pub wallet: Pubkey,

    /// Denomination
    pub denomination: u64,

    /// Whether deposit (true) or withdraw (false)
    pub is_deposit: bool,

    /// Timestamp
    pub timestamp: i64,
}
