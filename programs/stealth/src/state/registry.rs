use anchor_lang::prelude::*;

/// Registry entry for a user's stealth meta-address
///
/// A meta-address consists of two public keys:
/// - Scan public key (S): Used to detect incoming payments
/// - Spend public key (B): Used to derive the spending key
///
/// Anyone can lookup a user's meta-address to send them private payments
///
/// ## View Key System
///
/// Optional view key support allows selective transparency:
/// - Individuals: Keep view_key disabled for full privacy
/// - Institutions: Enable view_key for auditor/regulator access
/// - The view_key allows scanning payments but NOT spending them
#[account]
#[derive(Default)]
pub struct StealthRegistry {
    /// Owner's main wallet (for reference/updates)
    pub owner: Pubkey,

    /// Scan public key (S = s·G) - compressed Edwards Y coordinate
    pub scan_pubkey: [u8; 32],

    /// Spend public key (B = b·G) - compressed Edwards Y coordinate
    pub spend_pubkey: [u8; 32],

    /// Human-readable label (optional, zero-padded)
    pub label: [u8; 32],

    /// Creation timestamp (Unix timestamp)
    pub created_at: i64,

    // ==========================================
    // VIEW KEY SYSTEM (Compliance/Audit Support)
    // ==========================================

    /// View key for read-only access (derived from scan key)
    /// Allows holder to detect payments but NOT spend them
    /// Set to [0u8; 32] if not set
    pub view_key: [u8; 32],

    /// Whether view key is currently enabled
    /// Owner can toggle on/off at any time
    pub view_key_enabled: bool,

    /// Authorized view key holder (e.g., auditor's pubkey)
    /// Only this address can use the view key
    /// Set to Pubkey::default() if not set
    pub view_key_holder: Pubkey,

    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl StealthRegistry {
    pub const SEED: &'static [u8] = b"stealth_registry";

    /// Account discriminator (8) + owner (32) + scan_pubkey (32) + spend_pubkey (32)
    /// + label (32) + created_at (8) + view_key (32) + view_key_enabled (1)
    /// + view_key_holder (32) + bump (1)
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 32 + 1 + 32 + 1;

    /// Returns the meta-address as a tuple (scan_pubkey, spend_pubkey)
    pub fn meta_address(&self) -> ([u8; 32], [u8; 32]) {
        (self.scan_pubkey, self.spend_pubkey)
    }

    /// Check if view key is set and enabled
    pub fn has_active_view_key(&self) -> bool {
        self.view_key_enabled && self.view_key != [0u8; 32]
    }

    /// Check if a given pubkey is the authorized view key holder
    pub fn is_authorized_viewer(&self, viewer: &Pubkey) -> bool {
        self.has_active_view_key() && self.view_key_holder == *viewer
    }
}
