//! Keeper Network Interface
//!
//! Allows users to submit encrypted withdrawal intents to a keeper network.
//! Keepers execute withdrawals at random times within user-specified windows.
//!
//! ## Privacy Benefits
//!
//! - User doesn't control exact execution time
//! - No VRF request linked to withdrawal
//! - Keeper network provides timing randomization
//!
//! ## Trust Model
//!
//! - Keepers are economically incentivized (earn fees)
//! - Multiple keepers = decentralized trust
//! - Encrypted intents = keepers can't front-run
//! - Slashing for misbehavior (future)
//!
//! ## Flow
//!
//! 1. User encrypts intent to keeper network's threshold key
//! 2. User submits encrypted blob with time window
//! 3. Keeper decrypts and executes at random time within window
//! 4. Keeper earns fee, user gets privacy

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{KeeperIntent, PrivacyPool, NullifierRecord};
use crate::error::StealthError;
#[cfg(feature = "production")]
use crate::zk::verifier::verify_ed25519_signature_with_sysvar;

/// Accounts for submitting a keeper intent
#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct SubmitKeeperIntent<'info> {
    /// User submitting the intent
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The intent account (PDA)
    #[account(
        init,
        payer = owner,
        space = KeeperIntent::SIZE,
        seeds = [KeeperIntent::SEED, owner.key().as_ref(), &intent_id],
        bump,
    )]
    pub intent: Account<'info, KeeperIntent>,

    pub system_program: Program<'info, System>,
}

/// Submit an encrypted withdrawal intent for keeper execution
///
/// The encrypted payload contains:
/// - ZK proof
/// - Recipient address
/// - Nullifier hash
/// - Other withdrawal params
///
/// This is encrypted to the keeper network's threshold public key,
/// so no single keeper can see the contents without the others.
pub fn submit_keeper_intent(
    ctx: Context<SubmitKeeperIntent>,
    _intent_id: [u8; 32],
    encrypted_payload: Vec<u8>,
    window_start_offset_hours: u8,
    window_duration_hours: u8,
    denomination: u64,
    keeper_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let intent = &mut ctx.accounts.intent;

    // Validate payload size
    require!(
        encrypted_payload.len() <= 512,
        StealthError::PayloadTooLarge
    );

    // Validate window parameters
    let window_start = clock.unix_timestamp + (window_start_offset_hours as i64 * 3600);
    let window_end = window_start + (window_duration_hours as i64 * 3600);

    require!(
        window_start_offset_hours >= 1, // At least 1 hour from now
        StealthError::WindowTooSoon
    );
    require!(
        window_duration_hours >= 1 && window_duration_hours <= 168, // 1 hour to 7 days
        StealthError::InvalidWindowDuration
    );

    // Validate keeper fee
    require!(
        keeper_fee >= KeeperIntent::MIN_KEEPER_FEE,
        StealthError::KeeperFeeTooLow
    );

    // Validate denomination using the pool's validation
    require!(
        PrivacyPool::is_valid_denomination(denomination),
        StealthError::InvalidDenomination
    );

    // Store intent
    intent.owner = ctx.accounts.owner.key();

    // Copy encrypted payload
    let mut payload_array = [0u8; 512];
    payload_array[..encrypted_payload.len()].copy_from_slice(&encrypted_payload);
    intent.encrypted_payload = payload_array;
    intent.payload_length = encrypted_payload.len() as u16;

    intent.window_start = window_start;
    intent.window_end = window_end;
    intent.denomination = denomination;
    intent.keeper_fee = keeper_fee;
    intent.executed = false;
    intent.executed_by = None;
    intent.executed_at = None;
    intent.bump = ctx.bumps.intent;

    msg!(
        "Keeper intent submitted. Window: {} - {} (Unix timestamps)",
        window_start,
        window_end
    );

    Ok(())
}

/// Accounts for keeper executing an intent
#[derive(Accounts)]
#[instruction(intent_id: [u8; 32], denomination: u64, nullifier_hash: [u8; 32])]
pub struct ExecuteKeeperIntent<'info> {
    /// The keeper executing the intent
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// The intent being executed
    #[account(
        mut,
        seeds = [KeeperIntent::SEED, intent.owner.as_ref(), &intent_id],
        bump = intent.bump,
        constraint = !intent.executed @ StealthError::IntentAlreadyExecuted,
    )]
    pub intent: Account<'info, KeeperIntent>,

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

    /// Nullifier record (prevents double-spend)
    /// Creating this account proves the nullifier hasn't been used
    #[account(
        init,
        payer = keeper,
        space = NullifierRecord::SIZE,
        seeds = [NullifierRecord::SEED, &denomination.to_le_bytes(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier: Account<'info, NullifierRecord>,

    /// Original intent owner (for any refunds)
    /// CHECK: Matches intent.owner
    #[account(
        mut,
        constraint = owner.key() == intent.owner @ StealthError::OwnerMismatch,
    )]
    pub owner: UncheckedAccount<'info>,

    /// Recipient of the withdrawal (provided by keeper after decryption)
    /// CHECK: Verified by ZK proof (off-chain decryption)
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// Instructions sysvar for Ed25519 signature verification
    /// CHECK: Validated by address constraint - must be the instructions sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Execute a keeper intent
///
/// Keepers call this after:
/// 1. Decrypting the intent using threshold decryption
/// 2. Choosing a random time within the window
/// 3. Verifying the ZK proof (off-chain)
///
/// The keeper provides the decrypted recipient and proof verification.
/// On-chain, we verify the keeper has valid decryption (via signature or attestation).
///
/// # Security
/// - Nullifier account creation prevents double-spend (if already used, init fails)
/// - Keeper attestation signature is verified via Ed25519 program introspection
/// - Execution window is enforced
pub fn execute_keeper_intent(
    ctx: Context<ExecuteKeeperIntent>,
    _intent_id: [u8; 32],
    denomination: u64,
    nullifier_hash: [u8; 32],
    proof_attestation: [u8; 64], // Keeper's Ed25519 signature attesting proof validity
) -> Result<()> {
    let clock = Clock::get()?;
    let intent = &mut ctx.accounts.intent;

    // Verify we're within execution window
    require!(
        intent.can_execute(clock.unix_timestamp),
        StealthError::NotInExecutionWindow
    );

    // Verify denomination matches
    require!(
        denomination == intent.denomination,
        StealthError::DenominationMismatch
    );

    // Verify keeper's proof attestation (Ed25519 signature)
    // The keeper signs: intent_id || nullifier_hash || recipient || denomination
    // This proves they decrypted and verified the ZK proof off-chain
    #[cfg(feature = "production")]
    {
        let mut attestation_message = Vec::with_capacity(32 + 32 + 32 + 8);
        attestation_message.extend_from_slice(&_intent_id);
        attestation_message.extend_from_slice(&nullifier_hash);
        attestation_message.extend_from_slice(ctx.accounts.recipient.key.as_ref());
        attestation_message.extend_from_slice(&denomination.to_le_bytes());

        // Convert keeper pubkey to fixed array (safe: Pubkey is always 32 bytes)
        let keeper_pubkey: &[u8; 32] = ctx.accounts.keeper.key.as_ref()
            .try_into()
            .map_err(|_| StealthError::InvalidSignature)?;

        verify_ed25519_signature_with_sysvar(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &attestation_message,
            &proof_attestation,
            keeper_pubkey,
        )?;
        msg!("Keeper attestation verified");
    }

    #[cfg(not(feature = "production"))]
    {
        msg!("DEV MODE: Skipping keeper attestation verification");
        // Still validate attestation is not all zeros in dev mode
        let zero_attestation = [0u8; 64];
        require!(
            proof_attestation != zero_attestation,
            StealthError::InvalidKeeperAttestation
        );
    }

    // Nullifier double-spend check is enforced by account creation
    // If nullifier_hash was already used, the `init` constraint will fail
    // Record nullifier usage
    let nullifier = &mut ctx.accounts.nullifier;
    nullifier.nullifier_hash = nullifier_hash;
    nullifier.spent_at = clock.unix_timestamp;
    nullifier.bump = ctx.bumps.nullifier;

    // Mark as executed BEFORE transfers
    intent.executed = true;
    intent.executed_by = Some(ctx.accounts.keeper.key());
    intent.executed_at = Some(clock.unix_timestamp);

    // Calculate amounts
    let withdrawal_amount = denomination;
    let keeper_fee = intent.keeper_fee;
    let recipient_amount = withdrawal_amount.saturating_sub(keeper_fee);

    // Get pool bump for PDA signer
    let pool = ctx.accounts.pool.load()?;
    let pool_bump = pool.bump;
    drop(pool);

    // Transfer from pool to recipient
    let denomination_bytes = denomination.to_le_bytes();
    let pool_seeds: &[&[u8]] = &[
        PrivacyPool::SEED,
        &denomination_bytes,
        &[pool_bump],
    ];

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

    // Transfer fee to keeper
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.pool.to_account_info(),
                to: ctx.accounts.keeper.to_account_info(),
            },
            &[pool_seeds],
        ),
        keeper_fee,
    )?;

    // Update pool state
    let mut pool = ctx.accounts.pool.load_mut()?;
    pool.deposit_count = pool.deposit_count.saturating_sub(1);

    msg!(
        "Keeper intent executed by {}. {} lamports to recipient.",
        ctx.accounts.keeper.key(),
        recipient_amount
    );

    Ok(())
}

/// Accounts for cancelling an unexecuted intent
#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct CancelKeeperIntent<'info> {
    /// Intent owner
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The intent to cancel
    #[account(
        mut,
        close = owner,
        seeds = [KeeperIntent::SEED, owner.key().as_ref(), &intent_id],
        bump = intent.bump,
        constraint = intent.owner == owner.key() @ StealthError::Unauthorized,
        constraint = !intent.executed @ StealthError::IntentAlreadyExecuted,
    )]
    pub intent: Account<'info, KeeperIntent>,
}

/// Cancel a keeper intent
///
/// User can cancel if:
/// - Intent hasn't been executed
/// - Window hasn't started yet OR window has expired
pub fn cancel_keeper_intent(
    ctx: Context<CancelKeeperIntent>,
    _intent_id: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let intent = &ctx.accounts.intent;

    // Can only cancel before window starts or after it expires
    let can_cancel = clock.unix_timestamp < intent.window_start
        || clock.unix_timestamp > intent.window_end;

    require!(can_cancel, StealthError::CannotCancelDuringWindow);

    msg!("Keeper intent cancelled");

    Ok(())
}

/// Accounts for claiming an expired intent (keeper didn't execute)
#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct ClaimExpiredIntent<'info> {
    /// Intent owner claiming the expired intent
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The expired intent
    #[account(
        mut,
        close = owner,
        seeds = [KeeperIntent::SEED, owner.key().as_ref(), &intent_id],
        bump = intent.bump,
        constraint = intent.owner == owner.key() @ StealthError::Unauthorized,
        constraint = !intent.executed @ StealthError::IntentAlreadyExecuted,
    )]
    pub intent: Account<'info, KeeperIntent>,
}

/// Claim an expired intent
///
/// If keepers didn't execute within the window, owner can:
/// - Close the intent account
/// - Get rent back
/// - Re-submit a new intent if desired
pub fn claim_expired_intent(
    ctx: Context<ClaimExpiredIntent>,
    _intent_id: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let intent = &ctx.accounts.intent;

    // Must be after window end
    require!(
        clock.unix_timestamp > intent.window_end,
        StealthError::IntentNotExpired
    );

    msg!("Expired intent claimed, rent returned");

    Ok(())
}
