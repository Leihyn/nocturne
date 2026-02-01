//! Compressed Announcement Log
//!
//! Instead of creating a new account for each stealth payment announcement,
//! this log stores multiple announcements in a single account.
//!
//! ## Privacy Benefits
//!
//! - All stealth sends write to the SAME log account
//! - Harder to correlate which transfer created which announcement
//! - More cost-efficient (amortized account rent)
//!
//! ## Structure
//!
//! Each announcement entry is 105 bytes:
//! - ephemeral_pubkey: 32 bytes
//! - stealth_address: 32 bytes
//! - commitment: 32 bytes
//! - slot: 8 bytes
//! - amount_hint: 1 byte (denomination bucket, not exact amount)
//!
//! A 10KB account can store ~95 entries before rotation.

use anchor_lang::prelude::*;

/// Single entry in the announcement log
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AnnouncementEntry {
    /// Ephemeral public key (R = r·G) published by sender
    pub ephemeral_pubkey: [u8; 32],

    /// The derived stealth address that received the payment
    pub stealth_address: Pubkey,

    /// Commitment hash proving correct derivation
    pub commitment: [u8; 32],

    /// Block slot when payment was made
    pub slot: u64,

    /// Amount hint (denomination bucket):
    /// 0 = unknown/hidden
    /// 1 = micro (<0.1 SOL)
    /// 2 = small (0.1-1 SOL)
    /// 3 = medium (1-10 SOL)
    /// 4 = large (10-100 SOL)
    /// 5 = xlarge (>100 SOL)
    pub amount_hint: u8,
}

impl AnnouncementEntry {
    /// Size of a single entry: 32 + 32 + 32 + 8 + 1 = 105 bytes
    pub const SIZE: usize = 32 + 32 + 32 + 8 + 1;

    /// Create amount hint from lamports
    #[allow(clippy::manual_range_patterns)]
    pub fn amount_to_hint(lamports: u64) -> u8 {
        match lamports {
            0..=99_999_999 => 1,                    // < 0.1 SOL
            100_000_000..=999_999_999 => 2,         // 0.1 - 1 SOL
            1_000_000_000..=9_999_999_999 => 3,     // 1 - 10 SOL
            10_000_000_000..=99_999_999_999 => 4,   // 10 - 100 SOL
            _ => 5,                                  // > 100 SOL
        }
    }
}

/// Compressed announcement log storing multiple entries
#[account]
pub struct AnnouncementLog {
    /// Authority that can manage this log
    pub authority: Pubkey,

    /// Sequential log ID (for creating multiple logs)
    pub log_id: u64,

    /// Number of entries currently in the log
    pub entry_count: u32,

    /// Maximum entries this log can hold
    pub max_entries: u32,

    /// Whether new entries can be added
    pub is_active: bool,

    /// Slot when this log was created
    pub created_slot: u64,

    /// Slot of the most recent entry
    pub last_entry_slot: u64,

    /// Bump seed for PDA
    pub bump: u8,

    /// The actual announcement entries (variable length)
    pub entries: Vec<AnnouncementEntry>,
}

impl AnnouncementLog {
    pub const SEED: &'static [u8] = b"announcement_log";

    /// Fixed header size before entries vector:
    /// discriminator (8) + authority (32) + log_id (8) + entry_count (4)
    /// + max_entries (4) + is_active (1) + created_slot (8)
    /// + last_entry_slot (8) + bump (1) + vec_len (4)
    pub const HEADER_SIZE: usize = 8 + 32 + 8 + 4 + 4 + 1 + 8 + 8 + 1 + 4;

    /// Calculate space needed for a log with N entries
    pub fn space(max_entries: u32) -> usize {
        Self::HEADER_SIZE + (max_entries as usize * AnnouncementEntry::SIZE)
    }

    /// Default max entries for a 10KB account
    /// (10240 - HEADER_SIZE) / ENTRY_SIZE ≈ 95 entries
    pub const DEFAULT_MAX_ENTRIES: u32 = 95;

    /// Check if log can accept more entries
    pub fn can_add_entry(&self) -> bool {
        self.is_active && self.entry_count < self.max_entries
    }

    /// Check if log is full
    pub fn is_full(&self) -> bool {
        self.entry_count >= self.max_entries
    }
}

/// Global log registry tracking all announcement logs
#[account]
pub struct LogRegistry {
    /// Authority that can create new logs
    pub authority: Pubkey,

    /// Current active log ID (the one accepting new entries)
    pub current_log_id: u64,

    /// Total number of logs created
    pub total_logs: u64,

    /// Total announcements across all logs
    pub total_announcements: u64,

    /// Bump seed for PDA
    pub bump: u8,
}

impl LogRegistry {
    pub const SEED: &'static [u8] = b"log_registry";

    /// discriminator (8) + authority (32) + current_log_id (8)
    /// + total_logs (8) + total_announcements (8) + bump (1)
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1;
}

/// Event emitted for each stealth payment
/// Recipients can scan events instead of reading accounts
#[event]
pub struct StealthPaymentEvent {
    /// Ephemeral public key for this payment
    pub ephemeral_pubkey: [u8; 32],

    /// The stealth address receiving funds
    pub stealth_address: Pubkey,

    /// Commitment hash
    pub commitment: [u8; 32],

    /// Block slot
    pub slot: u64,

    /// Amount hint (denomination bucket)
    pub amount_hint: u8,

    /// Log ID where this was recorded (if using compressed logs)
    pub log_id: Option<u64>,
}

/// Event for blended transfers (looks like regular transfer event)
#[event]
pub struct TransferEvent {
    /// Generic "from" field
    pub from: Pubkey,

    /// Generic "to" field (stealth address)
    pub to: Pubkey,

    /// Amount in lamports
    pub amount: u64,

    /// Memo field (contains encrypted announcement data)
    /// Format: ephemeral_pubkey (32) || commitment (32) = 64 bytes
    pub memo: [u8; 64],
}
