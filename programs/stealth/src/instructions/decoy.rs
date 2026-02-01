//! Decoy System Instructions
//!
//! On-chain components for the decoy deposit system.
//! These are called by the off-chain decoy bot.
//!
//! ## Security
//!
//! - Only authorized operators can execute decoy operations
//! - Decoys use same ZK proofs as regular users
//! - Treasury funds are isolated from user funds
//! - Decoy operations are rate-limited

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{DecoyTreasury, DecoyConfig, DecoyWallet};
use crate::error::StealthError;

/// Initialize the decoy treasury
#[derive(Accounts)]
pub struct InitializeDecoyTreasury<'info> {
    /// Authority (protocol admin)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Treasury account
    #[account(
        init,
        payer = authority,
        space = DecoyTreasury::SIZE,
        seeds = [DecoyTreasury::SEED],
        bump,
    )]
    pub treasury: Account<'info, DecoyTreasury>,

    /// Config account
    #[account(
        init,
        payer = authority,
        space = DecoyConfig::SIZE,
        seeds = [DecoyConfig::SEED],
        bump,
    )]
    pub config: Account<'info, DecoyConfig>,

    pub system_program: Program<'info, System>,
}

/// Initialize decoy treasury and config
pub fn initialize_decoy_treasury(ctx: Context<InitializeDecoyTreasury>) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    treasury.authority = ctx.accounts.authority.key();
    treasury.balance = 0;
    treasury.total_collected = 0;
    treasury.total_spent = 0;
    treasury.active_wallets = 0;
    treasury.max_wallets = 100;
    treasury.is_active = true;
    treasury.bump = ctx.bumps.treasury;

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.fee_bps = DecoyTreasury::DEFAULT_FEE_BPS;
    config.min_decoys_per_deposit = DecoyConfig::DEFAULT_MIN_DECOYS;
    config.max_decoys_per_deposit = DecoyConfig::DEFAULT_MAX_DECOYS;
    config.min_delay_seconds = DecoyConfig::DEFAULT_MIN_DELAY;
    config.max_delay_seconds = DecoyConfig::DEFAULT_MAX_DELAY;
    config.min_hold_seconds = DecoyConfig::DEFAULT_MIN_HOLD;
    config.max_hold_seconds = DecoyConfig::DEFAULT_MAX_HOLD;
    config.auto_decoy = true;
    config.bump = ctx.bumps.config;

    msg!("Decoy treasury initialized");

    Ok(())
}

/// Fund the decoy treasury
#[derive(Accounts)]
pub struct FundDecoyTreasury<'info> {
    /// Funder
    #[account(mut)]
    pub funder: Signer<'info>,

    /// Treasury account
    #[account(
        mut,
        seeds = [DecoyTreasury::SEED],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, DecoyTreasury>,

    pub system_program: Program<'info, System>,
}

/// Add funds to decoy treasury
pub fn fund_decoy_treasury(ctx: Context<FundDecoyTreasury>, amount: u64) -> Result<()> {
    // Transfer SOL to treasury PDA
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        ),
        amount,
    )?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.balance = treasury.balance.saturating_add(amount);
    treasury.total_collected = treasury.total_collected.saturating_add(amount);

    msg!("Treasury funded with {} lamports", amount);

    Ok(())
}

/// Register a decoy wallet
#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RegisterDecoyWallet<'info> {
    /// Authority
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Treasury (to verify authority)
    #[account(
        seeds = [DecoyTreasury::SEED],
        bump = treasury.bump,
        constraint = treasury.authority == authority.key() @ StealthError::Unauthorized,
    )]
    pub treasury: Account<'info, DecoyTreasury>,

    /// Decoy wallet account
    #[account(
        init,
        payer = authority,
        space = DecoyWallet::SIZE,
        seeds = [DecoyWallet::SEED, wallet.as_ref()],
        bump,
    )]
    pub decoy_wallet: Account<'info, DecoyWallet>,

    pub system_program: Program<'info, System>,
}

/// Register a new decoy wallet
pub fn register_decoy_wallet(
    ctx: Context<RegisterDecoyWallet>,
    wallet: Pubkey,
) -> Result<()> {
    let clock = Clock::get()?;
    let decoy_wallet = &mut ctx.accounts.decoy_wallet;

    decoy_wallet.wallet = wallet;
    decoy_wallet.registered_at = clock.unix_timestamp;
    decoy_wallet.last_used = 0;
    decoy_wallet.operations_count = 0;
    decoy_wallet.in_pool_balance = 0;
    decoy_wallet.current_denomination = 0;
    decoy_wallet.is_active = true;
    decoy_wallet.bump = ctx.bumps.decoy_wallet;

    msg!("Decoy wallet registered: {}", wallet);

    Ok(())
}

/// Update decoy configuration
#[derive(Accounts)]
pub struct UpdateDecoyConfig<'info> {
    /// Authority
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Config
    #[account(
        mut,
        seeds = [DecoyConfig::SEED],
        bump = config.bump,
        constraint = config.authority == authority.key() @ StealthError::Unauthorized,
    )]
    pub config: Account<'info, DecoyConfig>,
}

/// Update decoy configuration parameters
pub fn update_decoy_config(
    ctx: Context<UpdateDecoyConfig>,
    fee_bps: Option<u16>,
    min_decoys: Option<u8>,
    max_decoys: Option<u8>,
    min_delay: Option<u32>,
    max_delay: Option<u32>,
    min_hold: Option<u32>,
    max_hold: Option<u32>,
    auto_decoy: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(fee) = fee_bps {
        require!(fee <= DecoyTreasury::MAX_FEE_BPS, StealthError::FeeTooHigh);
        config.fee_bps = fee;
    }

    if let Some(min) = min_decoys {
        config.min_decoys_per_deposit = min;
    }

    if let Some(max) = max_decoys {
        require!(max >= config.min_decoys_per_deposit, StealthError::InvalidDecoyConfig);
        config.max_decoys_per_deposit = max;
    }

    if let Some(min) = min_delay {
        config.min_delay_seconds = min;
    }

    if let Some(max) = max_delay {
        require!(max >= config.min_delay_seconds, StealthError::InvalidDecoyConfig);
        config.max_delay_seconds = max;
    }

    if let Some(min) = min_hold {
        config.min_hold_seconds = min;
    }

    if let Some(max) = max_hold {
        require!(max >= config.min_hold_seconds, StealthError::InvalidDecoyConfig);
        config.max_hold_seconds = max;
    }

    if let Some(auto) = auto_decoy {
        config.auto_decoy = auto;
    }

    msg!("Decoy config updated");

    Ok(())
}

/// Record that a decoy deposit was made
/// (Called by decoy bot after executing deposit)
#[derive(Accounts)]
pub struct RecordDecoyDeposit<'info> {
    /// Operator (authorized decoy bot)
    pub operator: Signer<'info>,

    /// Treasury
    #[account(
        mut,
        seeds = [DecoyTreasury::SEED],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, DecoyTreasury>,

    /// Decoy wallet used
    #[account(
        mut,
        seeds = [DecoyWallet::SEED, decoy_wallet.wallet.as_ref()],
        bump = decoy_wallet.bump,
    )]
    pub decoy_wallet: Account<'info, DecoyWallet>,
}

/// Record a decoy deposit (updates tracking state)
pub fn record_decoy_deposit(
    ctx: Context<RecordDecoyDeposit>,
    denomination: u64,
    tx_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let treasury = &mut ctx.accounts.treasury;
    let wallet = &mut ctx.accounts.decoy_wallet;

    // Update treasury
    treasury.balance = treasury.balance.saturating_sub(denomination + tx_fee);
    treasury.total_spent = treasury.total_spent.saturating_add(tx_fee);

    // Update wallet
    wallet.last_used = clock.unix_timestamp;
    wallet.operations_count = wallet.operations_count.saturating_add(1);
    wallet.in_pool_balance = wallet.in_pool_balance.saturating_add(denomination);
    wallet.current_denomination = denomination;

    emit!(crate::state::DecoyExecuted {
        wallet: wallet.wallet,
        denomination,
        is_deposit: true,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Record that a decoy withdrawal was made
#[derive(Accounts)]
pub struct RecordDecoyWithdraw<'info> {
    /// Operator
    pub operator: Signer<'info>,

    /// Treasury
    #[account(
        mut,
        seeds = [DecoyTreasury::SEED],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, DecoyTreasury>,

    /// Decoy wallet
    #[account(
        mut,
        seeds = [DecoyWallet::SEED, decoy_wallet.wallet.as_ref()],
        bump = decoy_wallet.bump,
    )]
    pub decoy_wallet: Account<'info, DecoyWallet>,
}

/// Record a decoy withdrawal (updates tracking state)
pub fn record_decoy_withdraw(
    ctx: Context<RecordDecoyWithdraw>,
    amount_returned: u64,
    tx_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let treasury = &mut ctx.accounts.treasury;
    let wallet = &mut ctx.accounts.decoy_wallet;

    // Update treasury
    treasury.balance = treasury.balance.saturating_add(amount_returned);
    treasury.total_spent = treasury.total_spent.saturating_add(tx_fee);

    // Update wallet
    wallet.last_used = clock.unix_timestamp;
    wallet.operations_count = wallet.operations_count.saturating_add(1);
    wallet.in_pool_balance = 0;
    wallet.current_denomination = 0;

    emit!(crate::state::DecoyExecuted {
        wallet: wallet.wallet,
        denomination: amount_returned,
        is_deposit: false,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Toggle decoy system on/off
#[derive(Accounts)]
pub struct ToggleDecoySystem<'info> {
    /// Authority
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Treasury
    #[account(
        mut,
        seeds = [DecoyTreasury::SEED],
        bump = treasury.bump,
        constraint = treasury.authority == authority.key() @ StealthError::Unauthorized,
    )]
    pub treasury: Account<'info, DecoyTreasury>,
}

/// Enable or disable the decoy system
pub fn toggle_decoy_system(ctx: Context<ToggleDecoySystem>, active: bool) -> Result<()> {
    ctx.accounts.treasury.is_active = active;

    msg!("Decoy system {}", if active { "enabled" } else { "disabled" });

    Ok(())
}
