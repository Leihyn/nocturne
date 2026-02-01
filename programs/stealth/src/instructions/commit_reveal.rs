//! Commit-Reveal Withdrawal System
//!
//! Implements timing obfuscation through a commit-reveal scheme.
//! This prevents timing analysis attacks by decoupling when users
//! decide to withdraw from when the withdrawal actually executes.
//!
//! ## Flow
//!
//! 1. COMMIT: User submits hash(proof || recipient || random || nonce)
//!    - Only hash visible on-chain, not withdrawal details
//!    - Clock starts ticking for min/max delay
//!
//! 2. WAIT: User chooses their own random delay within allowed window
//!    - Minimum delay enforced (e.g., 1 hour) - cannot bypass
//!    - Maximum delay enforced (e.g., 24 hours) - must execute before
//!
//! 3. REVEAL: User reveals parameters and executes withdrawal
//!    - Contract verifies hash matches
//!    - Contract verifies timing is within window
//!    - Withdrawal proceeds
//!
//! ## Privacy Benefits
//!
//! - No VRF request linkable to withdrawal
//! - User controls exact timing within window
//! - Observer can't predict when execution will happen

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{WithdrawalCommitment, PrivacyPool, compute_withdrawal_commitment};
use crate::error::StealthError;

/// Accounts for creating a withdrawal commitment
#[derive(Accounts)]
#[instruction(commitment_hash: [u8; 32], denomination: u64)]
pub struct CommitWithdrawal<'info> {
    /// User creating the commitment
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The commitment account (PDA)
    #[account(
        init,
        payer = owner,
        space = WithdrawalCommitment::SIZE,
        seeds = [
            WithdrawalCommitment::SEED,
            owner.key().as_ref(),
            &commitment_hash,
        ],
        bump,
    )]
    pub commitment: Account<'info, WithdrawalCommitment>,

    /// The pool this withdrawal will be from
    #[account(
        seeds = [
            PrivacyPool::SEED,
            &denomination.to_le_bytes(),
        ],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    pub system_program: Program<'info, System>,
}

/// Create a withdrawal commitment
///
/// The user commits to withdraw without revealing details.
/// They must wait min_delay before executing, and must execute before max_delay.
pub fn commit_withdrawal(
    ctx: Context<CommitWithdrawal>,
    commitment_hash: [u8; 32],
    denomination: u64,
    min_delay_hours: u8,
    max_delay_hours: u8,
) -> Result<()> {
    let clock = Clock::get()?;
    let commitment = &mut ctx.accounts.commitment;

    // Convert hours to seconds
    let min_delay_seconds = (min_delay_hours as i64) * 3600;
    let max_delay_seconds = (max_delay_hours as i64) * 3600;

    // Validate delays
    require!(
        min_delay_seconds >= WithdrawalCommitment::ABSOLUTE_MIN_DELAY,
        StealthError::DelayTooShort
    );
    require!(
        max_delay_seconds <= WithdrawalCommitment::ABSOLUTE_MAX_DELAY,
        StealthError::DelayTooLong
    );
    require!(
        max_delay_seconds > min_delay_seconds,
        StealthError::InvalidDelayWindow
    );

    // Validate denomination
    require!(
        denomination == 1_000_000_000 ||      // 1 SOL
        denomination == 10_000_000_000 ||     // 10 SOL
        denomination == 100_000_000_000,      // 100 SOL
        StealthError::InvalidDenomination
    );

    // Store commitment
    commitment.owner = ctx.accounts.owner.key();
    commitment.commitment_hash = commitment_hash;
    commitment.commit_slot = clock.slot;
    commitment.commit_timestamp = clock.unix_timestamp;
    commitment.min_delay_seconds = min_delay_seconds;
    commitment.max_delay_seconds = max_delay_seconds;
    commitment.denomination = denomination;
    commitment.executed = false;
    commitment.cancelled = false;
    commitment.bump = ctx.bumps.commitment;

    msg!(
        "Withdrawal committed. Execute window: {} - {} hours",
        min_delay_hours,
        max_delay_hours
    );

    Ok(())
}

/// Accounts for revealing and executing a committed withdrawal
#[derive(Accounts)]
#[instruction(
    commitment_hash: [u8; 32],
    denomination: u64,
)]
pub struct RevealWithdrawal<'info> {
    /// User executing the withdrawal
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The commitment being revealed
    #[account(
        mut,
        seeds = [
            WithdrawalCommitment::SEED,
            owner.key().as_ref(),
            &commitment_hash,
        ],
        bump = commitment.bump,
        constraint = commitment.owner == owner.key() @ StealthError::Unauthorized,
        constraint = !commitment.executed @ StealthError::CommitmentAlreadyExecuted,
        constraint = !commitment.cancelled @ StealthError::CommitmentCancelled,
    )]
    pub commitment: Account<'info, WithdrawalCommitment>,

    /// The pool to withdraw from
    #[account(
        mut,
        seeds = [
            PrivacyPool::SEED,
            &denomination.to_le_bytes(),
        ],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Recipient of the withdrawal
    /// CHECK: Can be any address
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// Optional relayer for fee payment
    /// CHECK: Can be any address
    #[account(mut)]
    pub relayer: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

/// Reveal commitment and execute withdrawal
///
/// User reveals the original parameters that hash to the commitment.
/// If valid and timing is correct, withdrawal proceeds.
pub fn reveal_and_withdraw(
    ctx: Context<RevealWithdrawal>,
    _commitment_hash: [u8; 32],
    denomination: u64,
    proof_hash: [u8; 32],
    user_random: [u8; 32],
    nonce: u64,
    relayer_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let commitment = &mut ctx.accounts.commitment;

    // Verify timing window
    require!(
        commitment.can_execute(clock.unix_timestamp),
        StealthError::NotInExecutionWindow
    );

    // Recompute commitment hash
    let computed_hash = compute_withdrawal_commitment(
        &proof_hash,
        &ctx.accounts.recipient.key(),
        &user_random,
        nonce,
    );

    // Verify hash matches
    require!(
        computed_hash == commitment.commitment_hash,
        StealthError::CommitmentMismatch
    );

    // Verify denomination matches
    require!(
        denomination == commitment.denomination,
        StealthError::DenominationMismatch
    );

    // Mark as executed BEFORE transfer (reentrancy protection)
    commitment.executed = true;

    // Calculate amounts
    let withdrawal_amount = denomination;
    let recipient_amount = withdrawal_amount.saturating_sub(relayer_fee);

    // Validate relayer fee
    if relayer_fee > 0 {
        require!(
            relayer_fee <= withdrawal_amount / 10, // Max 10% fee
            StealthError::RelayerFeeTooHigh
        );
        require!(
            ctx.accounts.relayer.is_some(),
            StealthError::RelayerRequired
        );
    }

    // Load pool and get bump for PDA signer
    let pool = ctx.accounts.pool.load_mut()?;
    let pool_bump = pool.bump;
    drop(pool); // Release borrow before CPI

    // Transfer to recipient (from pool PDA)
    let denomination_bytes = denomination.to_le_bytes();
    let pool_seeds: &[&[u8]] = &[
        PrivacyPool::SEED,
        &denomination_bytes,
        &[pool_bump],
    ];

    // Transfer main amount to recipient
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.pool.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
            &[pool_seeds],
        ),
        recipient_amount,
    )?;

    // Transfer relayer fee if applicable
    if relayer_fee > 0 {
        if let Some(relayer) = &ctx.accounts.relayer {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.pool.to_account_info(),
                        to: relayer.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                relayer_fee,
            )?;
        }
    }

    // Update pool state
    let mut pool = ctx.accounts.pool.load_mut()?;
    pool.deposit_count = pool.deposit_count.saturating_sub(1);

    msg!(
        "Commit-reveal withdrawal executed: {} lamports to {}",
        recipient_amount,
        ctx.accounts.recipient.key()
    );

    Ok(())
}

/// Accounts for cancelling a commitment
#[derive(Accounts)]
#[instruction(commitment_hash: [u8; 32])]
pub struct CancelCommitment<'info> {
    /// User cancelling their commitment
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The commitment to cancel
    #[account(
        mut,
        seeds = [
            WithdrawalCommitment::SEED,
            owner.key().as_ref(),
            &commitment_hash,
        ],
        bump = commitment.bump,
        constraint = commitment.owner == owner.key() @ StealthError::Unauthorized,
        constraint = !commitment.executed @ StealthError::CommitmentAlreadyExecuted,
    )]
    pub commitment: Account<'info, WithdrawalCommitment>,
}

/// Cancel a withdrawal commitment
///
/// User can cancel anytime before execution.
/// This allows changing their mind or re-committing with different timing.
pub fn cancel_commitment(
    ctx: Context<CancelCommitment>,
    _commitment_hash: [u8; 32],
) -> Result<()> {
    let commitment = &mut ctx.accounts.commitment;

    commitment.cancelled = true;

    msg!("Withdrawal commitment cancelled");

    Ok(())
}

/// Accounts for closing an expired/executed commitment
#[derive(Accounts)]
#[instruction(commitment_hash: [u8; 32])]
pub struct CloseCommitment<'info> {
    /// User closing their commitment (gets rent back)
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The commitment to close
    #[account(
        mut,
        close = owner,
        seeds = [
            WithdrawalCommitment::SEED,
            owner.key().as_ref(),
            &commitment_hash,
        ],
        bump = commitment.bump,
        constraint = commitment.owner == owner.key() @ StealthError::Unauthorized,
    )]
    pub commitment: Account<'info, WithdrawalCommitment>,
}

/// Close a commitment account and reclaim rent
///
/// Can only close if:
/// - Commitment was executed, OR
/// - Commitment was cancelled, OR
/// - Commitment has expired
pub fn close_commitment(
    ctx: Context<CloseCommitment>,
    _commitment_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let commitment = &ctx.accounts.commitment;

    // Can close if executed, cancelled, or expired
    let can_close = commitment.executed
        || commitment.cancelled
        || commitment.is_expired(clock.unix_timestamp);

    require!(can_close, StealthError::CommitmentStillActive);

    msg!("Commitment account closed, rent reclaimed");

    Ok(())
}
