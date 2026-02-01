//! Withdraw funds from a stealth address

use anyhow::{Result, Context, bail};
use colored::Colorize;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    transaction::Transaction,
    system_instruction,
    signer::Signer,
};
use borsh::BorshDeserialize;

use crate::config::load_solana_keypair;
use crate::crypto::{StealthKeys, scan_payment};
use crate::secure_storage::{SecureKeyStorage, prompt_password};

// Program ID (update after deployment)
const PROGRAM_ID: &str = "6CiqeSFEmghXeS4pnhDpR4j5VieDi81jDhfzaanaqpv8";

/// On-chain announcement structure - MUST match on-chain definition exactly
#[derive(BorshDeserialize, Debug)]
#[allow(dead_code)]
struct Announcement {
    /// Ephemeral public key (R = r·G) published by sender
    pub ephemeral_pubkey: [u8; 32],
    /// The derived stealth address that received the payment
    pub stealth_address: Pubkey,
    /// Commitment hash (SHA256 of payment params)
    pub commitment: [u8; 32],
    /// Amount sent in lamports
    pub amount: u64,
    /// Token mint (Pubkey::default() for native SOL)
    pub token_mint: Pubkey,
    /// Block slot when the payment was made
    pub slot: u64,
    /// Unix timestamp of the payment
    pub timestamp: i64,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl Announcement {
    /// Expected size of announcement account data (after discriminator)
    const SIZE: usize = 32 + 32 + 32 + 8 + 32 + 8 + 8 + 1; // 153 bytes
}

pub async fn run(
    rpc_url: &str,
    keypair_path: Option<&str>,
    from_address: &str,
    to_address: Option<&str>,
    amount: Option<f64>,
) -> Result<()> {
    println!("{}", "Preparing withdrawal...".cyan());

    // Parse stealth address
    let stealth_pubkey: Pubkey = from_address
        .parse()
        .context("Invalid stealth address")?;

    // Load encrypted stealth keys
    let storage = SecureKeyStorage::new(SecureKeyStorage::default_path());

    if !storage.exists() {
        bail!(
            "No stealth keys found. Run 'stealthsol keygen' first.\n\
             Or if you have a recovery phrase, use 'stealthsol keygen --import-mnemonic <phrase>'"
        );
    }

    // Prompt for password
    let password = prompt_password("Enter password to decrypt keys: ")?;
    let key_data = storage.load(&password)
        .context("Failed to decrypt keys. Wrong password?")?;

    let keys = StealthKeys::from_secrets(&key_data.scan_secret, &key_data.spend_secret);

    // Connect to RPC
    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());

    // Find the announcement for this stealth address
    let program_id: Pubkey = PROGRAM_ID.parse()?;
    let accounts = client.get_program_accounts(&program_id)?;

    println!("Searching {} program accounts for announcement...", accounts.len());

    let mut found_announcement = None;

    for (_pubkey, account) in accounts {
        // Account must have discriminator (8) + announcement data
        if account.data.len() < 8 + Announcement::SIZE {
            continue;
        }

        // Try to deserialize (skip 8-byte discriminator)
        if let Ok(announcement) = Announcement::try_from_slice(&account.data[8..]) {
            if announcement.stealth_address == stealth_pubkey {
                found_announcement = Some(announcement);
                break;
            }
        }
    }

    let announcement = found_announcement
        .context("Could not find announcement for this stealth address. \
                  Are you sure this address received a stealth payment?")?;

    println!("Found announcement: {} lamports sent at slot {}",
             announcement.amount, announcement.slot);

    // Derive spending key using DKSAP
    let payment_address_bytes = announcement.stealth_address.to_bytes();
    let scan_result = scan_payment(
        &keys,
        &announcement.ephemeral_pubkey,
        &payment_address_bytes,
    )
    .context("This stealth address doesn't belong to you - \
              could not derive matching spending key")?;

    // Create signer from derived spending key (uses proper ed25519 signing)
    let stealth_signer = scan_result.create_signer()
        .map_err(|e| anyhow::anyhow!("Failed to create signer: {}", e))?;

    // Verify the signer matches the stealth address
    if stealth_signer.pubkey() != stealth_pubkey {
        bail!(
            "Derived keypair pubkey doesn't match stealth address!\n\
             Expected: {}\n\
             Got: {}\n\
             This is a bug - please report it.",
            stealth_pubkey,
            stealth_signer.pubkey()
        );
    }

    // Determine destination
    let destination = match to_address {
        Some(addr) => addr.parse().context("Invalid destination address")?,
        None => {
            // Use the main wallet as destination
            let payer = load_solana_keypair(keypair_path)?;
            payer.pubkey()
        }
    };

    // Get current balance
    let balance = client.get_balance(&stealth_pubkey)?;
    println!("Stealth address balance: {} SOL", balance as f64 / 1_000_000_000.0);

    if balance == 0 {
        println!("{}", "No funds to withdraw.".yellow());
        return Ok(());
    }

    // Determine amount to withdraw
    // Need to leave enough for transaction fee if not withdrawing all
    let fee_estimate = 5_000; // 0.000005 SOL

    let withdraw_lamports = match amount {
        Some(sol) => {
            let lamports = (sol * 1_000_000_000.0) as u64;
            if lamports + fee_estimate > balance {
                bail!(
                    "Insufficient balance. Have {} SOL, need {} SOL + fee",
                    balance as f64 / 1_000_000_000.0,
                    sol
                );
            }
            lamports
        }
        None => {
            // Withdraw all (minus fee for the transaction)
            if balance <= fee_estimate {
                bail!("Balance too low to cover transaction fee");
            }
            balance - fee_estimate
        }
    };

    // Build transfer instruction
    let instruction = system_instruction::transfer(
        &stealth_pubkey,
        &destination,
        withdraw_lamports,
    );

    // Build and sign transaction with stealth signer
    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&stealth_pubkey),
        &[&stealth_signer],
        recent_blockhash,
    );

    println!();
    println!("Withdrawing {} SOL to {}...",
             withdraw_lamports as f64 / 1_000_000_000.0,
             destination);

    let signature = client
        .send_and_confirm_transaction(&transaction)
        .context("Failed to send withdrawal transaction")?;

    println!();
    println!("{}", "Withdrawal successful!".green().bold());
    println!();
    println!("Transaction: {}", signature);
    println!("Amount:      {} SOL", withdraw_lamports as f64 / 1_000_000_000.0);
    println!("From:        {}", stealth_pubkey);
    println!("To:          {}", destination);

    Ok(())
}
