//! Export view key (scan-only capability)

use anyhow::Result;
use colored::Colorize;

use crate::config::load_keys;

pub fn run() -> Result<()> {
    let stored_keys = load_keys()?;

    println!();
    println!("{}", "View Key Export".yellow().bold());
    println!();
    println!(
        "{}",
        "The view key allows scanning for payments WITHOUT spending capability.".dimmed()
    );
    println!(
        "{}",
        "Share this with accountants/auditors who need to see your transactions.".dimmed()
    );
    println!();
    println!("{}:", "View Key (scan secret + spend pubkey)".yellow());
    println!();

    // View key = scan secret + spend public key
    // This allows detecting payments but not spending
    let view_key = format!("{}:{}", stored_keys.scan_secret, stored_keys.spend_pubkey);
    println!("  {}", view_key);
    println!();

    println!(
        "{}",
        "WARNING: Anyone with this key can see all your incoming payments!".red()
    );
    println!("{}", "         They CANNOT spend your funds.".green());

    Ok(())
}
