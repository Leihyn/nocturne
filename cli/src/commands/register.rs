//! Register meta-address on-chain

use anyhow::{Result, Context};
use colored::Colorize;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    transaction::Transaction,
    system_program,
    signer::Signer,
};

use crate::config::{load_keys, load_solana_keypair, format_meta_address};

// Program ID (update after deployment)
const PROGRAM_ID: &str = "6CiqeSFEmghXeS4pnhDpR4j5VieDi81jDhfzaanaqpv8";

pub async fn run(rpc_url: &str, keypair_path: Option<&str>, label: &str) -> Result<()> {
    println!("{}", "Registering stealth meta-address on-chain...".cyan());

    // Load stealth keys
    let stored_keys = load_keys()?;
    let scan_pubkey = hex::decode(&stored_keys.scan_pubkey)?;
    let spend_pubkey = hex::decode(&stored_keys.spend_pubkey)?;

    let mut scan_pubkey_arr = [0u8; 32];
    let mut spend_pubkey_arr = [0u8; 32];
    scan_pubkey_arr.copy_from_slice(&scan_pubkey);
    spend_pubkey_arr.copy_from_slice(&spend_pubkey);

    // Load Solana keypair
    let payer = load_solana_keypair(keypair_path)?;

    // Connect to RPC
    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());

    // Check balance
    let balance = client.get_balance(&payer.pubkey())?;
    println!("Wallet balance: {} SOL", balance as f64 / 1_000_000_000.0);

    if balance < 10_000_000 {
        println!(
            "{}",
            "Warning: Low balance. You need SOL to pay for the transaction.".yellow()
        );
    }

    // Derive registry PDA
    let program_id: Pubkey = PROGRAM_ID.parse()?;
    let (registry_pda, _bump) = Pubkey::find_program_address(
        &[b"stealth_registry", payer.pubkey().as_ref()],
        &program_id,
    );

    // Prepare label (pad to 32 bytes)
    let mut label_bytes = [0u8; 32];
    let label_slice = label.as_bytes();
    let copy_len = label_slice.len().min(32);
    label_bytes[..copy_len].copy_from_slice(&label_slice[..copy_len]);

    // Build instruction data
    // Anchor discriminator for "register" + args
    let mut data = Vec::new();
    // Anchor instruction discriminator (first 8 bytes of sha256("global:register"))
    data.extend_from_slice(&[211, 124, 67, 15, 211, 194, 178, 240]); // register discriminator
    data.extend_from_slice(&scan_pubkey_arr);
    data.extend_from_slice(&spend_pubkey_arr);
    data.extend_from_slice(&label_bytes);

    let instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),  // owner (signer, mutable)
            AccountMeta::new(registry_pda, false),   // registry PDA
            AccountMeta::new_readonly(system_program::id(), false), // system program
        ],
        data,
    };

    // Build and send transaction
    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );

    println!("Sending transaction...");
    let signature = client
        .send_and_confirm_transaction(&transaction)
        .context("Failed to send transaction. Make sure the program is deployed.")?;

    println!();
    println!("{}", "Meta-address registered successfully!".green().bold());
    println!();
    println!("Transaction: {}", signature);
    println!("Registry PDA: {}", registry_pda);
    println!();
    println!("{}:", "Your stealth meta-address".yellow());
    println!(
        "  {}",
        format_meta_address(&scan_pubkey_arr, &spend_pubkey_arr)
    );
    println!();
    println!("{}", "Share this address to receive private payments!".dimmed());

    Ok(())
}
