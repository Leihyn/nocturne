use anchor_lang::prelude::*;
use crate::state::StealthRegistry;
use crate::crypto::validate_curve_point;
use crate::error::StealthError;

/// Accounts for the register instruction
#[derive(Accounts)]
pub struct Register<'info> {
    /// The wallet owner registering their stealth meta-address
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The registry PDA that will store the meta-address
    #[account(
        init,
        payer = owner,
        space = StealthRegistry::SIZE,
        seeds = [StealthRegistry::SEED, owner.key().as_ref()],
        bump,
    )]
    pub registry: Account<'info, StealthRegistry>,

    /// System program for account creation
    pub system_program: Program<'info, System>,
}

/// Register a stealth meta-address on-chain
///
/// This allows others to lookup your meta-address and send you private payments.
/// The meta-address consists of:
/// - Scan public key (S): Shared with senders, used to derive payment addresses
/// - Spend public key (B): Combined with shared secret for address derivation
///
/// # Arguments
/// * `scan_pubkey` - Your scan public key (32 bytes, compressed Edwards Y)
/// * `spend_pubkey` - Your spend public key (32 bytes, compressed Edwards Y)
/// * `label` - Optional human-readable label (32 bytes, zero-padded)
pub fn register(
    ctx: Context<Register>,
    scan_pubkey: [u8; 32],
    spend_pubkey: [u8; 32],
    label: [u8; 32],
) -> Result<()> {
    // Validate scan public key is a valid curve point
    require!(
        validate_curve_point(&scan_pubkey),
        StealthError::InvalidScanPubkey
    );

    // Validate spend public key is a valid curve point
    require!(
        validate_curve_point(&spend_pubkey),
        StealthError::InvalidSpendPubkey
    );

    let registry = &mut ctx.accounts.registry;
    let clock = Clock::get()?;

    registry.owner = ctx.accounts.owner.key();
    registry.scan_pubkey = scan_pubkey;
    registry.spend_pubkey = spend_pubkey;
    registry.label = label;
    registry.created_at = clock.unix_timestamp;
    registry.bump = ctx.bumps.registry;

    msg!(
        "Stealth meta-address registered for {}",
        ctx.accounts.owner.key()
    );

    Ok(())
}

/// Accounts for updating a registry
#[derive(Accounts)]
pub struct UpdateRegistry<'info> {
    /// The wallet owner (must match registry owner)
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The registry PDA to update
    #[account(
        mut,
        seeds = [StealthRegistry::SEED, owner.key().as_ref()],
        bump = registry.bump,
        has_one = owner,
    )]
    pub registry: Account<'info, StealthRegistry>,
}

/// Update a stealth meta-address
///
/// Allows rotating keys while maintaining the same registry PDA
pub fn update_registry(
    ctx: Context<UpdateRegistry>,
    scan_pubkey: [u8; 32],
    spend_pubkey: [u8; 32],
    label: [u8; 32],
) -> Result<()> {
    require!(
        validate_curve_point(&scan_pubkey),
        StealthError::InvalidScanPubkey
    );
    require!(
        validate_curve_point(&spend_pubkey),
        StealthError::InvalidSpendPubkey
    );

    let registry = &mut ctx.accounts.registry;
    registry.scan_pubkey = scan_pubkey;
    registry.spend_pubkey = spend_pubkey;
    registry.label = label;

    msg!("Stealth meta-address updated for {}", ctx.accounts.owner.key());

    Ok(())
}
