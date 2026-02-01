//! Fee Relayer State
//!
//! Enables sender privacy by allowing third parties to pay transaction fees.
//!
//! ## How It Works
//!
//! WITHOUT RELAYER:
//! Alice (visible) ──► signs tx ──► pays fee ──► sends to stealth
//! Observer: "Alice sent something"
//!
//! WITH RELAYER:
//! Alice ──► signs tx ──► Relayer pays fee ──► sends to stealth
//! Observer: "Relayer sent something" (Alice hidden!)
//!
//! ## Fee Model
//!
//! 1. User creates withdrawal tx but can't pay fees (no SOL in stealth addr)
//! 2. User signs the inner transaction
//! 3. Relayer wraps and submits, paying network fees
//! 4. Relayer fee is deducted from withdrawal amount
//! 5. User receives: withdrawal - relayer_fee - network_fee

use anchor_lang::prelude::*;

/// Registered relayer
#[account]
pub struct Relayer {
    /// Relayer's public key (pays fees, receives payment)
    pub pubkey: Pubkey,

    /// Operator who controls this relayer
    pub operator: Pubkey,

    /// Fee percentage (basis points, e.g., 50 = 0.5%)
    pub fee_bps: u16,

    /// Minimum fee in lamports
    pub min_fee: u64,

    /// Maximum fee in lamports (0 = no max)
    pub max_fee: u64,

    /// Total transactions relayed
    pub tx_count: u64,

    /// Total fees earned
    pub total_earned: u64,

    /// Whether relayer is active
    pub is_active: bool,

    /// Supported denominations (bitmask)
    /// bit 0: 1 SOL, bit 1: 10 SOL, bit 2: 100 SOL
    pub supported_denominations: u8,

    /// Reputation score (0-100)
    pub reputation: u8,

    /// Registration timestamp
    pub registered_at: i64,

    /// Last activity timestamp
    pub last_active: i64,

    /// Bump for PDA
    pub bump: u8,
}

impl Relayer {
    pub const SEED: &'static [u8] = b"relayer";

    /// 8 + 32 + 32 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 8 + 1 = 126
    pub const SIZE: usize = 8 + 32 + 32 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 8 + 1;

    /// Maximum fee: 5%
    pub const MAX_FEE_BPS: u16 = 500;

    /// Default fee: 0.5%
    pub const DEFAULT_FEE_BPS: u16 = 50;

    /// Minimum reputation to be listed
    pub const MIN_REPUTATION: u8 = 10;

    /// Check if relayer supports a denomination
    pub fn supports_denomination(&self, denomination: u64) -> bool {
        let bit = match denomination {
            1_000_000_000 => 0,      // 1 SOL
            10_000_000_000 => 1,     // 10 SOL
            100_000_000_000 => 2,    // 100 SOL
            _ => return false,
        };
        (self.supported_denominations & (1 << bit)) != 0
    }

    /// Calculate fee for a given amount
    pub fn calculate_fee(&self, amount: u64) -> u64 {
        let percentage_fee = (amount as u128 * self.fee_bps as u128 / 10000) as u64;
        let fee = percentage_fee.max(self.min_fee);

        if self.max_fee > 0 {
            fee.min(self.max_fee)
        } else {
            fee
        }
    }
}

/// Global relayer registry configuration
#[account]
pub struct RelayerRegistry {
    /// Authority that can manage registry
    pub authority: Pubkey,

    /// Total registered relayers
    pub relayer_count: u32,

    /// Active relayers
    pub active_count: u32,

    /// Total transactions through relayers
    pub total_transactions: u64,

    /// Total fees paid to relayers
    pub total_fees_paid: u64,

    /// Minimum stake required to register as relayer
    pub min_stake: u64,

    /// Whether new registrations are open
    pub registrations_open: bool,

    /// Bump for PDA
    pub bump: u8,
}

impl RelayerRegistry {
    pub const SEED: &'static [u8] = b"relayer_registry";
    pub const SIZE: usize = 8 + 32 + 4 + 4 + 8 + 8 + 8 + 1 + 1;

    /// Default minimum stake: 1 SOL
    pub const DEFAULT_MIN_STAKE: u64 = 1_000_000_000;
}

/// Relayer stake account (slashable for misbehavior)
#[account]
pub struct RelayerStake {
    /// Relayer this stake belongs to
    pub relayer: Pubkey,

    /// Amount staked
    pub amount: u64,

    /// When stake was deposited
    pub staked_at: i64,

    /// Pending slash amount (if any)
    pub pending_slash: u64,

    /// Bump for PDA
    pub bump: u8,
}

impl RelayerStake {
    pub const SEED: &'static [u8] = b"relayer_stake";
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1;
}

/// Pending relayed transaction
/// Used for async relay operations
#[account]
pub struct PendingRelay {
    /// User who requested the relay
    pub user: Pubkey,

    /// Relayer handling this request
    pub relayer: Pubkey,

    /// Hash of the transaction to be relayed
    pub tx_hash: [u8; 32],

    /// Fee agreed upon
    pub fee: u64,

    /// Denomination of withdrawal
    pub denomination: u64,

    /// Request timestamp
    pub requested_at: i64,

    /// Expiry timestamp
    pub expires_at: i64,

    /// Whether completed
    pub completed: bool,

    /// Bump for PDA
    pub bump: u8,
}

impl PendingRelay {
    pub const SEED: &'static [u8] = b"pending_relay";
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;

    /// Default expiry: 5 minutes
    pub const DEFAULT_EXPIRY_SECONDS: i64 = 300;
}

/// Event emitted when a relayed transaction completes
#[event]
pub struct RelayCompleted {
    /// Relayer that handled the transaction
    pub relayer: Pubkey,

    /// Fee paid to relayer
    pub fee: u64,

    /// Denomination
    pub denomination: u64,

    /// Timestamp
    pub timestamp: i64,
}

/// Event emitted when relayer is slashed
#[event]
pub struct RelayerSlashed {
    /// Relayer that was slashed
    pub relayer: Pubkey,

    /// Amount slashed
    pub amount: u64,

    /// Reason code
    pub reason: u8,

    /// Timestamp
    pub timestamp: i64,
}
