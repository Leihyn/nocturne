//! Show configuration and key info

use anyhow::Result;
use colored::Colorize;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{commitment_config::CommitmentConfig, signer::Signer};

use crate::config::{load_keys, keys_file, stealth_dir, load_solana_keypair, format_meta_address};

pub fn run(rpc_url: &str) -> Result<()> {
    println!();
    println!("{}", "StealthSol Configuration".yellow().bold());
    println!();

    // Keys info
    println!("{}:", "Keys Directory".cyan());
    println!("  {}", stealth_dir().display());
    println!();

    if let Ok(stored_keys) = load_keys() {
        println!("{}", "Stealth Keys: CONFIGURED".green());

        let scan_pubkey = hex::decode(&stored_keys.scan_pubkey)?;
        let spend_pubkey = hex::decode(&stored_keys.spend_pubkey)?;

        let mut scan_pubkey_arr = [0u8; 32];
        let mut spend_pubkey_arr = [0u8; 32];
        scan_pubkey_arr.copy_from_slice(&scan_pubkey);
        spend_pubkey_arr.copy_from_slice(&spend_pubkey);

        println!("  Created: {}", stored_keys.created_at);
        println!(
            "  Meta-address: {}",
            format_meta_address(&scan_pubkey_arr, &spend_pubkey_arr)
        );
    } else {
        println!("{}", "Stealth Keys: NOT CONFIGURED".red());
        println!("  Run 'stealth keygen' to generate keys");
    }
    println!();

    // Solana keypair
    println!("{}:", "Solana Wallet".cyan());
    if let Ok(keypair) = load_solana_keypair(None) {
        println!("  Address: {}", keypair.pubkey());

        // Try to get balance
        let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());
        if let Ok(balance) = client.get_balance(&keypair.pubkey()) {
            println!("  Balance: {} SOL", balance as f64 / 1_000_000_000.0);
        }
    } else {
        println!("  {}", "NOT CONFIGURED".red());
        println!("  Run 'solana-keygen new' to create a wallet");
    }
    println!();

    // RPC info
    println!("{}:", "RPC Endpoint".cyan());
    println!("  {}", rpc_url);
    println!();

    // Program ID
    println!("{}:", "Program ID".cyan());
    println!("  StLthNnJdCYvVPDV8bwvJmMHhxjbj17PHT6gUiDCfYU");
    println!("  {}", "(Update after deployment)".dimmed());
    println!();

    // File locations
    println!("{}:", "File Locations".cyan());
    println!("  Keys:   {}", keys_file().display());
    println!(
        "  Wallet: {}",
        dirs::home_dir()
            .unwrap()
            .join(".config/solana/id.json")
            .display()
    );

    Ok(())
}
