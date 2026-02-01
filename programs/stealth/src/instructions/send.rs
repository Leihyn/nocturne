use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{StealthRegistry, StealthAnnouncement, compute_commitment};
use crate::crypto::validate_curve_point;
use crate::error::{StealthError, MIN_PAYMENT_LAMPORTS};

/// Accounts for sending SOL to a stealth address via registry lookup
#[derive(Accounts)]
#[instruction(ephemeral_pubkey: [u8; 32], commitment: [u8; 32], amount: u64)]
pub struct StealthSend<'info> {
    /// The sender paying for the transaction
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The recipient's registered stealth meta-address
    pub recipient_registry: Account<'info, StealthRegistry>,

    /// The derived stealth address receiving the payment
    /// CHECK: Validated via commitment hash
    #[account(mut)]
    pub stealth_address: SystemAccount<'info>,

    /// Announcement account storing the ephemeral key for scanning
    #[account(
        init,
        payer = sender,
        space = StealthAnnouncement::SIZE,
        seeds = [StealthAnnouncement::SEED, ephemeral_pubkey.as_ref()],
        bump,
    )]
    pub announcement: Account<'info, StealthAnnouncement>,

    /// System program for transfers
    pub system_program: Program<'info, System>,
}

/// Send SOL to a stealth address via registry lookup
///
/// Security improvements:
/// 1. Verifies commitment hash matches the provided stealth address
/// 2. Enforces minimum payment amount to prevent spam
///
/// # Arguments
/// * `ephemeral_pubkey` - The ephemeral public key R (for recipient to scan)
/// * `commitment` - SHA256(domain || R || S || B || P) for verification
/// * `amount` - Amount of lamports to send
pub fn stealth_send(
    ctx: Context<StealthSend>,
    ephemeral_pubkey: [u8; 32],
    commitment: [u8; 32],
    amount: u64,
) -> Result<()> {
    // Validate ephemeral key is a valid curve point
    require!(
        validate_curve_point(&ephemeral_pubkey),
        StealthError::InvalidEphemeralKey
    );

    // Enforce minimum payment amount (spam prevention)
    require!(
        amount >= MIN_PAYMENT_LAMPORTS,
        StealthError::PaymentTooSmall
    );

    // Get meta-address from registry
    let registry = &ctx.accounts.recipient_registry;
    let scan_pubkey = registry.scan_pubkey;
    let spend_pubkey = registry.spend_pubkey;

    // Verify commitment matches
    let stealth_address_bytes = ctx.accounts.stealth_address.key().to_bytes();
    let expected_commitment = compute_commitment(
        &ephemeral_pubkey,
        &scan_pubkey,
        &spend_pubkey,
        &stealth_address_bytes,
    );

    require!(
        commitment == expected_commitment,
        StealthError::CommitmentMismatch
    );

    // Transfer SOL to stealth address
    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.sender.to_account_info(),
            to: ctx.accounts.stealth_address.to_account_info(),
        },
    );
    system_program::transfer(transfer_ctx, amount)?;

    // Record announcement for scanning
    let clock = Clock::get()?;
    let announcement = &mut ctx.accounts.announcement;

    announcement.ephemeral_pubkey = ephemeral_pubkey;
    announcement.stealth_address = ctx.accounts.stealth_address.key();
    announcement.commitment = commitment;
    announcement.amount = amount;
    announcement.token_mint = Pubkey::default(); // Native SOL
    announcement.slot = clock.slot;
    announcement.timestamp = clock.unix_timestamp;
    announcement.bump = ctx.bumps.announcement;

    msg!(
        "Stealth payment: {} lamports to {} (verified)",
        amount,
        ctx.accounts.stealth_address.key()
    );

    Ok(())
}

/// Accounts for sending SOL directly to a meta-address (without registry lookup)
#[derive(Accounts)]
#[instruction(
    scan_pubkey: [u8; 32],
    spend_pubkey: [u8; 32],
    ephemeral_pubkey: [u8; 32],
    commitment: [u8; 32],
    amount: u64
)]
pub struct StealthSendDirect<'info> {
    /// The sender paying for the transaction
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The derived stealth address receiving the payment
    /// CHECK: Validated via commitment hash
    #[account(mut)]
    pub stealth_address: SystemAccount<'info>,

    /// Announcement account storing the ephemeral key for scanning
    #[account(
        init,
        payer = sender,
        space = StealthAnnouncement::SIZE,
        seeds = [StealthAnnouncement::SEED, ephemeral_pubkey.as_ref()],
        bump,
    )]
    pub announcement: Account<'info, StealthAnnouncement>,

    /// System program for transfers
    pub system_program: Program<'info, System>,
}

/// Send SOL directly using a meta-address (no registry lookup required)
///
/// Security improvements:
/// 1. Verifies commitment hash matches the provided stealth address
/// 2. Enforces minimum payment amount to prevent spam
///
/// # Arguments
/// * `scan_pubkey` - Recipient's scan public key
/// * `spend_pubkey` - Recipient's spend public key
/// * `ephemeral_pubkey` - The ephemeral public key R
/// * `commitment` - SHA256(domain || R || S || B || P) for verification
/// * `amount` - Amount of lamports to send
pub fn stealth_send_direct(
    ctx: Context<StealthSendDirect>,
    scan_pubkey: [u8; 32],
    spend_pubkey: [u8; 32],
    ephemeral_pubkey: [u8; 32],
    commitment: [u8; 32],
    amount: u64,
) -> Result<()> {
    // Validate all public keys
    require!(
        validate_curve_point(&scan_pubkey),
        StealthError::InvalidScanPubkey
    );
    require!(
        validate_curve_point(&spend_pubkey),
        StealthError::InvalidSpendPubkey
    );
    require!(
        validate_curve_point(&ephemeral_pubkey),
        StealthError::InvalidEphemeralKey
    );

    // Enforce minimum payment amount (spam prevention)
    require!(
        amount >= MIN_PAYMENT_LAMPORTS,
        StealthError::PaymentTooSmall
    );

    // Verify commitment matches
    let stealth_address_bytes = ctx.accounts.stealth_address.key().to_bytes();
    let expected_commitment = compute_commitment(
        &ephemeral_pubkey,
        &scan_pubkey,
        &spend_pubkey,
        &stealth_address_bytes,
    );

    require!(
        commitment == expected_commitment,
        StealthError::CommitmentMismatch
    );

    // Transfer SOL to stealth address
    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.sender.to_account_info(),
            to: ctx.accounts.stealth_address.to_account_info(),
        },
    );
    system_program::transfer(transfer_ctx, amount)?;

    // Record announcement
    let clock = Clock::get()?;
    let announcement = &mut ctx.accounts.announcement;

    announcement.ephemeral_pubkey = ephemeral_pubkey;
    announcement.stealth_address = ctx.accounts.stealth_address.key();
    announcement.commitment = commitment;
    announcement.amount = amount;
    announcement.token_mint = Pubkey::default();
    announcement.slot = clock.slot;
    announcement.timestamp = clock.unix_timestamp;
    announcement.bump = ctx.bumps.announcement;

    msg!(
        "Direct stealth payment: {} lamports to {} (verified)",
        amount,
        ctx.accounts.stealth_address.key()
    );

    Ok(())
}
