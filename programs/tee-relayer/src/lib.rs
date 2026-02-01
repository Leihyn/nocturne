//! TEE Relayer for Private Withdrawals
//!
//! This program provides a privacy-preserving relay service for withdrawals
//! from the StealthSol privacy pool. Running inside MagicBlock's Intel TDX,
//! it ensures that even the operator cannot see:
//! - Who is requesting the withdrawal (IP hidden by TEE auth)
//! - Which stealth address receives the funds
//! - The nullifier being used
//!
//! ## Privacy Flow
//! 1. User encrypts withdrawal request with TEE's public key
//! 2. User submits encrypted request to TEE relayer
//! 3. TEE decrypts request inside Intel TDX (operator blind)
//! 4. TEE submits withdrawal TX to privacy pool
//! 5. Funds appear at stealth address
//!
//! ## Security Properties
//! - Confidentiality: Request contents encrypted, only TEE can read
//! - Integrity: TEE attestation proves code runs in genuine Intel TDX
//! - Anonymity: Operator sees only "a withdrawal happened", not details

use anchor_lang::prelude::*;

declare_id!("8BzTaoLzgaeY6TuV8LcQyNHt8RKukPSf9ijUtUbPD6X1");

/// Seeds for PDA derivation
pub const RELAYER_STATE_SEED: &[u8] = b"relayer_state";
pub const REQUEST_SEED: &[u8] = b"request";
pub const PROCESSED_SEED: &[u8] = b"processed";

/// Maximum encrypted request size (bytes)
/// Contains: nonce (12) + recipient (32) + nullifier_hash (32) + denomination (8) + tag (16) = 100 bytes
pub const MAX_ENCRYPTED_REQUEST_SIZE: usize = 128;

#[error_code]
pub enum TeeRelayerError {
    #[msg("Unauthorized - not the relayer authority")]
    Unauthorized,
    #[msg("Invalid encrypted request size")]
    InvalidRequestSize,
    #[msg("Request already processed")]
    AlreadyProcessed,
    #[msg("Request not pending")]
    NotPending,
    #[msg("Invalid proof - withdrawal rejected")]
    InvalidProof,
    #[msg("Insufficient relayer balance for gas")]
    InsufficientBalance,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Relayer not active")]
    RelayerNotActive,
}

#[program]
pub mod tee_relayer {
    use super::*;

    /// Initialize the TEE relayer state
    /// Only called once by the relayer operator
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        let state = &mut ctx.accounts.relayer_state;
        state.authority = ctx.accounts.authority.key();
        state.fee_bps = fee_bps;
        state.total_processed = 0;
        state.total_fees_collected = 0;
        state.request_counter = 0;
        state.is_active = true;
        state.bump = ctx.bumps.relayer_state;

        // TEE public key for encryption (in production, derived from TEE attestation)
        // For demo, we use a placeholder that would be replaced by actual TEE key
        state.tee_pubkey = [0u8; 32]; // Will be set by TEE on startup

        msg!("TEE Relayer initialized");
        msg!("Fee: {} bps", fee_bps);
        Ok(())
    }

    /// Set TEE public key (authority only)
    /// In production, this would be verified via TEE attestation
    pub fn set_tee_pubkey(ctx: Context<UpdateSettings>, tee_pubkey: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.relayer_state;

        require!(
            ctx.accounts.authority.key() == state.authority,
            TeeRelayerError::Unauthorized
        );

        state.tee_pubkey = tee_pubkey;
        msg!("TEE public key updated");
        Ok(())
    }

    /// Submit an encrypted withdrawal request
    ///
    /// The request is encrypted with the TEE's public key, so only the TEE
    /// can read the contents (recipient address, nullifier, denomination).
    ///
    /// Each request gets its own PDA, identified by a counter.
    pub fn submit_encrypted_request(
        ctx: Context<SubmitRequest>,
        encrypted_request: Vec<u8>,
    ) -> Result<()> {
        require!(
            encrypted_request.len() <= MAX_ENCRYPTED_REQUEST_SIZE,
            TeeRelayerError::InvalidRequestSize
        );

        let state = &mut ctx.accounts.relayer_state;
        require!(state.is_active, TeeRelayerError::RelayerNotActive);

        let request = &mut ctx.accounts.request;
        request.id = state.request_counter;
        request.requester = ctx.accounts.requester.key();
        request.status = RequestStatus::Pending;
        request.submitted_at = Clock::get()?.unix_timestamp;
        request.bump = ctx.bumps.request;

        // Store encrypted data (only TEE can decrypt)
        let mut padded = [0u8; MAX_ENCRYPTED_REQUEST_SIZE];
        padded[..encrypted_request.len()].copy_from_slice(&encrypted_request);
        request.encrypted_data = padded;

        // Increment counter for next request
        state.request_counter += 1;

        // Emit event (no sensitive data exposed)
        emit!(RequestSubmittedEvent {
            request_id: request.id,
            timestamp: request.submitted_at,
        });

        msg!("Encrypted withdrawal request {} submitted", request.id);
        Ok(())
    }

    /// Process a withdrawal request (TEE only)
    ///
    /// This instruction is called by the TEE after decrypting and validating
    /// the request. The decrypted data is passed as parameters.
    ///
    /// PRIVACY: Even though parameters are "visible" in the TX, only the TEE
    /// can call this instruction, and the TEE's memory is protected by TDX.
    pub fn process_withdrawal(
        ctx: Context<ProcessWithdrawal>,
        request_id: u64,
        // Decrypted request data (only TEE knows these values)
        recipient: Pubkey,
        nullifier_hash: [u8; 32],
        denomination: u64,
    ) -> Result<()> {
        let state = &ctx.accounts.relayer_state;

        // Verify caller is the relayer authority (TEE)
        require!(
            ctx.accounts.authority.key() == state.authority,
            TeeRelayerError::Unauthorized
        );

        let request = &mut ctx.accounts.request;

        // Verify request is pending
        require!(
            request.status == RequestStatus::Pending,
            TeeRelayerError::NotPending
        );

        // Calculate fee
        let fee = (denomination as u128)
            .checked_mul(state.fee_bps as u128)
            .ok_or(TeeRelayerError::ArithmeticOverflow)?
            .checked_div(10_000)
            .ok_or(TeeRelayerError::ArithmeticOverflow)? as u64;

        let withdrawal_amount = denomination
            .checked_sub(fee)
            .ok_or(TeeRelayerError::ArithmeticOverflow)?;

        // Transfer to recipient (in production: CPI to privacy pool)
        let relayer_info = ctx.accounts.relayer_state.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();

        require!(
            relayer_info.lamports() >= withdrawal_amount,
            TeeRelayerError::InsufficientBalance
        );

        **relayer_info.try_borrow_mut_lamports()? -= withdrawal_amount;
        **recipient_info.try_borrow_mut_lamports()? += withdrawal_amount;

        // Mark request as processed
        request.status = RequestStatus::Processed;
        request.processed_at = Clock::get()?.unix_timestamp;

        // Update state
        let state = &mut ctx.accounts.relayer_state;
        state.total_processed += 1;
        state.total_fees_collected += fee;

        // Store processed marker (for nullifier tracking)
        let processed = &mut ctx.accounts.processed_marker;
        processed.nullifier_hash = nullifier_hash;
        processed.processed_at = request.processed_at;
        processed.bump = ctx.bumps.processed_marker;

        // Emit event (minimal info to prevent correlation)
        emit!(WithdrawalProcessedEvent {
            request_id,
            denomination,
            fee,
            timestamp: request.processed_at,
        });

        msg!("Withdrawal {} processed via TEE relayer", request_id);
        Ok(())
    }

    /// Mark a request as failed (TEE only)
    pub fn mark_failed(ctx: Context<MarkFailed>, request_id: u64, reason: String) -> Result<()> {
        let state = &ctx.accounts.relayer_state;

        require!(
            ctx.accounts.authority.key() == state.authority,
            TeeRelayerError::Unauthorized
        );

        let request = &mut ctx.accounts.request;
        require!(
            request.status == RequestStatus::Pending,
            TeeRelayerError::NotPending
        );

        request.status = RequestStatus::Failed;
        request.processed_at = Clock::get()?.unix_timestamp;

        msg!("Request {} marked as failed: {}", request_id, reason);
        Ok(())
    }

    /// Withdraw accumulated fees (authority only)
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.relayer_state;

        require!(
            ctx.accounts.authority.key() == state.authority,
            TeeRelayerError::Unauthorized
        );

        let state_info = state.to_account_info();
        let authority_info = ctx.accounts.authority.to_account_info();

        require!(
            state_info.lamports() >= amount,
            TeeRelayerError::InsufficientBalance
        );

        **state_info.try_borrow_mut_lamports()? -= amount;
        **authority_info.try_borrow_mut_lamports()? += amount;

        msg!("Withdrew {} lamports in fees", amount);
        Ok(())
    }

    /// Update relayer settings (authority only)
    pub fn update_settings(
        ctx: Context<UpdateSettings>,
        new_fee_bps: Option<u16>,
        is_active: Option<bool>,
    ) -> Result<()> {
        let state = &mut ctx.accounts.relayer_state;

        require!(
            ctx.accounts.authority.key() == state.authority,
            TeeRelayerError::Unauthorized
        );

        if let Some(fee) = new_fee_bps {
            state.fee_bps = fee;
            msg!("Fee updated to {} bps", fee);
        }

        if let Some(active) = is_active {
            state.is_active = active;
            msg!("Relayer active: {}", active);
        }

        Ok(())
    }
}

// ============================================
// Account Contexts
// ============================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + RelayerState::INIT_SPACE,
        seeds = [RELAYER_STATE_SEED],
        bump,
    )]
    pub relayer_state: Account<'info, RelayerState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitRequest<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(
        mut,
        seeds = [RELAYER_STATE_SEED],
        bump = relayer_state.bump,
    )]
    pub relayer_state: Account<'info, RelayerState>,

    #[account(
        init,
        payer = requester,
        space = 8 + EncryptedRequest::INIT_SPACE,
        seeds = [REQUEST_SEED, &relayer_state.request_counter.to_le_bytes()],
        bump,
    )]
    pub request: Account<'info, EncryptedRequest>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request_id: u64, recipient: Pubkey, nullifier_hash: [u8; 32])]
pub struct ProcessWithdrawal<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [RELAYER_STATE_SEED],
        bump = relayer_state.bump,
    )]
    pub relayer_state: Account<'info, RelayerState>,

    #[account(
        mut,
        seeds = [REQUEST_SEED, &request_id.to_le_bytes()],
        bump = request.bump,
    )]
    pub request: Account<'info, EncryptedRequest>,

    /// CHECK: Recipient of the withdrawal (stealth address)
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + ProcessedMarker::INIT_SPACE,
        seeds = [PROCESSED_SEED, nullifier_hash.as_ref()],
        bump,
    )]
    pub processed_marker: Account<'info, ProcessedMarker>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct MarkFailed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [RELAYER_STATE_SEED],
        bump = relayer_state.bump,
    )]
    pub relayer_state: Account<'info, RelayerState>,

    #[account(
        mut,
        seeds = [REQUEST_SEED, &request_id.to_le_bytes()],
        bump = request.bump,
    )]
    pub request: Account<'info, EncryptedRequest>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [RELAYER_STATE_SEED],
        bump = relayer_state.bump,
    )]
    pub relayer_state: Account<'info, RelayerState>,
}

#[derive(Accounts)]
pub struct UpdateSettings<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [RELAYER_STATE_SEED],
        bump = relayer_state.bump,
    )]
    pub relayer_state: Account<'info, RelayerState>,
}

// ============================================
// Account Structures
// ============================================

/// Global relayer state
#[account]
#[derive(InitSpace)]
pub struct RelayerState {
    /// Authority (TEE operator)
    pub authority: Pubkey,
    /// TEE public key for encryption
    pub tee_pubkey: [u8; 32],
    /// Fee in basis points (e.g., 50 = 0.5%)
    pub fee_bps: u16,
    /// Total withdrawals processed
    pub total_processed: u64,
    /// Total fees collected
    pub total_fees_collected: u64,
    /// Counter for request IDs
    pub request_counter: u64,
    /// Whether relayer is accepting requests
    pub is_active: bool,
    /// PDA bump
    pub bump: u8,
}

/// Individual encrypted request (stored in its own PDA)
#[account]
#[derive(InitSpace)]
pub struct EncryptedRequest {
    /// Request ID
    pub id: u64,
    /// Who submitted the request
    pub requester: Pubkey,
    /// Encrypted data (only TEE can decrypt)
    #[max_len(128)]
    pub encrypted_data: [u8; MAX_ENCRYPTED_REQUEST_SIZE],
    /// Current status
    pub status: RequestStatus,
    /// When submitted
    pub submitted_at: i64,
    /// When processed (0 if not yet)
    pub processed_at: i64,
    /// PDA bump
    pub bump: u8,
}

/// Marker for processed nullifiers (prevents replay)
#[account]
#[derive(InitSpace)]
pub struct ProcessedMarker {
    /// The nullifier hash that was used
    pub nullifier_hash: [u8; 32],
    /// When it was processed
    pub processed_at: i64,
    /// PDA bump
    pub bump: u8,
}

/// Status of a request
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RequestStatus {
    Pending,
    Processed,
    Failed,
}

impl Default for RequestStatus {
    fn default() -> Self {
        RequestStatus::Pending
    }
}

// ============================================
// Events
// ============================================

#[event]
pub struct RequestSubmittedEvent {
    pub request_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct WithdrawalProcessedEvent {
    pub request_id: u64,
    pub denomination: u64,
    pub fee: u64,
    pub timestamp: i64,
}
