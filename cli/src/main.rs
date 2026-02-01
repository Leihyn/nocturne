//! StealthSol CLI - Command line interface for stealth address operations

// Clippy allows for the CLI crate
// op_ref warnings are common with curve25519-dalek ergonomics
#![allow(clippy::op_ref)]
#![allow(clippy::needless_borrows_for_generic_args)]
#![allow(clippy::needless_borrow)]
#![allow(clippy::redundant_closure)]
#![allow(clippy::redundant_locals)]
#![allow(dead_code)] // Public API items may not be used internally
#![allow(unused_variables)]
#![allow(unused_mut)]

use clap::{Parser, Subcommand};
use anyhow::Result;

mod commands;
mod config;
mod crypto;
mod secure_storage;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod test_vectors;

#[cfg(test)]
mod fuzz_tests;

#[cfg(test)]
mod integration_tests;

use commands::*;

#[derive(Parser)]
#[command(name = "stealthsol")]
#[command(author = "StealthSol Team")]
#[command(version = "0.1.0")]
#[command(about = "Stealth Address Protocol for Solana - Private payments using DKSAP")]
#[command(long_about = r#"
StealthSol enables private payments on Solana using stealth addresses.

Each payment creates a unique one-time address that only you can link
to your identity. Share your meta-address publicly, receive payments
privately.

Quick Start:
  1. stealthsol keygen           Generate your stealth keys
  2. stealthsol register         Register on-chain
  3. stealthsol scan             Check for incoming payments
  4. stealthsol withdraw         Withdraw received funds
"#)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Solana RPC URL
    #[arg(long, global = true, default_value = "https://api.devnet.solana.com")]
    rpc_url: String,

    /// Path to keypair file
    #[arg(long, global = true)]
    keypair: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Generate new stealth key pairs (scan + spend keys)
    Keygen {
        /// Force overwrite existing keys
        #[arg(short, long)]
        force: bool,

        /// Generate with recovery phrase (recommended)
        #[arg(short, long, default_value = "true")]
        mnemonic: bool,

        /// Import from existing recovery phrase
        #[arg(long)]
        import_mnemonic: Option<String>,

        /// Passphrase for mnemonic (optional extra security)
        #[arg(long)]
        passphrase: Option<String>,
    },

    /// Register your stealth meta-address on-chain
    Register {
        /// Optional label for your meta-address (max 32 chars)
        #[arg(short, long, default_value = "")]
        label: String,
    },

    /// Show your stealth meta-address
    Address,

    /// Send SOL to a stealth meta-address
    Send {
        /// Recipient's meta-address (base58 encoded or stealth:... format)
        #[arg(short, long)]
        to: String,

        /// Amount of SOL to send
        #[arg(short, long)]
        amount: f64,
    },

    /// Scan for incoming stealth payments
    Scan {
        /// Start from this slot (default: scan all)
        #[arg(long)]
        from_slot: Option<u64>,
    },

    /// Withdraw funds from a stealth address
    Withdraw {
        /// Stealth address to withdraw from (from scan results)
        #[arg(short, long)]
        from: String,

        /// Destination address (default: your main wallet)
        #[arg(short, long)]
        to: Option<String>,

        /// Amount to withdraw in SOL (default: full balance)
        #[arg(short, long)]
        amount: Option<f64>,
    },

    /// Show total balance across all stealth addresses
    Balance,

    /// Export view key (scan-only, no spending capability)
    ExportViewKey,

    /// Show configuration and key info
    Info,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Keygen { force, mnemonic, import_mnemonic, passphrase } => {
            keygen::run(keygen::KeygenOptions {
                force,
                with_mnemonic: mnemonic,
                import_mnemonic,
                passphrase,
            })?;
        }
        Commands::Register { label } => {
            register::run(&cli.rpc_url, cli.keypair.as_deref(), &label).await?;
        }
        Commands::Address => {
            address::run()?;
        }
        Commands::Send { to, amount } => {
            send::run(&cli.rpc_url, cli.keypair.as_deref(), &to, amount).await?;
        }
        Commands::Scan { from_slot } => {
            scan::run(&cli.rpc_url, from_slot).await?;
        }
        Commands::Withdraw { from, to, amount } => {
            withdraw::run(&cli.rpc_url, cli.keypair.as_deref(), &from, to.as_deref(), amount).await?;
        }
        Commands::Balance => {
            balance::run(&cli.rpc_url).await?;
        }
        Commands::ExportViewKey => {
            export_view_key::run()?;
        }
        Commands::Info => {
            info::run(&cli.rpc_url)?;
        }
    }

    Ok(())
}
