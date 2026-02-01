//! View Key Management Instructions
//!
//! Allows users to manage view keys for optional transparency/compliance.
//!
//! ## Use Cases
//!
//! - Institutions sharing with auditors
//! - Exchanges providing regulatory access
//! - Individuals keeping full privacy (no view key)
//!
//! ## Security
//!
//! - Only registry owner can manage view keys
//! - View key holder can scan but NOT spend
//! - Can be toggled on/off at any time
//! - Can be revoked completely

use anchor_lang::prelude::*;
use crate::state::StealthRegistry;
use crate::error::StealthError;

/// Set or update view key for a registry
#[derive(Accounts)]
pub struct SetViewKey<'info> {
    /// Registry owner
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The registry to update
    #[account(
        mut,
        seeds = [StealthRegistry::SEED, owner.key().as_ref()],
        bump = registry.bump,
        constraint = registry.owner == owner.key() @ StealthError::Unauthorized,
    )]
    pub registry: Account<'info, StealthRegistry>,
}

/// Set a new view key and holder
///
/// The view key allows the holder to scan for payments but not spend.
/// This is useful for:
/// - Auditor access (compliance)
/// - Accountant access (bookkeeping)
/// - Regulatory requirements
pub fn set_view_key(
    ctx: Context<SetViewKey>,
    view_key: [u8; 32],
    holder: Pubkey,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    // Validate view key is not all zeros (that would be "not set")
    require!(
        view_key != [0u8; 32],
        StealthError::InvalidViewKey
    );

    // Validate holder is not default pubkey
    require!(
        holder != Pubkey::default(),
        StealthError::InvalidViewKeyHolder
    );

    registry.view_key = view_key;
    registry.view_key_holder = holder;
    registry.view_key_enabled = true;

    msg!("View key set for holder: {}", holder);

    Ok(())
}

/// Toggle view key on/off
///
/// Allows temporarily disabling view key access without deleting it.
/// Useful for:
/// - Pausing auditor access during sensitive operations
/// - Temporary privacy needs
/// - Quick on/off without regenerating keys
pub fn toggle_view_key(
    ctx: Context<SetViewKey>,
    enabled: bool,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    // Can only toggle if view key exists
    require!(
        registry.view_key != [0u8; 32],
        StealthError::ViewKeyNotSet
    );

    registry.view_key_enabled = enabled;

    msg!("View key {}", if enabled { "enabled" } else { "disabled" });

    Ok(())
}

/// Revoke view key completely
///
/// Removes the view key and holder entirely.
/// After this, no one can use view key access until a new one is set.
pub fn revoke_view_key(ctx: Context<SetViewKey>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    registry.view_key = [0u8; 32];
    registry.view_key_holder = Pubkey::default();
    registry.view_key_enabled = false;

    msg!("View key revoked");

    Ok(())
}

/// Rotate view key to a new holder
///
/// Changes both the view key and holder in one operation.
/// The old holder immediately loses access.
pub fn rotate_view_key(
    ctx: Context<SetViewKey>,
    new_view_key: [u8; 32],
    new_holder: Pubkey,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    // Validate new values
    require!(
        new_view_key != [0u8; 32],
        StealthError::InvalidViewKey
    );
    require!(
        new_holder != Pubkey::default(),
        StealthError::InvalidViewKeyHolder
    );

    let old_holder = registry.view_key_holder;

    registry.view_key = new_view_key;
    registry.view_key_holder = new_holder;
    // Keep enabled status

    msg!("View key rotated from {} to {}", old_holder, new_holder);

    Ok(())
}

/// Accounts for verifying view key access
#[derive(Accounts)]
pub struct VerifyViewAccess<'info> {
    /// The party claiming view access
    pub viewer: Signer<'info>,

    /// The registry to check
    #[account(
        seeds = [StealthRegistry::SEED, registry.owner.as_ref()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, StealthRegistry>,
}

/// Verify that a viewer has valid view key access
///
/// This is used by off-chain services to verify view key claims.
/// Returns Ok if the viewer is authorized, Error otherwise.
pub fn verify_view_access(ctx: Context<VerifyViewAccess>) -> Result<()> {
    let registry = &ctx.accounts.registry;
    let viewer = &ctx.accounts.viewer;

    require!(
        registry.is_authorized_viewer(&viewer.key()),
        StealthError::ViewAccessDenied
    );

    msg!("View access verified for: {}", viewer.key());

    Ok(())
}
