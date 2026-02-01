//! Send SOL to a stealth address

use anyhow::{Result, Context, bail};
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

use crate::config::{load_solana_keypair, parse_meta_address};
use crate::crypto::{compute_stealth_address, compute_commitment, MIN_PAYMENT_LAMPORTS};

// Program ID (update after deployment)
const PROGRAM_ID: &str = "6CiqeSFEmghXeS4pnhDpR4j5VieDi81jDhfzaanaqpv8";

pub async fn run(
    rpc_url: &str,
    keypair_path: Option<&str>,
    recipient: &str,
    amount_sol: f64,
) -> Result<()> {
    println!("{}", "Preparing stealth payment...".cyan());

    // Convert SOL to lamports
    let amount_lamports = (amount_sol * 1_000_000_000.0) as u64;

    // Check minimum amount
    if amount_lamports < MIN_PAYMENT_LAMPORTS {
        bail!(
            "Payment amount too small. Minimum is {} SOL ({} lamports)",
            MIN_PAYMENT_LAMPORTS as f64 / 1_000_000_000.0,
            MIN_PAYMENT_LAMPORTS
        );
    }

    // Parse recipient meta-address
    let (scan_pubkey, spend_pubkey) = parse_meta_address(recipient)
        .context("Invalid meta-address format")?;

    // Compute stealth address
    let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
        .context("Failed to compute stealth address")?;

    let stealth_address = Pubkey::new_from_array(computation.stealth_pubkey);

    // Compute commitment for verification
    let commitment = compute_commitment(
        &computation.ephemeral_pubkey,
        &scan_pubkey,
        &spend_pubkey,
        &computation.stealth_pubkey,
    );

    println!("Stealth address: {}", stealth_address);
    println!("Ephemeral key:   {}", hex::encode(computation.ephemeral_pubkey));
    println!("Commitment:      {}", hex::encode(&commitment[..8]));

    // Load Solana keypair
    let payer = load_solana_keypair(keypair_path)?;

    // Connect to RPC
    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());

    // Check balance
    let balance = client.get_balance(&payer.pubkey())?;
    // Account for rent + fees (~0.003 SOL)
    let required = amount_lamports + 5_000_000;
    if balance < required {
        println!(
            "{}",
            format!(
                "Insufficient balance. Have {} SOL, need {} SOL + fees",
                balance as f64 / 1_000_000_000.0,
                amount_sol
            )
            .red()
        );
        return Ok(());
    }

    // Build instruction
    let program_id: Pubkey = PROGRAM_ID.parse()?;

    // Derive announcement PDA
    let (announcement_pda, _bump) = Pubkey::find_program_address(
        &[b"announcement", &computation.ephemeral_pubkey],
        &program_id,
    );

    // Anchor discriminator for "stealth_send_direct" + args
    // Updated to include commitment parameter
    let mut data = Vec::new();
    // stealth_send_direct discriminator (sha256("global:stealth_send_direct")[..8])
    data.extend_from_slice(&[167, 164, 101, 181, 45, 250, 185, 115]);
    data.extend_from_slice(&scan_pubkey);
    data.extend_from_slice(&spend_pubkey);
    data.extend_from_slice(&computation.ephemeral_pubkey);
    data.extend_from_slice(&commitment);
    data.extend_from_slice(&amount_lamports.to_le_bytes());

    let instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),      // sender
            AccountMeta::new(stealth_address, false),    // stealth_address
            AccountMeta::new(announcement_pda, false),   // announcement
            AccountMeta::new_readonly(system_program::id(), false), // system_program
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

    println!("Sending {} SOL...", amount_sol);
    let signature = client
        .send_and_confirm_transaction(&transaction)
        .context("Failed to send transaction. Make sure the program is deployed.")?;

    println!();
    println!("{}", "Payment sent successfully!".green().bold());
    println!();
    println!("Transaction: {}", signature);
    println!("Amount:      {} SOL", amount_sol);
    println!("Stealth addr: {}", stealth_address);
    println!();
    println!(
        "{}",
        "The recipient can scan for this payment using their stealth keys.".dimmed()
    );

    Ok(())
}
