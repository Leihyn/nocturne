//! Private Deposit Instruction
//!
//! Deposits funds into the privacy pool with a commitment.
//! The commitment hides: nullifier, secret, amount, and recipient.
//! Nobody can tell who will receive the funds!
//!
//! Stack Optimization:
//! - Uses computed Poseidon zero hashes
//! - Functions marked #[inline(never)] to prevent stack blowup
//! - Merkle tree insertion split into separate function

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::privacy_pool::{PrivacyPool, CommitmentLeaf, PoolConfig, ROOT_HISTORY_SIZE};
use crate::crypto::merkle::{compute_zero_hashes_poseidon, MERKLE_DEPTH, merkle_hash_2};
use crate::error::StealthError;

/// Initialize a fixed-denomination privacy pool
/// Each pool has a specific denomination (1 SOL, 10 SOL, or 100 SOL)
/// The denomination is included in the PDA seeds so multiple pools can exist
#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Pool PDA includes denomination in seeds for multiple pools
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<PrivacyPool>(),
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Config PDA also includes denomination
    #[account(
        init,
        payer = authority,
        space = PoolConfig::SIZE,
        seeds = [PoolConfig::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub config: Account<'info, PoolConfig>,

    pub system_program: Program<'info, System>,
}

/// Initialize a fixed-denomination pool
/// Uses pre-computed zero hashes to avoid stack allocation
/// OPTIMIZATION: Computes zero hashes ONCE and passes to init_filled_subtrees
#[inline(never)]
pub fn initialize_pool(ctx: Context<InitializePool>, denomination: u64) -> Result<()> {
    // Validate denomination is one of the allowed values
    require!(
        PrivacyPool::is_valid_denomination(denomination),
        StealthError::InvalidDenomination
    );

    // Load pool with zero-copy (no stack allocation for the struct)
    let mut pool = ctx.accounts.pool.load_init()?;
    let config = &mut ctx.accounts.config;

    // OPTIMIZATION: Compute zero hashes ONCE (expensive operation)
    let zeros = compute_zero_hashes_poseidon();

    pool.authority = ctx.accounts.authority.key();
    pool.denomination = denomination; // FIXED DENOMINATION
    pool.merkle_root = zeros[MERKLE_DEPTH];
    pool.next_leaf_index = 0;
    pool.total_deposited = 0;
    pool.total_withdrawn = 0;
    pool.deposit_count = 0;
    pool.withdrawal_count = 0;
    pool.is_active = true;
    pool.root_history_index = 0;
    pool.bump = ctx.bumps.pool;

    // Initialize filled subtrees with zero hashes (pass precomputed zeros)
    init_filled_subtrees_with_zeros(&mut pool, &zeros);

    // Initialize config (min/max now irrelevant - amount is fixed)
    config.authority = ctx.accounts.authority.key();
    config.min_deposit = denomination; // Must be exactly denomination
    config.max_deposit = denomination; // Must be exactly denomination
    config.fee_bps = PoolConfig::DEFAULT_FEE_BPS;
    config.fee_recipient = ctx.accounts.authority.key();
    config.deposits_paused = false;
    config.withdrawals_paused = false;
    config.bump = ctx.bumps.config;

    msg!("Fixed-denomination privacy pool initialized");
    msg!("Denomination: {} lamports ({} SOL)", denomination, denomination / 1_000_000_000);
    msg!("Initial root: {:?}", pool.merkle_root);

    Ok(())
}

/// Initialize filled subtrees with Poseidon zero hashes (separate frame)
/// DEPRECATED: Use init_filled_subtrees_with_zeros to avoid recomputing zeros
#[inline(never)]
fn init_filled_subtrees(pool: &mut PrivacyPool) {
    let zeros = compute_zero_hashes_poseidon();
    init_filled_subtrees_with_zeros(pool, &zeros);
}

/// Initialize filled subtrees with pre-computed zero hashes (saves ~50% compute)
#[inline(never)]
fn init_filled_subtrees_with_zeros(pool: &mut PrivacyPool, zeros: &[[u8; 32]; MERKLE_DEPTH + 1]) {
    for i in 0..MERKLE_DEPTH {
        pool.filled_subtrees[i] = zeros[i];
    }
    // Initialize root history
    pool.root_history = [[0u8; 32]; ROOT_HISTORY_SIZE];
}

/// Private deposit accounts for fixed-denomination pools
#[derive(Accounts)]
#[instruction(denomination: u64, commitment: [u8; 32])]
pub struct PrivateDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Pool PDA includes denomination in seeds
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Config PDA includes denomination in seeds
    #[account(
        seeds = [PoolConfig::SEED, &denomination.to_le_bytes()],
        bump = config.bump,
        constraint = !config.deposits_paused @ StealthError::DepositsPaused,
    )]
    pub config: Account<'info, PoolConfig>,

    /// Commitment leaf account (includes denomination for uniqueness across pools)
    #[account(
        init,
        payer = depositor,
        space = CommitmentLeaf::SIZE,
        seeds = [CommitmentLeaf::SEED, &denomination.to_le_bytes(), commitment.as_ref()],
        bump,
    )]
    pub commitment_leaf: Account<'info, CommitmentLeaf>,

    /// Optional: fee recipient
    /// CHECK: Validated against config
    #[account(
        mut,
        constraint = fee_recipient.key() == config.fee_recipient @ StealthError::InvalidFeeRecipient,
    )]
    pub fee_recipient: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

/// Pedersen commitment data for confidential amounts
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AmountCommitmentData {
    /// Pedersen commitment: C = amount*G + blinding*H (33 bytes compressed)
    pub commitment: [u8; 33],
    /// Range proof hash (verified by oracle)
    pub range_proof_hash: [u8; 32],
}

/// Deposit funds privately into the fixed-denomination pool
///
/// FIXED DENOMINATION: The deposit amount is determined by the pool's denomination.
/// All deposits in a pool are exactly the same amount, hiding the transfer amounts.
///
/// # Arguments
/// * `denomination` - The pool denomination (1, 10, or 100 SOL in lamports)
/// * `commitment` - The commitment hash: Poseidon(nullifier, secret)
/// * `encrypted_note` - Optional encrypted note for recipient (contains nullifier, secret)
#[inline(never)]
pub fn private_deposit(
    ctx: Context<PrivateDeposit>,
    denomination: u64,
    commitment: [u8; 32],
    encrypted_note: Option<[u8; 128]>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let clock = Clock::get()?;

    // Check pool is active and verify denomination matches (with zero-copy load)
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
    let deposit_amount = amount
        .checked_sub(fee)
        .ok_or(StealthError::ArithmeticUnderflow)?;

    // Transfer funds to pool
    transfer_to_pool_zc(&ctx, deposit_amount)?;

    // Transfer fee if applicable
    if fee > 0 {
        transfer_fee_zc(&ctx, fee)?;
    }

    // Insert commitment into Merkle tree (separate stack frame)
    let leaf_index;
    let new_root;
    {
        let mut pool = ctx.accounts.pool.load_mut()?;
        leaf_index = insert_commitment_to_tree_zc(&mut pool, commitment)?;
        pool.total_deposited = pool.total_deposited
            .checked_add(deposit_amount)
            .ok_or(StealthError::ArithmeticOverflow)?;
        pool.deposit_count = pool.deposit_count
            .checked_add(1)
            .ok_or(StealthError::ArithmeticOverflow)?;
        new_root = pool.merkle_root;
    }

    // Store commitment leaf
    // Note: Amount is not stored because it's implicit from the pool denomination
    {
        let commitment_leaf = &mut ctx.accounts.commitment_leaf;
        commitment_leaf.commitment = commitment;
        commitment_leaf.leaf_index = leaf_index;
        commitment_leaf.timestamp = clock.unix_timestamp;
        commitment_leaf.encrypted_note = encrypted_note.unwrap_or([0u8; 128]);
        // Amount commitment not needed - denomination is fixed and public
        commitment_leaf.amount_commitment = [0u8; 33];
        commitment_leaf.range_proof_hash = [0u8; 32];
        commitment_leaf.bump = ctx.bumps.commitment_leaf;
    }

    msg!("Private deposit to fixed-denomination pool");
    msg!("Denomination: {} SOL", amount / 1_000_000_000);
    msg!("Leaf index: {}", leaf_index);
    msg!("New root: {:?}", new_root);

    Ok(())
}

/// Transfer funds to pool for zero-copy account (separate stack frame)
#[inline(never)]
fn transfer_to_pool_zc(ctx: &Context<PrivateDeposit>, amount: u64) -> Result<()> {
    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.depositor.to_account_info(),
            to: ctx.accounts.pool.to_account_info(),
        },
    );
    system_program::transfer(cpi_context, amount)
}

/// Transfer fee if applicable for zero-copy account (separate stack frame)
#[inline(never)]
fn transfer_fee_zc(ctx: &Context<PrivateDeposit>, fee: u64) -> Result<()> {
    if let Some(fee_recipient) = &ctx.accounts.fee_recipient {
        let fee_cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: fee_recipient.to_account_info(),
            },
        );
        system_program::transfer(fee_cpi, fee)?;
    }
    Ok(())
}

/// Insert commitment into Merkle tree for zero-copy account (separate stack frame)
#[inline(never)]
fn insert_commitment_to_tree_zc(pool: &mut PrivacyPool, commitment: [u8; 32]) -> Result<u64> {
    let leaf_index = pool.next_leaf_index;

    // Save current root to history
    pool.save_root_to_history();

    // Update Merkle tree using static zero hashes
    let new_root = compute_new_root_zc(pool, commitment, leaf_index);

    pool.merkle_root = new_root;
    pool.next_leaf_index += 1;

    Ok(leaf_index)
}

/// Compute new Merkle root after insertion for zero-copy account (separate stack frame)
/// Uses Poseidon hash for ZK circuit compatibility
#[inline(never)]
fn compute_new_root_zc(pool: &mut PrivacyPool, commitment: [u8; 32], leaf_index: u64) -> [u8; 32] {
    let zeros = compute_zero_hashes_poseidon();
    let mut current_index = leaf_index;
    let mut current_hash = commitment;

    for i in 0..MERKLE_DEPTH {
        let is_left = current_index % 2 == 0;

        if is_left {
            pool.filled_subtrees[i] = current_hash;
            current_hash = merkle_hash_2(&current_hash, &zeros[i]);
        } else {
            current_hash = merkle_hash_2(&pool.filled_subtrees[i], &current_hash);
        }

        current_index /= 2;
    }

    current_hash
}

/// Batch deposit - deposit multiple commitments at once
#[derive(Accounts)]
pub struct BatchDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [PrivacyPool::SEED],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    #[account(
        seeds = [PoolConfig::SEED],
        bump = config.bump,
        constraint = !config.deposits_paused @ StealthError::DepositsPaused,
    )]
    pub config: Account<'info, PoolConfig>,

    pub system_program: Program<'info, System>,
}

/// Batch deposit multiple commitments
/// More gas efficient for multiple deposits
#[inline(never)]
pub fn batch_deposit(
    ctx: Context<BatchDeposit>,
    commitments: Vec<[u8; 32]>,
    total_amount: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;

    // Check pool is active (with zero-copy load)
    {
        let pool = ctx.accounts.pool.load()?;
        require!(pool.is_active, StealthError::PoolNotActive);
    }

    require!(
        !commitments.is_empty() && commitments.len() <= 10,
        StealthError::InvalidBatchSize
    );

    // Calculate fee
    let fee = (total_amount as u128)
        .checked_mul(config.fee_bps as u128)
        .ok_or(StealthError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(StealthError::ArithmeticOverflow)? as u64;
    let deposit_amount = total_amount
        .checked_sub(fee)
        .ok_or(StealthError::ArithmeticUnderflow)?;

    // Transfer total to pool
    batch_transfer_to_pool_zc(&ctx, deposit_amount)?;

    // Save current root and insert all commitments
    let num_commitments = commitments.len();
    let new_root;
    {
        let mut pool = ctx.accounts.pool.load_mut()?;
        batch_insert_commitments_zc(&mut pool, commitments)?;
        pool.total_deposited = pool.total_deposited
            .checked_add(deposit_amount)
            .ok_or(StealthError::ArithmeticOverflow)?;
        pool.deposit_count = pool.deposit_count
            .checked_add(num_commitments as u64)
            .ok_or(StealthError::ArithmeticOverflow)?;
        new_root = pool.merkle_root;
    }

    msg!("Batch deposit of {} commitments successful", num_commitments);
    msg!("New root: {:?}", new_root);

    Ok(())
}

/// Transfer funds to pool for batch deposit with zero-copy (separate stack frame)
#[inline(never)]
fn batch_transfer_to_pool_zc(ctx: &Context<BatchDeposit>, amount: u64) -> Result<()> {
    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.depositor.to_account_info(),
            to: ctx.accounts.pool.to_account_info(),
        },
    );
    system_program::transfer(cpi_context, amount)
}

/// Insert all commitments into the Merkle tree for zero-copy (separate stack frame)
#[inline(never)]
fn batch_insert_commitments_zc(pool: &mut PrivacyPool, commitments: Vec<[u8; 32]>) -> Result<()> {
    // Save current root
    pool.save_root_to_history();

    // Insert each commitment
    for commitment in commitments.iter() {
        let leaf_index = pool.next_leaf_index;
        let new_root = compute_new_root_zc(pool, *commitment, leaf_index);
        pool.merkle_root = new_root;
        pool.next_leaf_index += 1;
        msg!("Inserted commitment at index {}", leaf_index);
    }

    Ok(())
}

/// Close a privacy pool - returns lamports to authority
/// WARNING: Only use this for migration or cleanup. This destroys all pool data!
#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct ClosePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Pool to close - must match authority
    /// CHECK: We manually validate and close this account
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountInfo<'info>,

    /// Config to close
    #[account(
        mut,
        seeds = [PoolConfig::SEED, &denomination.to_le_bytes()],
        bump,
        close = authority,
    )]
    pub config: Account<'info, PoolConfig>,

    pub system_program: Program<'info, System>,
}

/// Close pool handler - returns all lamports to authority
pub fn close_pool(ctx: Context<ClosePool>, denomination: u64) -> Result<()> {
    // Verify authority owns the config
    require!(
        ctx.accounts.config.authority == ctx.accounts.authority.key(),
        StealthError::Unauthorized
    );

    // Close the pool account manually (since it's AccountLoader/zero-copy)
    let pool_info = ctx.accounts.pool.to_account_info();
    let authority_info = ctx.accounts.authority.to_account_info();

    // Transfer lamports from pool to authority
    let pool_lamports = pool_info.lamports();
    **pool_info.try_borrow_mut_lamports()? = 0;
    **authority_info.try_borrow_mut_lamports()? = authority_info
        .lamports()
        .checked_add(pool_lamports)
        .ok_or(StealthError::MathOverflow)?;

    // Zero out the data to mark as closed
    pool_info.try_borrow_mut_data()?.fill(0);

    msg!("Pool for denomination {} closed", denomination);
    msg!("Returned {} lamports to authority", pool_lamports);

    Ok(())
}
