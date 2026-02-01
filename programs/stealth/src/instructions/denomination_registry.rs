//! Denomination Registry Instructions
//!
//! Allows dynamic configuration of allowed pool denominations.
//! The authority can enable/disable specific denominations without redeploying.

use anchor_lang::prelude::*;
use crate::state::privacy_pool::{DenominationRegistry, DEFAULT_DENOMINATIONS};
use crate::error::StealthError;

/// Accounts for initializing the denomination registry
#[derive(Accounts)]
pub struct InitializeDenominationRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = DenominationRegistry::SIZE,
        seeds = [DenominationRegistry::SEED],
        bump,
    )]
    pub registry: Account<'info, DenominationRegistry>,

    pub system_program: Program<'info, System>,
}

/// Initialize the denomination registry with default values
pub fn initialize_denomination_registry(ctx: Context<InitializeDenominationRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    registry.authority = ctx.accounts.authority.key();
    // Initialize with the first 9 default denominations (max 16)
    registry.enabled_denominations = DEFAULT_DENOMINATIONS.to_vec();
    registry.allow_custom = false;
    registry.min_denomination = 100_000_000; // 0.1 SOL minimum
    registry.max_denomination = 1_000_000_000_000; // 1000 SOL maximum
    registry.bump = ctx.bumps.registry;

    msg!("Denomination registry initialized with {} denominations",
         registry.enabled_denominations.len());

    Ok(())
}

/// Accounts for updating the denomination registry
#[derive(Accounts)]
pub struct UpdateDenominationRegistry<'info> {
    #[account(
        constraint = authority.key() == registry.authority @ StealthError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [DenominationRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DenominationRegistry>,
}

/// Add a new denomination to the registry
pub fn add_denomination(ctx: Context<UpdateDenominationRegistry>, denomination: u64) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    // Validate denomination is within bounds
    require!(
        denomination >= registry.min_denomination,
        StealthError::DepositTooSmall
    );
    require!(
        denomination <= registry.max_denomination,
        StealthError::DepositTooLarge
    );

    // Check not already present
    require!(
        !registry.enabled_denominations.contains(&denomination),
        StealthError::InvalidDenomination
    );

    // Check we have space
    require!(
        registry.enabled_denominations.len() < DenominationRegistry::MAX_DENOMINATIONS,
        StealthError::InvalidDenomination
    );

    registry.enabled_denominations.push(denomination);
    msg!("Added denomination: {} lamports", denomination);

    Ok(())
}

/// Remove a denomination from the registry
pub fn remove_denomination(ctx: Context<UpdateDenominationRegistry>, denomination: u64) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    // Find and remove
    let pos = registry.enabled_denominations.iter()
        .position(|&d| d == denomination)
        .ok_or(StealthError::InvalidDenomination)?;

    registry.enabled_denominations.remove(pos);
    msg!("Removed denomination: {} lamports", denomination);

    Ok(())
}

/// Update registry configuration
pub fn update_registry_config(
    ctx: Context<UpdateDenominationRegistry>,
    allow_custom: Option<bool>,
    min_denomination: Option<u64>,
    max_denomination: Option<u64>,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    if let Some(allow) = allow_custom {
        registry.allow_custom = allow;
        msg!("Custom denominations: {}", if allow { "enabled" } else { "disabled" });
    }

    if let Some(min) = min_denomination {
        require!(min > 0, StealthError::DepositTooSmall);
        registry.min_denomination = min;
        msg!("Min denomination: {} lamports", min);
    }

    if let Some(max) = max_denomination {
        require!(
            max >= registry.min_denomination,
            StealthError::InvalidDenomination
        );
        registry.max_denomination = max;
        msg!("Max denomination: {} lamports", max);
    }

    Ok(())
}

/// Transfer authority to a new account
pub fn transfer_registry_authority(
    ctx: Context<UpdateDenominationRegistry>,
    new_authority: Pubkey,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let old_authority = registry.authority;
    registry.authority = new_authority;

    msg!("Registry authority transferred from {} to {}", old_authority, new_authority);

    Ok(())
}
