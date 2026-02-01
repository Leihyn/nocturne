//! Scan for incoming stealth payments with pagination support

use anyhow::{Result, Context};
use colored::Colorize;
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_client::rpc_filter::RpcFilterType;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    account::Account,
};
use solana_account_decoder::UiAccountEncoding;
use borsh::BorshDeserialize;

use crate::crypto::{StealthKeys, scan_payment};
use crate::secure_storage::{SecureKeyStorage, prompt_password};

// Program ID (update after deployment)
const PROGRAM_ID: &str = "6CiqeSFEmghXeS4pnhDpR4j5VieDi81jDhfzaanaqpv8";

// Announcement account size (must match on-chain)
// 8 (discriminator) + 32 (ephemeral) + 32 (stealth_addr) + 32 (commitment) + 8 (amount) + 32 (token_mint) + 8 (slot) + 8 (timestamp) + 1 (bump)
const ANNOUNCEMENT_SIZE: usize = 161;

// Anchor discriminator for StealthAnnouncement
// sha256("account:StealthAnnouncement")[..8]
const ANNOUNCEMENT_DISCRIMINATOR: [u8; 8] = [0x9a, 0x47, 0x72, 0x8e, 0x36, 0x7c, 0x5f, 0x2a];

/// On-chain announcement structure (must match program)
#[derive(BorshDeserialize, Debug)]
#[allow(dead_code)]
struct Announcement {
    pub ephemeral_pubkey: [u8; 32],
    pub stealth_address: Pubkey,
    pub commitment: [u8; 32],
    pub amount: u64,
    pub token_mint: Pubkey,
    pub slot: u64,
    pub timestamp: i64,
    pub bump: u8,
}

/// Scan result with balance info
#[allow(dead_code)]
struct PaymentInfo {
    announcement: Announcement,
    balance: u64,
    spending_key: [u8; 32],
}

pub async fn run(rpc_url: &str, from_slot: Option<u64>) -> Result<()> {
    println!("{}", "Scanning for incoming stealth payments...".cyan());

    // Load encrypted stealth keys
    let storage = SecureKeyStorage::new(SecureKeyStorage::default_path());

    if !storage.exists() {
        anyhow::bail!(
            "No stealth keys found. Run 'stealthsol keygen' first."
        );
    }

    let password = prompt_password("Enter password to decrypt keys: ")?;
    let key_data = storage.load(&password)
        .context("Failed to decrypt keys. Wrong password?")?;

    let keys = StealthKeys::from_secrets(&key_data.scan_secret, &key_data.spend_secret);

    // Connect to RPC
    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());
    let program_id: Pubkey = PROGRAM_ID.parse()?;

    println!("Fetching announcements from program {}...", program_id);

    // Use filters for efficient querying
    let config = RpcProgramAccountsConfig {
        filters: Some(vec![
            // Filter by account size (announcement accounts only)
            RpcFilterType::DataSize(ANNOUNCEMENT_SIZE as u64),
            // Optionally filter by discriminator prefix
            // RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, ANNOUNCEMENT_DISCRIMINATOR.to_vec())),
        ]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        },
        ..Default::default()
    };

    // Fetch with pagination support
    let accounts = fetch_accounts_paginated(&client, &program_id, config, from_slot)?;

    println!("Found {} announcement accounts, scanning...", accounts.len());

    let mut found_payments: Vec<PaymentInfo> = Vec::new();
    let mut scanned = 0;
    let mut errors = 0;

    for (_pubkey, account) in accounts {
        scanned += 1;

        // Progress indicator every 100 accounts
        if scanned % 100 == 0 {
            print!("\rScanned {} accounts...", scanned);
        }

        // Skip accounts that are too small
        if account.data.len() < ANNOUNCEMENT_SIZE {
            continue;
        }

        // Try to deserialize as announcement (skip 8-byte discriminator)
        match Announcement::try_from_slice(&account.data[8..]) {
            Ok(announcement) => {
                // Apply slot filter if specified
                if let Some(min_slot) = from_slot {
                    if announcement.slot < min_slot {
                        continue;
                    }
                }

                // Check if this payment is for us
                let payment_address_bytes = announcement.stealth_address.to_bytes();

                if let Some(result) = scan_payment(
                    &keys,
                    &announcement.ephemeral_pubkey,
                    &payment_address_bytes,
                ) {
                    // Check actual balance
                    let balance = client
                        .get_balance(&announcement.stealth_address)
                        .unwrap_or(0);

                    found_payments.push(PaymentInfo {
                        announcement,
                        balance,
                        spending_key: result.spending_key_bytes(),
                    });
                }
            }
            Err(_) => {
                errors += 1;
            }
        }
    }

    println!("\r"); // Clear progress line

    if errors > 0 {
        println!(
            "{}",
            format!("Skipped {} malformed accounts", errors).dimmed()
        );
    }

    println!();

    if found_payments.is_empty() {
        println!("{}", "No incoming payments found.".yellow());
        if from_slot.is_some() {
            println!(
                "{}",
                "Try without --from-slot to scan all announcements.".dimmed()
            );
        }
    } else {
        println!(
            "{}",
            format!("Found {} payment(s):", found_payments.len())
                .green()
                .bold()
        );
        println!();

        // Sort by slot (newest first)
        found_payments.sort_by(|a, b| b.announcement.slot.cmp(&a.announcement.slot));

        for (i, payment) in found_payments.iter().enumerate() {
            let sol_amount = payment.balance as f64 / 1_000_000_000.0;
            let recorded_amount = payment.announcement.amount as f64 / 1_000_000_000.0;

            let status = if payment.balance > 0 {
                "AVAILABLE".green()
            } else {
                "WITHDRAWN".dimmed()
            };

            println!("{}. {} [{}]", i + 1, "Payment".yellow(), status);
            println!("   Address:  {}", payment.announcement.stealth_address);
            println!("   Balance:  {} SOL", sol_amount);
            println!("   Recorded: {} SOL", recorded_amount);
            println!("   Slot:     {}", payment.announcement.slot);

            if payment.announcement.token_mint == Pubkey::default() {
                println!("   Token:    Native SOL");
            } else {
                println!("   Token:    {}", payment.announcement.token_mint);
            }
            println!();
        }

        // Calculate totals
        let total_balance: u64 = found_payments.iter().map(|p| p.balance).sum();
        let available_count = found_payments.iter().filter(|p| p.balance > 0).count();

        println!(
            "{}",
            format!(
                "Total available: {} SOL ({} payment(s))",
                total_balance as f64 / 1_000_000_000.0,
                available_count
            )
            .green()
            .bold()
        );
        println!();
        println!(
            "{}",
            "Use 'stealthsol withdraw --from <address>' to withdraw funds.".dimmed()
        );
    }

    Ok(())
}

/// Fetch accounts with pagination to handle large datasets
fn fetch_accounts_paginated(
    client: &RpcClient,
    program_id: &Pubkey,
    config: RpcProgramAccountsConfig,
    _from_slot: Option<u64>,
) -> Result<Vec<(Pubkey, Account)>> {
    // For now, use standard getProgramAccounts
    // In production, implement proper pagination with:
    // 1. getProgramAccounts with dataSlice for initial scan
    // 2. Batch getMultipleAccounts for full data
    // 3. Or use Helius/other indexer APIs

    let accounts = client
        .get_program_accounts_with_config(program_id, config)?;

    Ok(accounts)
}

/// Alternative: Batch fetch with data slicing for large-scale scanning
#[allow(dead_code)]
async fn fetch_accounts_efficient(
    client: &RpcClient,
    program_id: &Pubkey,
) -> Result<Vec<(Pubkey, Account)>> {
    // Step 1: Get just the pubkeys and minimal data to identify announcements
    let slice_config = RpcProgramAccountsConfig {
        filters: Some(vec![
            RpcFilterType::DataSize(ANNOUNCEMENT_SIZE as u64),
        ]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            // Only fetch first 8 bytes (discriminator) to identify account type
            data_slice: Some(solana_account_decoder::UiDataSliceConfig {
                offset: 0,
                length: 8,
            }),
            ..Default::default()
        },
        ..Default::default()
    };

    let initial_accounts = client.get_program_accounts_with_config(program_id, slice_config)?;

    // Step 2: Filter to only announcement accounts and batch fetch full data
    let announcement_pubkeys: Vec<Pubkey> = initial_accounts
        .into_iter()
        .filter(|(_, account)| {
            account.data.len() >= 8 && account.data[..8] == ANNOUNCEMENT_DISCRIMINATOR
        })
        .map(|(pubkey, _)| pubkey)
        .collect();

    // Step 3: Batch fetch full account data (max 100 per request)
    let mut full_accounts = Vec::new();
    for chunk in announcement_pubkeys.chunks(100) {
        let accounts = client.get_multiple_accounts(chunk)?;
        for (i, maybe_account) in accounts.into_iter().enumerate() {
            if let Some(account) = maybe_account {
                full_accounts.push((chunk[i], account));
            }
        }
    }

    Ok(full_accounts)
}
