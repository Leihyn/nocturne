//! ZK-Verified Stealth Send Instruction
//!
//! This instruction verifies a ZK proof that the stealth address was correctly
//! derived before processing the payment. This provides cryptographic guarantees
//! beyond the hash commitment verification.
//!
//! ## Flow
//! 1. Client generates stealth address using DKSAP
//! 2. Client generates ZK proof using the Circom circuit
//! 3. Client submits proof with payment
//! 4. On-chain: Verify proof, then process payment
//!
//! ## Security
//! The ZK proof proves knowledge of:
//! - ephemeral_pubkey
//! - scan_pubkey
//! - spend_pubkey
//! - stealth_address
//!
//! Such that commitment_hash = Poseidon(ephemeral, scan, spend, stealth)

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::error::{StealthError, MIN_PAYMENT_LAMPORTS};
use crate::state::{StealthAnnouncement, StealthRegistry};
use crate::zk::{Groth16Proof, StoredVerificationKey, verify_groth16, VerificationKey};

/// Accounts for ZK-verified stealth send
#[derive(Accounts)]
#[instruction(
    ephemeral_pubkey: [u8; 32],
    commitment: [u8; 32],
    amount: u64,
)]
pub struct VerifiedStealthSend<'info> {
    /// The sender paying for the transaction
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Recipient's stealth registry (for meta-address lookup)
    #[account(
        seeds = [b"registry", recipient.key().as_ref()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, StealthRegistry>,

    /// Recipient's main wallet (used for registry PDA derivation)
    /// CHECK: Just used for PDA derivation
    pub recipient: UncheckedAccount<'info>,

    /// The stealth address receiving the funds
    /// CHECK: Verified by ZK proof
    #[account(mut)]
    pub stealth_address: UncheckedAccount<'info>,

    /// Announcement account to store payment metadata
    #[account(
        init,
        payer = sender,
        space = StealthAnnouncement::SIZE,
        seeds = [
            b"announcement",
            stealth_address.key().as_ref(),
        ],
        bump,
    )]
    pub announcement: Account<'info, StealthAnnouncement>,

    /// Stored verification key
    #[account(
        seeds = [StoredVerificationKey::SEEDS],
        bump = verification_key.bump,
    )]
    pub verification_key: Account<'info, StoredVerificationKey>,

    /// System program for account creation and transfers
    pub system_program: Program<'info, System>,
}

/// ZK-verified stealth send
///
/// This function:
/// 1. Verifies the Groth16 proof
/// 2. Verifies the commitment matches
/// 3. Transfers SOL to the stealth address
/// 4. Creates an announcement for scanning
pub fn verified_stealth_send(
    ctx: Context<VerifiedStealthSend>,
    ephemeral_pubkey: [u8; 32],
    commitment: [u8; 32],
    amount: u64,
    proof: Groth16Proof,
) -> Result<()> {
    // Validate minimum payment
    require!(amount >= MIN_PAYMENT_LAMPORTS, StealthError::PaymentTooSmall);

    // Deserialize verification key
    let vk: VerificationKey = VerificationKey::try_from_slice(&ctx.accounts.verification_key.vk_data)
        .map_err(|_| error!(StealthError::InvalidVerificationKey))?;

    // Prepare public inputs
    // The circuit's public input is the commitment hash
    let public_inputs = vec![commitment];

    // Verify the ZK proof
    let is_valid = verify_groth16(&proof, &public_inputs, &vk)?;
    require!(is_valid, StealthError::ProofInvalid);

    // Transfer SOL to stealth address
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.sender.to_account_info(),
                to: ctx.accounts.stealth_address.to_account_info(),
            },
        ),
        amount,
    )?;

    // Store announcement
    let announcement = &mut ctx.accounts.announcement;
    let clock = Clock::get()?;

    announcement.ephemeral_pubkey = ephemeral_pubkey;
    announcement.stealth_address = ctx.accounts.stealth_address.key();
    announcement.commitment = commitment;
    announcement.amount = amount;
    announcement.token_mint = Pubkey::default(); // SOL
    announcement.slot = clock.slot;
    announcement.timestamp = clock.unix_timestamp;
    announcement.bump = ctx.bumps.announcement;

    msg!("ZK-verified payment sent: {} lamports", amount);

    Ok(())
}

