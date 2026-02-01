use anchor_lang::prelude::*;

/// Accounts for withdrawing from a stealth address
///
/// Note: The stealth address is a regular Solana account, not a PDA.
/// The recipient derives the private key off-chain using DKSAP and signs
/// the transaction directly. This instruction just helps with the withdrawal.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// The stealth address (signer proves they derived the private key)
    #[account(mut)]
    pub stealth_address: Signer<'info>,

    /// The destination wallet receiving the funds
    /// CHECK: Any valid account can receive SOL
    #[account(mut)]
    pub destination: AccountInfo<'info>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Withdraw all SOL from a stealth address
///
/// The recipient:
/// 1. Scans announcements to find payments addressed to them
/// 2. Derives the private key p = b + H(s·R) for matching addresses
/// 3. Signs this transaction with the derived key
///
/// Since the stealth address is the signer, this proves the caller
/// legitimately derived the spending key.
///
/// # Arguments
/// * None - withdraws entire balance minus rent
pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let stealth_account = &ctx.accounts.stealth_address;
    let destination = &ctx.accounts.destination;

    // Get the full balance
    let balance = stealth_account.lamports();

    // Leave minimum rent if needed or transfer all
    // Since stealth addresses are ephemeral, we transfer everything
    let transfer_amount = balance;

    // Transfer via direct lamport manipulation (more efficient than CPI)
    **stealth_account.to_account_info().try_borrow_mut_lamports()? -= transfer_amount;
    **destination.try_borrow_mut_lamports()? += transfer_amount;

    msg!(
        "Withdrawn {} lamports from {} to {}",
        transfer_amount,
        stealth_account.key(),
        destination.key()
    );

    Ok(())
}

/// Accounts for partial withdrawal from a stealth address
#[derive(Accounts)]
pub struct WithdrawPartial<'info> {
    /// The stealth address (signer)
    #[account(mut)]
    pub stealth_address: Signer<'info>,

    /// The destination wallet
    /// CHECK: Any valid account can receive SOL
    #[account(mut)]
    pub destination: AccountInfo<'info>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Withdraw a specific amount from a stealth address
///
/// # Arguments
/// * `amount` - Amount of lamports to withdraw
pub fn withdraw_partial(ctx: Context<WithdrawPartial>, amount: u64) -> Result<()> {
    let stealth_account = &ctx.accounts.stealth_address;
    let destination = &ctx.accounts.destination;

    require!(
        stealth_account.lamports() >= amount,
        crate::error::StealthError::InsufficientFunds
    );

    **stealth_account.to_account_info().try_borrow_mut_lamports()? -= amount;
    **destination.try_borrow_mut_lamports()? += amount;

    msg!(
        "Partial withdrawal: {} lamports from {} to {}",
        amount,
        stealth_account.key(),
        destination.key()
    );

    Ok(())
}
