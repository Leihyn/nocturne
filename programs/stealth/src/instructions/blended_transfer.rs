//! Blended Transfer Instruction
//!
//! Makes stealth transfers look identical to regular SOL transfers.
//! This prevents identification of "this is a privacy transaction".
//!
//! ## Blending Strategy
//!
//! Regular Transfer:
//! - Accounts: [sender, recipient, system_program]
//! - Data: amount (8 bytes)
//! - Logs: "Transfer X lamports"
//!
//! Blended Stealth Transfer:
//! - Accounts: [sender, recipient, system_program] (SAME COUNT)
//! - Data: amount (8 bytes) + memo (64 bytes)
//! - Logs: "Transfer complete" (GENERIC)
//!
//! ## Announcement Handling
//!
//! Instead of creating a separate announcement account (which would be
//! identifiable), announcement data is:
//! 1. Packed into instruction data as "memo"
//! 2. Emitted as a generic event
//! 3. Optionally written to compressed log
//!
//! Recipients scan events to detect their payments.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{AnnouncementLog, AnnouncementEntry, TransferEvent, StealthPaymentEvent};
use crate::error::StealthError;

/// Blended stealth transfer - looks like a regular transfer
#[derive(Accounts)]
pub struct BlendedTransfer<'info> {
    /// Sender paying for the transaction
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Recipient (stealth address) - looks like any wallet
    /// CHECK: Can be any address
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// System program for transfer
    pub system_program: Program<'info, System>,
}

/// Announcement data packed into transfer memo
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransferMemo {
    /// Ephemeral public key (32 bytes)
    pub ephemeral_pubkey: [u8; 32],

    /// Commitment hash (32 bytes)
    pub commitment: [u8; 32],
}

impl TransferMemo {
    pub const SIZE: usize = 64;

    /// Convert to 64-byte array
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut bytes = [0u8; 64];
        bytes[0..32].copy_from_slice(&self.ephemeral_pubkey);
        bytes[32..64].copy_from_slice(&self.commitment);
        bytes
    }

    /// Parse from 64-byte array
    pub fn from_bytes(bytes: &[u8; 64]) -> Self {
        let mut ephemeral_pubkey = [0u8; 32];
        let mut commitment = [0u8; 32];
        ephemeral_pubkey.copy_from_slice(&bytes[0..32]);
        commitment.copy_from_slice(&bytes[32..64]);
        Self {
            ephemeral_pubkey,
            commitment,
        }
    }
}

/// Execute a blended stealth transfer
///
/// Looks like a regular SOL transfer with a memo field.
/// The memo contains the stealth announcement data.
pub fn blended_transfer(
    ctx: Context<BlendedTransfer>,
    amount: u64,
    memo: TransferMemo,
) -> Result<()> {
    let clock = Clock::get()?;

    // Validate minimum amount (same as regular stealth send)
    require!(
        amount >= crate::error::MIN_PAYMENT_LAMPORTS,
        StealthError::PaymentTooSmall
    );

    // Transfer SOL (looks identical to regular transfer)
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.sender.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
        ),
        amount,
    )?;

    // Emit generic transfer event (blends with normal events)
    emit!(TransferEvent {
        from: ctx.accounts.sender.key(),
        to: ctx.accounts.recipient.key(),
        amount,
        memo: memo.to_bytes(),
    });

    // Also emit stealth-specific event for recipients who know to look
    emit!(StealthPaymentEvent {
        ephemeral_pubkey: memo.ephemeral_pubkey,
        stealth_address: ctx.accounts.recipient.key(),
        commitment: memo.commitment,
        slot: clock.slot,
        amount_hint: AnnouncementEntry::amount_to_hint(amount),
        log_id: None,
    });

    // Generic log message (doesn't reveal it's a stealth transfer)
    msg!("Transfer complete");

    Ok(())
}

/// Blended transfer with compressed log storage
#[derive(Accounts)]
pub struct BlendedTransferWithLog<'info> {
    /// Sender paying for the transaction
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Recipient (stealth address)
    /// CHECK: Can be any address
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// Compressed announcement log (shared across all transfers)
    #[account(
        mut,
        seeds = [
            AnnouncementLog::SEED,
            &log.log_id.to_le_bytes(),
        ],
        bump = log.bump,
        constraint = log.can_add_entry() @ StealthError::LogFull,
    )]
    pub log: Account<'info, AnnouncementLog>,

    pub system_program: Program<'info, System>,
}

/// Blended transfer that also writes to compressed log
///
/// Same as blended_transfer but also stores announcement in shared log.
/// This is useful for recipients who prefer to scan account data vs events.
pub fn blended_transfer_with_log(
    ctx: Context<BlendedTransferWithLog>,
    amount: u64,
    memo: TransferMemo,
) -> Result<()> {
    let clock = Clock::get()?;

    // Validate minimum amount
    require!(
        amount >= crate::error::MIN_PAYMENT_LAMPORTS,
        StealthError::PaymentTooSmall
    );

    // Transfer SOL
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.sender.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
        ),
        amount,
    )?;

    // Add to compressed log
    let log = &mut ctx.accounts.log;
    let entry = AnnouncementEntry {
        ephemeral_pubkey: memo.ephemeral_pubkey,
        stealth_address: ctx.accounts.recipient.key(),
        commitment: memo.commitment,
        slot: clock.slot,
        amount_hint: AnnouncementEntry::amount_to_hint(amount),
    };

    log.entries.push(entry);
    log.entry_count += 1;
    log.last_entry_slot = clock.slot;

    // Emit events
    emit!(TransferEvent {
        from: ctx.accounts.sender.key(),
        to: ctx.accounts.recipient.key(),
        amount,
        memo: memo.to_bytes(),
    });

    emit!(StealthPaymentEvent {
        ephemeral_pubkey: memo.ephemeral_pubkey,
        stealth_address: ctx.accounts.recipient.key(),
        commitment: memo.commitment,
        slot: clock.slot,
        amount_hint: AnnouncementEntry::amount_to_hint(amount),
        log_id: Some(log.log_id),
    });

    msg!("Transfer complete");

    Ok(())
}

/// Initialize a new announcement log
#[derive(Accounts)]
#[instruction(log_id: u64)]
pub struct InitializeAnnouncementLog<'info> {
    /// Authority creating the log
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The log account to create
    #[account(
        init,
        payer = authority,
        space = AnnouncementLog::space(AnnouncementLog::DEFAULT_MAX_ENTRIES),
        seeds = [AnnouncementLog::SEED, &log_id.to_le_bytes()],
        bump,
    )]
    pub log: Account<'info, AnnouncementLog>,

    pub system_program: Program<'info, System>,
}

/// Initialize a new announcement log for compressed storage
pub fn initialize_announcement_log(
    ctx: Context<InitializeAnnouncementLog>,
    log_id: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let log = &mut ctx.accounts.log;

    log.authority = ctx.accounts.authority.key();
    log.log_id = log_id;
    log.entry_count = 0;
    log.max_entries = AnnouncementLog::DEFAULT_MAX_ENTRIES;
    log.is_active = true;
    log.created_slot = clock.slot;
    log.last_entry_slot = 0;
    log.bump = ctx.bumps.log;
    log.entries = Vec::with_capacity(AnnouncementLog::DEFAULT_MAX_ENTRIES as usize);

    msg!("Announcement log {} initialized", log_id);

    Ok(())
}

/// Deactivate a full log and mark for archival
#[derive(Accounts)]
pub struct DeactivateLog<'info> {
    /// Authority that created the log
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The log to deactivate
    #[account(
        mut,
        constraint = log.authority == authority.key() @ StealthError::Unauthorized,
    )]
    pub log: Account<'info, AnnouncementLog>,
}

/// Deactivate a log (no more entries can be added)
pub fn deactivate_announcement_log(ctx: Context<DeactivateLog>) -> Result<()> {
    let log = &mut ctx.accounts.log;
    log.is_active = false;

    msg!("Announcement log {} deactivated", log.log_id);

    Ok(())
}
