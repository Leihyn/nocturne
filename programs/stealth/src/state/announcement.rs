use anchor_lang::prelude::*;

/// Announcement record for a stealth payment
///
/// When a sender makes a stealth payment, they publish an announcement
/// containing the ephemeral public key (R). Recipients scan these
/// announcements to detect payments addressed to them.
///
/// Security: Includes a commitment hash to verify the stealth address
/// was correctly derived, preventing sender cheating.
#[account]
#[derive(Default)]
pub struct StealthAnnouncement {
    /// Ephemeral public key (R = r·G) published by sender
    /// Recipients use this with their scan key to detect payments
    pub ephemeral_pubkey: [u8; 32],

    /// The derived stealth address that received the payment
    pub stealth_address: Pubkey,

    /// Commitment: SHA256(ephemeral_pubkey || scan_pubkey || spend_pubkey || stealth_address)
    /// This proves the sender correctly derived the stealth address
    pub commitment: [u8; 32],

    /// Amount sent in lamports (for SOL) or base units (for tokens)
    pub amount: u64,

    /// Token mint (Pubkey::default() for native SOL)
    pub token_mint: Pubkey,

    /// Block slot when the payment was made
    pub slot: u64,

    /// Unix timestamp of the payment
    pub timestamp: i64,

    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl StealthAnnouncement {
    pub const SEED: &'static [u8] = b"announcement";

    /// Account discriminator (8) + ephemeral_pubkey (32) + stealth_address (32)
    /// + commitment (32) + amount (8) + token_mint (32) + slot (8) + timestamp (8) + bump (1)
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 32 + 8 + 8 + 1;
}

/// Compute the commitment hash for verification
/// commitment = SHA256(domain || ephemeral_pubkey || scan_pubkey || spend_pubkey || stealth_address)
pub fn compute_commitment(
    ephemeral_pubkey: &[u8; 32],
    scan_pubkey: &[u8; 32],
    spend_pubkey: &[u8; 32],
    stealth_address: &[u8; 32],
) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hashv;

    let domain = b"stealthsol_commitment_v1";
    let hash = hashv(&[
        domain,
        ephemeral_pubkey,
        scan_pubkey,
        spend_pubkey,
        stealth_address,
    ]);

    hash.to_bytes()
}
