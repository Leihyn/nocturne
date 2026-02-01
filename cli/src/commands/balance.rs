//! Show total balance across all stealth addresses

use anyhow::Result;
use colored::Colorize;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
};
use borsh::BorshDeserialize;

use crate::config::load_keys;
use crate::crypto::{StealthKeys, scan_payment};

// Program ID (update after deployment)
const PROGRAM_ID: &str = "6CiqeSFEmghXeS4pnhDpR4j5VieDi81jDhfzaanaqpv8";

/// On-chain announcement structure
#[derive(BorshDeserialize, Debug)]
#[allow(dead_code)]
struct Announcement {
    pub ephemeral_pubkey: [u8; 32],
    pub stealth_address: Pubkey,
    pub amount: u64,
    pub token_mint: Pubkey,
    pub slot: u64,
    pub timestamp: i64,
    pub bump: u8,
}

pub async fn run(rpc_url: &str) -> Result<()> {
    println!("{}", "Calculating total stealth balance...".cyan());

    // Load stealth keys
    let stored_keys = load_keys()?;

    let scan_secret = hex::decode(&stored_keys.scan_secret)?;
    let spend_secret = hex::decode(&stored_keys.spend_secret)?;

    let mut scan_secret_arr = [0u8; 32];
    let mut spend_secret_arr = [0u8; 32];
    scan_secret_arr.copy_from_slice(&scan_secret);
    spend_secret_arr.copy_from_slice(&spend_secret);

    let keys = StealthKeys::from_secrets(&scan_secret_arr, &spend_secret_arr);

    // Connect to RPC
    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());

    let program_id: Pubkey = PROGRAM_ID.parse()?;
    let accounts = client.get_program_accounts(&program_id)?;

    let mut total_balance: u64 = 0;
    let mut address_count = 0;

    for (_pubkey, account) in accounts {
        if account.data.len() < 8 + 32 + 32 + 8 + 32 + 8 + 8 + 1 {
            continue;
        }

        if let Ok(announcement) = Announcement::try_from_slice(&account.data[8..]) {
            let payment_address_bytes = announcement.stealth_address.to_bytes();

            if scan_payment(&keys, &announcement.ephemeral_pubkey, &payment_address_bytes).is_some()
            {
                let balance = client
                    .get_balance(&announcement.stealth_address)
                    .unwrap_or(0);

                if balance > 0 {
                    total_balance += balance;
                    address_count += 1;
                }
            }
        }
    }

    println!();
    println!("{}", "Stealth Balance Summary".yellow().bold());
    println!();
    println!(
        "Total:     {} SOL",
        format!("{:.9}", total_balance as f64 / 1_000_000_000.0).green()
    );
    println!("Addresses: {} with balance", address_count);
    println!();

    if address_count > 0 {
        println!(
            "{}",
            "Use 'stealth scan' to see individual addresses.".dimmed()
        );
    }

    Ok(())
}
