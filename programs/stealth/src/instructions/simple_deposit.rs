//! Simple Deposit - Stores commitment without on-chain Merkle computation
//!
//! This instruction allows deposits where:
//! - Commitment is stored on-chain
//! - Merkle tree is built off-chain from indexed commitments
//! - The program accepts a Merkle root from a trusted indexer or stores roots separately
//!
//! This is a workaround for the expensive on-chain Poseidon computation.
//! For production, consider using Light Protocol for ZK-compressed storage.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::privacy_pool::{PrivacyPool, CommitmentLeaf, PoolConfig};
use crate::error::StealthError;

/// Simple deposit accounts
#[derive(Accounts)]
#[instruction(denomination: u64, commitment: [u8; 32])]
pub struct SimpleDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Pool PDA
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Config PDA
    #[account(
        seeds = [PoolConfig::SEED, &denomination.to_le_bytes()],
        bump = config.bump,
        constraint = !config.deposits_paused @ StealthError::DepositsPaused,
    )]
    pub config: Account<'info, PoolConfig>,

    /// Commitment leaf account
    #[account(
        init,
        payer = depositor,
        space = CommitmentLeaf::SIZE,
        seeds = [CommitmentLeaf::SEED, &denomination.to_le_bytes(), commitment.as_ref()],
        bump,
    )]
    pub commitment_leaf: Account<'info, CommitmentLeaf>,

    /// Fee recipient
    /// CHECK: Validated against config
    #[account(
        mut,
        constraint = fee_recipient.key() == config.fee_recipient @ StealthError::InvalidFeeRecipient,
    )]
    pub fee_recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Simple deposit - stores commitment without computing Merkle tree on-chain
///
/// The Merkle tree is built off-chain by indexing CommitmentLeaf accounts.
/// This avoids the expensive on-chain Poseidon computation.
///
/// # Arguments
/// * `denomination` - Pool denomination
/// * `commitment` - Pre-computed commitment: Poseidon(nullifier, secret, amount, recipient)
/// * `merkle_root` - Off-chain computed Merkle root after this insertion
#[inline(never)]
pub fn simple_deposit(
    ctx: Context<SimpleDeposit>,
    denomination: u64,
    commitment: [u8; 32],
    merkle_root: [u8; 32],
) -> Result<()> {
    let config = &ctx.accounts.config;
    let clock = Clock::get()?;

    // Verify pool is active and denomination matches
    let amount = {
        let pool = ctx.accounts.pool.load()?;
        require!(pool.is_active, StealthError::PoolNotActive);
        require!(
            pool.denomination == denomination,
            StealthError::AmountMustMatchDenomination
        );
        pool.denomination
    };

    // Calculate fee
    let fee = (amount as u128)
        .checked_mul(config.fee_bps as u128)
        .ok_or(StealthError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(StealthError::ArithmeticOverflow)? as u64;
    let deposit_amount = amount.checked_sub(fee).ok_or(StealthError::ArithmeticUnderflow)?;

    // Transfer to pool
    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.depositor.to_account_info(),
            to: ctx.accounts.pool.to_account_info(),
        },
    );
    system_program::transfer(cpi_context, deposit_amount)?;

    // Transfer fee
    if fee > 0 {
        let fee_cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.fee_recipient.to_account_info(),
            },
        );
        system_program::transfer(fee_cpi, fee)?;
    }

    // Get leaf index and update pool state (minimal on-chain computation)
    let leaf_index;
    {
        let mut pool = ctx.accounts.pool.load_mut()?;
        leaf_index = pool.next_leaf_index;

        // Store the provided Merkle root (trusted from off-chain computation)
        pool.save_root_to_history();
        pool.merkle_root = merkle_root;
        pool.next_leaf_index = leaf_index + 1;

        pool.total_deposited = pool.total_deposited
            .checked_add(deposit_amount)
            .ok_or(StealthError::ArithmeticOverflow)?;
        pool.deposit_count = pool.deposit_count
            .checked_add(1)
            .ok_or(StealthError::ArithmeticOverflow)?;
    }

    // Store commitment leaf for indexing
    {
        let leaf = &mut ctx.accounts.commitment_leaf;
        leaf.commitment = commitment;
        leaf.leaf_index = leaf_index;
        leaf.timestamp = clock.unix_timestamp;
        leaf.encrypted_note = [0u8; 128];
        leaf.amount_commitment = [0u8; 33];
        leaf.range_proof_hash = [0u8; 32];
        leaf.bump = ctx.bumps.commitment_leaf;
    }

    msg!("Simple deposit successful");
    msg!("Leaf index: {}", leaf_index);
    msg!("Merkle root updated to: {:?}", &merkle_root[..8]);

    Ok(())
}
