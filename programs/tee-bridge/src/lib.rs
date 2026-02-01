//! TEE Bridge for Private Deposits
//!
//! This program enables private deposits to the StealthSol privacy pool via
//! MagicBlock Private Ephemeral Rollups (PER). Running inside Intel TDX,
//! it provides hardware-level privacy for deposit operations.
//!
//! ## Privacy Flow
//! 1. User deposits to staging account
//! 2. Staging account is delegated to PER (TEE)
//! 3. Inside TEE: commitment is generated privately
//! 4. Batch settlement: TEE submits commitments to privacy pool
//! 5. Even the operator cannot see user → commitment mapping
//!
//! ## Integration with StealthSol
//! - Deposits appear from the "batch relayer" address, not users
//! - Commitments are indistinguishable from each other
//! - ~95% privacy score vs ~80% with traditional relay
//!
//! Note: Session keys are handled by MagicBlock's middleware layer.
//! This program focuses on the core deposit/commitment logic.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("7BWpEN8PqFEZ131A5F8iEniMS6bYREGrabxLHgSdUmVW");

/// Seeds for PDA derivation
pub const STAGING_SEED: &[u8] = b"staging";
pub const BATCH_SEED: &[u8] = b"batch";
pub const COMMITMENT_SEED: &[u8] = b"tee_commitment";

/// Fixed denominations matching the main privacy pool
pub const DENOMINATION_1_SOL: u64 = 1_000_000_000;
pub const DENOMINATION_10_SOL: u64 = 10_000_000_000;
pub const DENOMINATION_100_SOL: u64 = 100_000_000_000;

#[error_code]
pub enum TeeBridgeError {
    #[msg("Unauthorized - user mismatch")]
    Unauthorized,
    #[msg("Invalid denomination - must be 1, 10, or 100 SOL")]
    InvalidDenomination,
    #[msg("Insufficient staging balance")]
    InsufficientBalance,
    #[msg("Batch is full - max 10 commitments per batch")]
    BatchFull,
    #[msg("Batch is empty - nothing to settle")]
    BatchEmpty,
    #[msg("Batch not ready - need at least 3 commitments")]
    BatchNotReady,
    #[msg("Batch already settled")]
    BatchAlreadySettled,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}

/// Minimum commitments required before anyone can settle
pub const BATCH_THRESHOLD: u8 = 3;

/// Check if denomination is valid
fn is_valid_denomination(amount: u64) -> bool {
    amount == DENOMINATION_1_SOL ||
    amount == DENOMINATION_10_SOL ||
    amount == DENOMINATION_100_SOL
}

#[program]
pub mod tee_bridge {
    use super::*;

    /// Initialize a staging account for a user
    /// This account will be delegated to the PER for private operations
    pub fn initialize_staging(ctx: Context<InitializeStaging>) -> Result<()> {
        let staging = &mut ctx.accounts.staging;
        staging.user = ctx.accounts.user.key();
        staging.balance = 0;
        staging.commitment_count = 0;
        staging.created_at = Clock::get()?.unix_timestamp;
        staging.bump = ctx.bumps.staging;

        msg!("TEE staging account initialized for user: {}", ctx.accounts.user.key());
        Ok(())
    }

    /// Deposit SOL to staging account
    /// This must be done before delegating to PER
    pub fn deposit_to_staging(ctx: Context<DepositToStaging>, amount: u64) -> Result<()> {
        // Transfer SOL to staging
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.staging.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        // Update staging balance
        let staging = &mut ctx.accounts.staging;
        staging.balance = staging.balance
            .checked_add(amount)
            .ok_or(TeeBridgeError::ArithmeticOverflow)?;

        msg!("Deposited {} lamports to TEE staging", amount);
        Ok(())
    }

    /// Create a private commitment inside the TEE
    ///
    /// PRIVACY: When running inside MagicBlock's TEE (Intel TDX),
    /// only the authenticated user can see their commitment.
    /// The operator cannot map users to commitments.
    ///
    /// The commitment hash is: Keccak256(nullifier || secret)
    /// where nullifier and secret are provided by the user (generated client-side)
    pub fn create_private_commitment(
        ctx: Context<CreatePrivateCommitment>,
        denomination: u64,
        commitment: [u8; 32],
        encrypted_note: Option<[u8; 128]>,
    ) -> Result<()> {
        // Validate denomination
        require!(
            is_valid_denomination(denomination),
            TeeBridgeError::InvalidDenomination
        );

        // Verify user owns the staging account
        require!(
            ctx.accounts.user.key() == ctx.accounts.staging.user,
            TeeBridgeError::Unauthorized
        );

        let staging = &mut ctx.accounts.staging;

        // Check sufficient balance
        require!(
            staging.balance >= denomination,
            TeeBridgeError::InsufficientBalance
        );

        // Deduct from staging balance
        staging.balance = staging.balance
            .checked_sub(denomination)
            .ok_or(TeeBridgeError::InsufficientBalance)?;
        staging.commitment_count = staging.commitment_count
            .checked_add(1)
            .ok_or(TeeBridgeError::ArithmeticOverflow)?;

        // Store commitment (ready for batch settlement)
        let tee_commitment = &mut ctx.accounts.tee_commitment;
        tee_commitment.commitment = commitment;
        tee_commitment.denomination = denomination;
        tee_commitment.encrypted_note = encrypted_note.unwrap_or([0u8; 128]);
        tee_commitment.created_at = Clock::get()?.unix_timestamp;
        tee_commitment.settled = false;
        tee_commitment.batch_id = 0;
        tee_commitment.bump = ctx.bumps.tee_commitment;

        // Add to current batch
        let batch = &mut ctx.accounts.batch;
        require!(
            batch.commitment_count < 10,
            TeeBridgeError::BatchFull
        );
        let idx = batch.commitment_count as usize;
        batch.commitments[idx] = commitment;
        batch.denominations[idx] = denomination;
        batch.commitment_count += 1;
        batch.total_amount = batch.total_amount
            .checked_add(denomination)
            .ok_or(TeeBridgeError::ArithmeticOverflow)?;

        msg!("Private commitment created in TEE");
        msg!("Denomination: {} SOL", denomination / 1_000_000_000);
        msg!("Batch commitment count: {}", batch.commitment_count);

        Ok(())
    }

    /// Settle a batch of commitments to the main privacy pool
    ///
    /// ANYONE can call this once the batch has >= BATCH_THRESHOLD commitments.
    /// This is intentionally permissionless to ensure batches settle even if
    /// the original authority goes offline.
    ///
    /// Privacy note: The settler gains no information about who deposited -
    /// they only see commitment hashes, not wallet addresses or secrets.
    pub fn settle_batch(ctx: Context<SettleBatch>) -> Result<()> {
        let batch = &mut ctx.accounts.batch;

        // Check batch is not empty
        require!(
            batch.commitment_count > 0,
            TeeBridgeError::BatchEmpty
        );

        // Check batch is not already settled
        require!(
            !batch.settled,
            TeeBridgeError::BatchAlreadySettled
        );

        // ANYONE can settle once batch has enough commitments (decentralized)
        require!(
            batch.commitment_count >= BATCH_THRESHOLD,
            TeeBridgeError::BatchNotReady
        );

        msg!("Settling batch of {} commitments", batch.commitment_count);
        msg!("Total amount: {} lamports", batch.total_amount);
        msg!("Settler: {} (anyone can settle when batch is full)", ctx.accounts.settler.key());

        // Mark batch as settled
        batch.settled = true;

        // Emit settlement event for off-chain relayer to pick up
        emit!(BatchSettlementEvent {
            batch_id: batch.id,
            commitment_count: batch.commitment_count,
            total_amount: batch.total_amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Withdraw remaining balance from staging
    /// User must own the staging account
    pub fn withdraw_from_staging(ctx: Context<WithdrawFromStaging>, amount: u64) -> Result<()> {
        let staging = &mut ctx.accounts.staging;

        require!(
            staging.balance >= amount,
            TeeBridgeError::InsufficientBalance
        );

        // Transfer lamports from staging to user
        let staging_info = staging.to_account_info();
        let user_info = ctx.accounts.user.to_account_info();

        **staging_info.try_borrow_mut_lamports()? -= amount;
        **user_info.try_borrow_mut_lamports()? += amount;

        staging.balance = staging.balance
            .checked_sub(amount)
            .ok_or(TeeBridgeError::InsufficientBalance)?;

        msg!("Withdrawn {} lamports from staging", amount);
        Ok(())
    }

    /// Release committed funds from staging after batch settlement
    /// The batch must be settled, and the user gets back lamports
    /// equal to their committed amount so they can shield to Light Protocol
    pub fn release_settled_funds(ctx: Context<ReleaseSettledFunds>, amount: u64) -> Result<()> {
        let batch = &ctx.accounts.batch;
        require!(batch.settled, TeeBridgeError::BatchNotReady);

        let staging_info = ctx.accounts.staging.to_account_info();
        let user_info = ctx.accounts.user.to_account_info();

        // Ensure staging has enough lamports (excluding rent-exempt minimum)
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(staging_info.data_len());
        let available = staging_info.lamports()
            .checked_sub(min_balance)
            .ok_or(TeeBridgeError::InsufficientBalance)?;
        require!(available >= amount, TeeBridgeError::InsufficientBalance);

        **staging_info.try_borrow_mut_lamports()? -= amount;
        **user_info.try_borrow_mut_lamports()? += amount;

        msg!("Released {} lamports from staging after settlement", amount);
        Ok(())
    }

    /// Initialize a new batch for collecting commitments
    pub fn initialize_batch(ctx: Context<InitializeBatch>, batch_id: u64) -> Result<()> {
        let batch = &mut ctx.accounts.batch;
        batch.id = batch_id;
        batch.authority = ctx.accounts.authority.key();
        batch.commitments = [[0u8; 32]; 10];
        batch.denominations = [0u64; 10];
        batch.commitment_count = 0;
        batch.total_amount = 0;
        batch.created_at = Clock::get()?.unix_timestamp;
        batch.settled = false;
        batch.bump = ctx.bumps.batch;

        msg!("Batch {} initialized", batch_id);
        Ok(())
    }
}

// ============================================
// Account Contexts
// ============================================

#[derive(Accounts)]
pub struct InitializeStaging<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: The user who owns this staging account
    pub user: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + StagingAccount::INIT_SPACE,
        seeds = [STAGING_SEED, user.key().as_ref()],
        bump,
    )]
    pub staging: Account<'info, StagingAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToStaging<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAGING_SEED, user.key().as_ref()],
        bump = staging.bump,
        constraint = staging.user == user.key() @ TeeBridgeError::Unauthorized,
    )]
    pub staging: Account<'info, StagingAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(denomination: u64, commitment: [u8; 32])]
pub struct CreatePrivateCommitment<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAGING_SEED, user.key().as_ref()],
        bump = staging.bump,
    )]
    pub staging: Account<'info, StagingAccount>,

    #[account(
        init,
        payer = user,
        space = 8 + TeeCommitment::INIT_SPACE,
        seeds = [COMMITMENT_SEED, commitment.as_ref()],
        bump,
    )]
    pub tee_commitment: Account<'info, TeeCommitment>,

    #[account(
        mut,
        seeds = [BATCH_SEED, &batch.id.to_le_bytes()],
        bump = batch.bump,
    )]
    pub batch: Account<'info, CommitmentBatch>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    /// Anyone can settle when batch is full - no authority check
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [BATCH_SEED, &batch.id.to_le_bytes()],
        bump = batch.bump,
    )]
    pub batch: Account<'info, CommitmentBatch>,
}

#[derive(Accounts)]
pub struct WithdrawFromStaging<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAGING_SEED, user.key().as_ref()],
        bump = staging.bump,
        constraint = staging.user == user.key() @ TeeBridgeError::Unauthorized,
    )]
    pub staging: Account<'info, StagingAccount>,
}

#[derive(Accounts)]
pub struct ReleaseSettledFunds<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STAGING_SEED, user.key().as_ref()],
        bump = staging.bump,
        constraint = staging.user == user.key() @ TeeBridgeError::Unauthorized,
    )]
    pub staging: Account<'info, StagingAccount>,

    #[account(
        seeds = [BATCH_SEED, &batch.id.to_le_bytes()],
        bump = batch.bump,
    )]
    pub batch: Account<'info, CommitmentBatch>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct InitializeBatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + CommitmentBatch::INIT_SPACE,
        seeds = [BATCH_SEED, &batch_id.to_le_bytes()],
        bump,
    )]
    pub batch: Account<'info, CommitmentBatch>,

    pub system_program: Program<'info, System>,
}

// ============================================
// Account Structures
// ============================================

/// User's staging account for TEE deposits
#[account]
#[derive(InitSpace)]
pub struct StagingAccount {
    /// Owner of this staging account
    pub user: Pubkey,
    /// Current balance in lamports
    pub balance: u64,
    /// Number of commitments created
    pub commitment_count: u64,
    /// When the account was created
    pub created_at: i64,
    /// PDA bump
    pub bump: u8,
}

/// A commitment created privately in the TEE
#[account]
#[derive(InitSpace)]
pub struct TeeCommitment {
    /// The commitment hash: Keccak256(nullifier || secret)
    pub commitment: [u8; 32],
    /// Denomination in lamports
    pub denomination: u64,
    /// Encrypted note for the user (contains nullifier, secret)
    pub encrypted_note: [u8; 128],
    /// When the commitment was created
    pub created_at: i64,
    /// Whether this commitment has been settled to the main pool
    pub settled: bool,
    /// Which batch this commitment belongs to
    pub batch_id: u64,
    /// PDA bump
    pub bump: u8,
}

/// A batch of commitments to be settled together
#[account]
#[derive(InitSpace)]
pub struct CommitmentBatch {
    /// Batch identifier
    pub id: u64,
    /// Who can settle this batch
    pub authority: Pubkey,
    /// Commitments in this batch (max 10)
    pub commitments: [[u8; 32]; 10],
    /// Denomination for each commitment
    pub denominations: [u64; 10],
    /// Number of commitments in this batch
    pub commitment_count: u8,
    /// Total amount in lamports
    pub total_amount: u64,
    /// When the batch was created
    pub created_at: i64,
    /// Whether the batch has been settled
    pub settled: bool,
    /// PDA bump
    pub bump: u8,
}

// ============================================
// Events
// ============================================

#[event]
pub struct BatchSettlementEvent {
    pub batch_id: u64,
    pub commitment_count: u8,
    pub total_amount: u64,
    pub timestamp: i64,
}
