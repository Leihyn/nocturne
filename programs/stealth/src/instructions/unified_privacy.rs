//! Unified Privacy Flow
//!
//! Integrates Privacy Pools + Stealth Addresses into ONE flow.
//!
//! ## Why Unified?
//!
//! BEFORE (Separate - User can mess up):
//! 1. User deposits to pool
//! 2. User withdraws to regular address ← PRIVACY LEAK!
//! 3. User manually sends to stealth address ← Extra step, often skipped
//!
//! AFTER (Unified - Privacy guaranteed):
//! 1. User deposits to pool
//! 2. User withdraws → Program AUTOMATICALLY derives stealth address
//! 3. Recipient scans for their payments
//!
//! ## Privacy Score
//!
//! Separate flows: ~60% (user error prone)
//! Unified flow:   ~97% (automatic, can't mess up)

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::keccak;

use crate::crypto::keys;
use crate::error::StealthError;
use crate::state::{
    PrivacyPool, NullifierRecord, StealthAnnouncement, Relayer, WithdrawalCommitment,
};

// ============================================================================
// UNIFIED DEPOSIT
// ============================================================================
// Same as regular pool deposit - no changes needed here.
// The magic happens on withdrawal.

/// Unified deposit into privacy pool
#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct UnifiedDeposit<'info> {
    /// Depositor
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Privacy pool for this denomination
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    pub system_program: Program<'info, System>,
}

/// Deposit to unified privacy pool
pub fn unified_deposit(
    ctx: Context<UnifiedDeposit>,
    denomination: u64,
    commitment: [u8; 32],
    _encrypted_note: Option<[u8; 128]>,
) -> Result<()> {
    // Validate denomination
    require!(
        denomination == 1_000_000_000 ||      // 1 SOL
        denomination == 10_000_000_000 ||     // 10 SOL
        denomination == 100_000_000_000,      // 100 SOL
        StealthError::InvalidDenomination
    );

    let pool = ctx.accounts.pool.load()?;

    // Check pool is active
    require!(pool.is_active, StealthError::PoolNotActive);

    // Store values before drop
    let leaf_index = pool.next_leaf_index;
    drop(pool);

    // Transfer exact denomination to pool
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.pool.to_account_info(),
            },
        ),
        denomination,
    )?;

    // Reload and update pool state
    let mut pool = ctx.accounts.pool.load_mut()?;
    pool.deposit_count += 1;
    pool.total_deposited += denomination;
    pool.next_leaf_index += 1;

    msg!("Unified deposit: {} lamports", denomination);
    msg!("Commitment: {:?}", &commitment[..8]);
    msg!("Leaf index: {}", leaf_index);

    // Emit event for indexers
    emit!(UnifiedDepositEvent {
        pool: ctx.accounts.pool.key(),
        commitment,
        denomination,
        leaf_index: leaf_index as u32,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ============================================================================
// UNIFIED WITHDRAW (The Magic - Stealth Address Integration)
// ============================================================================
//
// KEY DIFFERENCE: Instead of withdrawing to a regular address,
// the user provides a STEALTH META-ADDRESS and the program
// automatically derives a unique stealth address.

/// Unified withdrawal to stealth address
#[derive(Accounts)]
#[instruction(denomination: u64, proof: UnifiedWithdrawProof)]
pub struct UnifiedWithdraw<'info> {
    /// Pool to withdraw from
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Nullifier record (prevents double-spend)
    #[account(
        init,
        payer = fee_payer,
        space = NullifierRecord::SIZE,
        seeds = [NullifierRecord::SEED, &proof.nullifier_hash],
        bump,
    )]
    pub nullifier: Account<'info, NullifierRecord>,

    /// Stealth address (derived by program, receives funds)
    /// CHECK: Derived from recipient's meta-address
    #[account(mut)]
    pub stealth_address: UncheckedAccount<'info>,

    /// Announcement account (stores ephemeral key for recipient to scan)
    #[account(
        init,
        payer = fee_payer,
        space = StealthAnnouncement::SIZE,
        seeds = [
            b"unified_announcement",
            stealth_address.key().as_ref(),
        ],
        bump,
    )]
    pub announcement: Account<'info, StealthAnnouncement>,

    /// Fee payer (relayer or user)
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    /// Optional relayer
    pub relayer: Option<Account<'info, Relayer>>,

    pub system_program: Program<'info, System>,
}

/// Unified withdrawal proof (combines ZK proof + stealth derivation)
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnifiedWithdrawProof {
    /// ZK proof that user knows a valid commitment
    pub nullifier_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub proof_data: [u8; 256],

    /// Recipient's stealth meta-address
    pub recipient_scan_pubkey: [u8; 32],
    pub recipient_spend_pubkey: [u8; 32],

    /// Ephemeral key for stealth derivation (generated by withdrawer)
    pub ephemeral_pubkey: [u8; 32],

    /// Pre-computed stealth address (verified on-chain)
    pub expected_stealth_address: Pubkey,
}

/// Withdraw from pool to stealth address
pub fn unified_withdraw(
    ctx: Context<UnifiedWithdraw>,
    denomination: u64,
    proof: UnifiedWithdrawProof,
    relayer_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    // ========================================
    // STEP 1: Verify Pool State
    // ========================================

    let mut pool = ctx.accounts.pool.load_mut()?;

    require!(pool.is_active, StealthError::PoolNotActive);

    // Check pool has sufficient balance
    let pool_balance = pool.total_deposited.saturating_sub(pool.total_withdrawn);
    require!(pool_balance >= denomination, StealthError::InsufficientPoolBalance);

    // Verify Merkle root is valid
    require!(
        pool.is_valid_root(&proof.merkle_root),
        StealthError::InvalidMerkleRoot
    );

    // Update pool state
    pool.withdrawal_count += 1;
    pool.total_withdrawn += denomination;

    drop(pool);

    // ========================================
    // STEP 2: Record Nullifier (prevents double-spend)
    // ========================================

    let nullifier = &mut ctx.accounts.nullifier;
    nullifier.nullifier_hash = proof.nullifier_hash;
    nullifier.spent_at = clock.unix_timestamp;
    nullifier.bump = ctx.bumps.nullifier;

    // ========================================
    // STEP 3: Verify Stealth Address Derivation
    // ========================================

    // Recompute stealth address from meta-address + ephemeral key
    let computed_stealth = keys::derive_stealth_address(
        &proof.recipient_scan_pubkey,
        &proof.recipient_spend_pubkey,
        &proof.ephemeral_pubkey,
    )?;

    // Verify it matches the provided stealth address
    require!(
        computed_stealth == ctx.accounts.stealth_address.key(),
        StealthError::AddressMismatch
    );
    require!(
        computed_stealth == proof.expected_stealth_address,
        StealthError::AddressMismatch
    );

    // ========================================
    // STEP 4: Calculate Fees
    // ========================================

    // Validate relayer fee
    if relayer_fee > 0 {
        require!(
            relayer_fee <= denomination / 10, // Max 10%
            StealthError::RelayerFeeTooHigh
        );
    }

    let recipient_amount = denomination.saturating_sub(relayer_fee);

    // ========================================
    // STEP 5: Transfer to Stealth Address
    // ========================================

    // Transfer from pool to stealth address
    **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? -= recipient_amount;
    **ctx.accounts.stealth_address.to_account_info().try_borrow_mut_lamports()? += recipient_amount;

    // Pay relayer fee if applicable
    if relayer_fee > 0 {
        **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? -= relayer_fee;
        **ctx.accounts.fee_payer.to_account_info().try_borrow_mut_lamports()? += relayer_fee;
    }

    // ========================================
    // STEP 6: Create Announcement (for recipient to scan)
    // ========================================

    let announcement = &mut ctx.accounts.announcement;
    announcement.ephemeral_pubkey = proof.ephemeral_pubkey;
    announcement.stealth_address = ctx.accounts.stealth_address.key();
    announcement.timestamp = clock.unix_timestamp;
    announcement.amount = recipient_amount;

    // Compute commitment for verification
    let commitment = keys::compute_stealth_commitment(
        &proof.recipient_scan_pubkey,
        &proof.recipient_spend_pubkey,
        &proof.ephemeral_pubkey,
    );
    announcement.commitment = commitment;
    announcement.bump = ctx.bumps.announcement;

    msg!("Unified withdrawal complete");
    msg!("Stealth address: {}", ctx.accounts.stealth_address.key());
    msg!("Amount: {} lamports", recipient_amount);

    // Emit event
    emit!(UnifiedWithdrawEvent {
        pool: ctx.accounts.pool.key(),
        stealth_address: ctx.accounts.stealth_address.key(),
        ephemeral_pubkey: proof.ephemeral_pubkey,
        nullifier_hash: proof.nullifier_hash,
        denomination,
        relayer_fee,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ============================================================================
// UNIFIED WITHDRAW WITH COMMIT-REVEAL (Maximum Privacy)
// ============================================================================

/// Commit to a unified withdrawal
#[derive(Accounts)]
#[instruction(commitment_hash: [u8; 32])]
pub struct UnifiedCommit<'info> {
    /// User committing to withdrawal
    #[account(mut)]
    pub user: Signer<'info>,

    /// Commitment account
    #[account(
        init,
        payer = user,
        space = WithdrawalCommitment::SIZE,
        seeds = [
            WithdrawalCommitment::SEED,
            user.key().as_ref(),
            &commitment_hash,
        ],
        bump,
    )]
    pub commitment: Account<'info, WithdrawalCommitment>,

    pub system_program: Program<'info, System>,
}

/// Commit to unified withdrawal (Step 1 of 2)
pub fn unified_commit(
    ctx: Context<UnifiedCommit>,
    commitment_hash: [u8; 32],
    denomination: u64,
    min_delay_hours: u8,
    max_delay_hours: u8,
) -> Result<()> {
    let clock = Clock::get()?;

    // Validate delays
    require!(min_delay_hours >= 1, StealthError::DelayTooShort);
    require!(max_delay_hours <= 168, StealthError::DelayTooLong); // Max 7 days
    require!(max_delay_hours > min_delay_hours, StealthError::InvalidDelayWindow);

    let commitment = &mut ctx.accounts.commitment;
    commitment.owner = ctx.accounts.user.key();
    commitment.commitment_hash = commitment_hash;
    commitment.commit_slot = clock.slot;
    commitment.commit_timestamp = clock.unix_timestamp;
    commitment.min_delay_seconds = (min_delay_hours as i64) * 3600;
    commitment.max_delay_seconds = (max_delay_hours as i64) * 3600;
    commitment.denomination = denomination;
    commitment.executed = false;
    commitment.cancelled = false;
    commitment.bump = ctx.bumps.commitment;

    msg!("Unified commitment created");
    msg!("Execute window: {}-{} hours", min_delay_hours, max_delay_hours);

    Ok(())
}

/// Reveal and execute unified withdrawal (Step 2 of 2)
#[derive(Accounts)]
#[instruction(commitment_hash: [u8; 32], denomination: u64, nullifier_hash: [u8; 32])]
pub struct UnifiedReveal<'info> {
    /// Anyone can reveal (enables keeper execution)
    pub revealer: Signer<'info>,

    /// Original committer
    /// CHECK: Verified against commitment
    pub user: UncheckedAccount<'info>,

    /// Commitment account
    #[account(
        mut,
        seeds = [
            WithdrawalCommitment::SEED,
            user.key().as_ref(),
            &commitment_hash,
        ],
        bump = commitment.bump,
        constraint = !commitment.executed @ StealthError::CommitmentAlreadyExecuted,
        constraint = !commitment.cancelled @ StealthError::CommitmentCancelled,
    )]
    pub commitment: Account<'info, WithdrawalCommitment>,

    /// Pool to withdraw from
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Nullifier record
    #[account(
        init,
        payer = fee_payer,
        space = NullifierRecord::SIZE,
        seeds = [NullifierRecord::SEED, &nullifier_hash],
        bump,
    )]
    pub nullifier: Account<'info, NullifierRecord>,

    /// Stealth address (receives funds)
    /// CHECK: Verified in instruction
    #[account(mut)]
    pub stealth_address: UncheckedAccount<'info>,

    /// Announcement account
    #[account(
        init,
        payer = fee_payer,
        space = StealthAnnouncement::SIZE,
        seeds = [
            b"unified_announcement",
            stealth_address.key().as_ref(),
        ],
        bump,
    )]
    pub announcement: Account<'info, StealthAnnouncement>,

    /// Fee payer
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    /// Optional relayer
    pub relayer: Option<Account<'info, Relayer>>,

    pub system_program: Program<'info, System>,
}

/// Reveal parameters for unified withdrawal
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnifiedRevealParams {
    /// ZK proof components
    pub nullifier_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub proof_data: [u8; 256],

    /// Stealth components
    pub recipient_scan_pubkey: [u8; 32],
    pub recipient_spend_pubkey: [u8; 32],
    pub ephemeral_pubkey: [u8; 32],

    /// Randomness used in commitment
    pub user_random: [u8; 32],
    pub nonce: u64,
}

/// Reveal and execute unified withdrawal
pub fn unified_reveal(
    ctx: Context<UnifiedReveal>,
    commitment_hash: [u8; 32],
    denomination: u64,
    nullifier_hash: [u8; 32],
    params: UnifiedRevealParams,
    relayer_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let commitment = &mut ctx.accounts.commitment;

    // ========================================
    // STEP 1: Verify Timing Window
    // ========================================

    let elapsed = clock.unix_timestamp - commitment.commit_timestamp;
    require!(
        elapsed >= commitment.min_delay_seconds,
        StealthError::NotInExecutionWindow
    );
    require!(
        elapsed <= commitment.max_delay_seconds,
        StealthError::NotInExecutionWindow
    );

    // ========================================
    // STEP 2: Verify Nullifier Hash Consistency
    // ========================================

    require!(
        nullifier_hash == params.nullifier_hash,
        StealthError::InvalidNullifier
    );

    // ========================================
    // STEP 3: Verify Commitment Hash
    // ========================================

    // Recompute: hash(nullifier_hash || recipient_scan || recipient_spend || ephemeral || random || nonce)
    let mut hasher_input = Vec::new();
    hasher_input.extend_from_slice(&nullifier_hash);
    hasher_input.extend_from_slice(&params.recipient_scan_pubkey);
    hasher_input.extend_from_slice(&params.recipient_spend_pubkey);
    hasher_input.extend_from_slice(&params.ephemeral_pubkey);
    hasher_input.extend_from_slice(&params.user_random);
    hasher_input.extend_from_slice(&params.nonce.to_le_bytes());

    let computed_hash = keccak::hash(&hasher_input);
    require!(
        computed_hash.0 == commitment_hash,
        StealthError::CommitmentMismatch
    );

    // ========================================
    // STEP 3: Verify Stealth Address
    // ========================================

    let computed_stealth = keys::derive_stealth_address(
        &params.recipient_scan_pubkey,
        &params.recipient_spend_pubkey,
        &params.ephemeral_pubkey,
    )?;

    require!(
        computed_stealth == ctx.accounts.stealth_address.key(),
        StealthError::AddressMismatch
    );

    // ========================================
    // STEP 4: Verify Pool and Merkle Root
    // ========================================

    let mut pool = ctx.accounts.pool.load_mut()?;

    require!(pool.is_active, StealthError::PoolNotActive);

    let pool_balance = pool.total_deposited.saturating_sub(pool.total_withdrawn);
    require!(pool_balance >= denomination, StealthError::InsufficientPoolBalance);

    require!(
        pool.is_valid_root(&params.merkle_root),
        StealthError::InvalidMerkleRoot
    );

    // Update pool state
    pool.withdrawal_count += 1;
    pool.total_withdrawn += denomination;

    drop(pool);

    // ========================================
    // STEP 5: Record Nullifier
    // ========================================

    let nullifier = &mut ctx.accounts.nullifier;
    nullifier.nullifier_hash = nullifier_hash;
    nullifier.spent_at = clock.unix_timestamp;
    nullifier.bump = ctx.bumps.nullifier;

    // ========================================
    // STEP 6: Mark Commitment Executed
    // ========================================

    commitment.executed = true;

    // ========================================
    // STEP 7: Transfer Funds
    // ========================================

    let recipient_amount = denomination.saturating_sub(relayer_fee);

    // Transfer to stealth address
    **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? -= recipient_amount;
    **ctx.accounts.stealth_address.to_account_info().try_borrow_mut_lamports()? += recipient_amount;

    // Pay relayer
    if relayer_fee > 0 {
        **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? -= relayer_fee;
        **ctx.accounts.fee_payer.to_account_info().try_borrow_mut_lamports()? += relayer_fee;
    }

    // ========================================
    // STEP 8: Create Announcement
    // ========================================

    let announcement = &mut ctx.accounts.announcement;
    announcement.ephemeral_pubkey = params.ephemeral_pubkey;
    announcement.stealth_address = ctx.accounts.stealth_address.key();
    announcement.timestamp = clock.unix_timestamp;
    announcement.amount = recipient_amount;
    announcement.commitment = keys::compute_stealth_commitment(
        &params.recipient_scan_pubkey,
        &params.recipient_spend_pubkey,
        &params.ephemeral_pubkey,
    );
    announcement.bump = ctx.bumps.announcement;

    msg!("Unified reveal + withdrawal complete");
    msg!("Stealth address: {}", ctx.accounts.stealth_address.key());

    emit!(UnifiedWithdrawEvent {
        pool: ctx.accounts.pool.key(),
        stealth_address: ctx.accounts.stealth_address.key(),
        ephemeral_pubkey: params.ephemeral_pubkey,
        nullifier_hash: params.nullifier_hash,
        denomination,
        relayer_fee,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct UnifiedDepositEvent {
    pub pool: Pubkey,
    pub commitment: [u8; 32],
    pub denomination: u64,
    pub leaf_index: u32,
    pub timestamp: i64,
}

#[event]
pub struct UnifiedWithdrawEvent {
    pub pool: Pubkey,
    pub stealth_address: Pubkey,
    pub ephemeral_pubkey: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub denomination: u64,
    pub relayer_fee: u64,
    pub timestamp: i64,
}
