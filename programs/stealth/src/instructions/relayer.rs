//! Fee Relayer Instructions
//!
//! Enables sender privacy by hiding who pays transaction fees.
//!
//! ## Architecture
//!
//! 1. Relayers register and stake SOL
//! 2. Users request relay for their withdrawals
//! 3. Relayers submit transactions and pay network fees
//! 4. Relayers receive fee from withdrawal amount
//!
//! ## Security
//!
//! - Relayers must stake SOL (slashable)
//! - Reputation system tracks reliability
//! - Users can choose relayers based on fee/reputation

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{Relayer, RelayerRegistry, RelayerStake, PendingRelay, RelayCompleted};
use crate::error::StealthError;

/// Initialize the relayer registry
#[derive(Accounts)]
pub struct InitializeRelayerRegistry<'info> {
    /// Authority
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Registry account
    #[account(
        init,
        payer = authority,
        space = RelayerRegistry::SIZE,
        seeds = [RelayerRegistry::SEED],
        bump,
    )]
    pub registry: Account<'info, RelayerRegistry>,

    pub system_program: Program<'info, System>,
}

/// Initialize the relayer registry
pub fn initialize_relayer_registry(ctx: Context<InitializeRelayerRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    registry.authority = ctx.accounts.authority.key();
    registry.relayer_count = 0;
    registry.active_count = 0;
    registry.total_transactions = 0;
    registry.total_fees_paid = 0;
    registry.min_stake = RelayerRegistry::DEFAULT_MIN_STAKE;
    registry.registrations_open = true;
    registry.bump = ctx.bumps.registry;

    msg!("Relayer registry initialized");

    Ok(())
}

/// Register as a relayer
#[derive(Accounts)]
pub struct RegisterRelayer<'info> {
    /// Operator registering the relayer
    #[account(mut)]
    pub operator: Signer<'info>,

    /// The relayer's pubkey (can be same as operator)
    /// CHECK: Just used as identifier
    pub relayer_pubkey: UncheckedAccount<'info>,

    /// Registry
    #[account(
        mut,
        seeds = [RelayerRegistry::SEED],
        bump = registry.bump,
        constraint = registry.registrations_open @ StealthError::RegistrationsClosed,
    )]
    pub registry: Account<'info, RelayerRegistry>,

    /// Relayer account
    #[account(
        init,
        payer = operator,
        space = Relayer::SIZE,
        seeds = [Relayer::SEED, relayer_pubkey.key().as_ref()],
        bump,
    )]
    pub relayer: Account<'info, Relayer>,

    /// Stake account
    #[account(
        init,
        payer = operator,
        space = RelayerStake::SIZE,
        seeds = [RelayerStake::SEED, relayer_pubkey.key().as_ref()],
        bump,
    )]
    pub stake: Account<'info, RelayerStake>,

    pub system_program: Program<'info, System>,
}

/// Register as a relayer with stake
pub fn register_relayer(
    ctx: Context<RegisterRelayer>,
    fee_bps: u16,
    min_fee: u64,
    max_fee: u64,
    supported_denominations: u8,
    stake_amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let registry = &mut ctx.accounts.registry;
    let relayer = &mut ctx.accounts.relayer;
    let stake = &mut ctx.accounts.stake;

    // Validate fee
    require!(fee_bps <= Relayer::MAX_FEE_BPS, StealthError::RelayerFeeTooHigh);

    // Validate stake
    require!(
        stake_amount >= registry.min_stake,
        StealthError::InsufficientRelayerStake
    );

    // Transfer stake
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.operator.to_account_info(),
                to: stake.to_account_info(),
            },
        ),
        stake_amount,
    )?;

    // Initialize relayer
    relayer.pubkey = ctx.accounts.relayer_pubkey.key();
    relayer.operator = ctx.accounts.operator.key();
    relayer.fee_bps = fee_bps;
    relayer.min_fee = min_fee;
    relayer.max_fee = max_fee;
    relayer.tx_count = 0;
    relayer.total_earned = 0;
    relayer.is_active = true;
    relayer.supported_denominations = supported_denominations;
    relayer.reputation = 50; // Start at neutral
    relayer.registered_at = clock.unix_timestamp;
    relayer.last_active = clock.unix_timestamp;
    relayer.bump = ctx.bumps.relayer;

    // Initialize stake
    stake.relayer = relayer.pubkey;
    stake.amount = stake_amount;
    stake.staked_at = clock.unix_timestamp;
    stake.pending_slash = 0;
    stake.bump = ctx.bumps.stake;

    // Update registry
    registry.relayer_count += 1;
    registry.active_count += 1;

    msg!("Relayer registered: {}", relayer.pubkey);

    Ok(())
}

/// Update relayer configuration
#[derive(Accounts)]
pub struct UpdateRelayer<'info> {
    /// Operator
    #[account(mut)]
    pub operator: Signer<'info>,

    /// Relayer to update
    #[account(
        mut,
        seeds = [Relayer::SEED, relayer.pubkey.as_ref()],
        bump = relayer.bump,
        constraint = relayer.operator == operator.key() @ StealthError::Unauthorized,
    )]
    pub relayer: Account<'info, Relayer>,
}

/// Update relayer settings
pub fn update_relayer(
    ctx: Context<UpdateRelayer>,
    fee_bps: Option<u16>,
    min_fee: Option<u64>,
    max_fee: Option<u64>,
    supported_denominations: Option<u8>,
    is_active: Option<bool>,
) -> Result<()> {
    let relayer = &mut ctx.accounts.relayer;

    if let Some(fee) = fee_bps {
        require!(fee <= Relayer::MAX_FEE_BPS, StealthError::RelayerFeeTooHigh);
        relayer.fee_bps = fee;
    }

    if let Some(min) = min_fee {
        relayer.min_fee = min;
    }

    if let Some(max) = max_fee {
        relayer.max_fee = max;
    }

    if let Some(denoms) = supported_denominations {
        relayer.supported_denominations = denoms;
    }

    if let Some(active) = is_active {
        relayer.is_active = active;
    }

    msg!("Relayer updated: {}", relayer.pubkey);

    Ok(())
}

/// Request a relay for withdrawal
#[derive(Accounts)]
#[instruction(tx_hash: [u8; 32])]
pub struct RequestRelay<'info> {
    /// User requesting relay (not paying fees!)
    pub user: Signer<'info>,

    /// Someone else pays for account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Selected relayer
    #[account(
        seeds = [Relayer::SEED, relayer.pubkey.as_ref()],
        bump = relayer.bump,
        constraint = relayer.is_active @ StealthError::RelayerNotActive,
    )]
    pub relayer: Account<'info, Relayer>,

    /// Pending relay account
    #[account(
        init,
        payer = payer,
        space = PendingRelay::SIZE,
        seeds = [PendingRelay::SEED, user.key().as_ref(), &tx_hash],
        bump,
    )]
    pub pending: Account<'info, PendingRelay>,

    pub system_program: Program<'info, System>,
}

/// Request a relayed withdrawal
pub fn request_relay(
    ctx: Context<RequestRelay>,
    tx_hash: [u8; 32],
    denomination: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let relayer = &ctx.accounts.relayer;
    let pending = &mut ctx.accounts.pending;

    // Validate relayer supports this denomination
    require!(
        relayer.supports_denomination(denomination),
        StealthError::DenominationNotSupported
    );

    // Calculate fee
    let fee = relayer.calculate_fee(denomination);

    // Initialize pending relay
    pending.user = ctx.accounts.user.key();
    pending.relayer = relayer.pubkey;
    pending.tx_hash = tx_hash;
    pending.fee = fee;
    pending.denomination = denomination;
    pending.requested_at = clock.unix_timestamp;
    pending.expires_at = clock.unix_timestamp + PendingRelay::DEFAULT_EXPIRY_SECONDS;
    pending.completed = false;
    pending.bump = ctx.bumps.pending;

    msg!("Relay requested. Fee: {} lamports", fee);

    Ok(())
}

/// Complete a relayed transaction
#[derive(Accounts)]
#[instruction(tx_hash: [u8; 32])]
pub struct CompleteRelay<'info> {
    /// Relayer completing the relay
    #[account(mut)]
    pub relayer_signer: Signer<'info>,

    /// Relayer account
    #[account(
        mut,
        seeds = [Relayer::SEED, relayer.pubkey.as_ref()],
        bump = relayer.bump,
        constraint = relayer.pubkey == relayer_signer.key() @ StealthError::Unauthorized,
    )]
    pub relayer: Account<'info, Relayer>,

    /// User who requested
    /// CHECK: Verified against pending
    pub user: UncheckedAccount<'info>,

    /// Pending relay
    #[account(
        mut,
        seeds = [PendingRelay::SEED, user.key().as_ref(), &tx_hash],
        bump = pending.bump,
        constraint = pending.relayer == relayer.pubkey @ StealthError::WrongRelayer,
        constraint = !pending.completed @ StealthError::RelayAlreadyCompleted,
    )]
    pub pending: Account<'info, PendingRelay>,

    /// Registry for stats
    #[account(
        mut,
        seeds = [RelayerRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, RelayerRegistry>,
}

/// Mark relay as completed (called after successful submission)
pub fn complete_relay(
    ctx: Context<CompleteRelay>,
    _tx_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let relayer = &mut ctx.accounts.relayer;
    let pending = &mut ctx.accounts.pending;
    let registry = &mut ctx.accounts.registry;

    // Check not expired
    require!(
        clock.unix_timestamp <= pending.expires_at,
        StealthError::RelayExpired
    );

    // Mark completed
    pending.completed = true;

    // Update relayer stats
    relayer.tx_count += 1;
    relayer.total_earned += pending.fee;
    relayer.last_active = clock.unix_timestamp;

    // Increase reputation (max 100)
    if relayer.reputation < 100 {
        relayer.reputation = relayer.reputation.saturating_add(1);
    }

    // Update registry stats
    registry.total_transactions += 1;
    registry.total_fees_paid += pending.fee;

    emit!(RelayCompleted {
        relayer: relayer.pubkey,
        fee: pending.fee,
        denomination: pending.denomination,
        timestamp: clock.unix_timestamp,
    });

    msg!("Relay completed. Fee earned: {} lamports", pending.fee);

    Ok(())
}

/// Withdraw stake (with timelock)
#[derive(Accounts)]
pub struct WithdrawRelayerStake<'info> {
    /// Operator withdrawing
    #[account(mut)]
    pub operator: Signer<'info>,

    /// Relayer
    #[account(
        mut,
        seeds = [Relayer::SEED, relayer.pubkey.as_ref()],
        bump = relayer.bump,
        constraint = relayer.operator == operator.key() @ StealthError::Unauthorized,
    )]
    pub relayer: Account<'info, Relayer>,

    /// Stake account
    #[account(
        mut,
        seeds = [RelayerStake::SEED, relayer.pubkey.as_ref()],
        bump = stake.bump,
        constraint = stake.pending_slash == 0 @ StealthError::PendingSlash,
    )]
    pub stake: Account<'info, RelayerStake>,

    /// Registry
    #[account(
        mut,
        seeds = [RelayerRegistry::SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, RelayerRegistry>,

    pub system_program: Program<'info, System>,
}

/// Withdraw relayer stake
pub fn withdraw_relayer_stake(ctx: Context<WithdrawRelayerStake>) -> Result<()> {
    let clock = Clock::get()?;
    let relayer = &mut ctx.accounts.relayer;
    let stake = &mut ctx.accounts.stake;
    let registry = &mut ctx.accounts.registry;

    // Require 7 day unstaking period
    const UNSTAKE_PERIOD: i64 = 7 * 24 * 60 * 60;
    require!(
        clock.unix_timestamp >= stake.staked_at + UNSTAKE_PERIOD,
        StealthError::UnstakePeriodNotMet
    );

    // Transfer stake back to operator
    let stake_amount = stake.amount;
    **stake.to_account_info().try_borrow_mut_lamports()? -= stake_amount;
    **ctx.accounts.operator.to_account_info().try_borrow_mut_lamports()? += stake_amount;

    stake.amount = 0;

    // Deactivate relayer
    relayer.is_active = false;

    // Update registry
    if registry.active_count > 0 {
        registry.active_count -= 1;
    }

    msg!("Stake withdrawn: {} lamports", stake_amount);

    Ok(())
}

/// List active relayers (view function helper)
#[derive(Accounts)]
pub struct GetRelayerInfo<'info> {
    /// Relayer to query
    #[account(
        seeds = [Relayer::SEED, relayer.pubkey.as_ref()],
        bump = relayer.bump,
    )]
    pub relayer: Account<'info, Relayer>,
}

/// Get relayer info (for client queries)
pub fn get_relayer_info(ctx: Context<GetRelayerInfo>) -> Result<()> {
    let relayer = &ctx.accounts.relayer;

    msg!("Relayer: {}", relayer.pubkey);
    msg!("Fee: {} bps", relayer.fee_bps);
    msg!("Min fee: {} lamports", relayer.min_fee);
    msg!("Active: {}", relayer.is_active);
    msg!("Reputation: {}", relayer.reputation);
    msg!("TX count: {}", relayer.tx_count);

    Ok(())
}
