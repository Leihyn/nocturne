//! Display stealth meta-address

use anyhow::Result;
use colored::Colorize;

use crate::config::{load_keys, format_meta_address};

pub fn run() -> Result<()> {
    let stored_keys = load_keys()?;

    let scan_pubkey = hex::decode(&stored_keys.scan_pubkey)?;
    let spend_pubkey = hex::decode(&stored_keys.spend_pubkey)?;

    let mut scan_pubkey_arr = [0u8; 32];
    let mut spend_pubkey_arr = [0u8; 32];
    scan_pubkey_arr.copy_from_slice(&scan_pubkey);
    spend_pubkey_arr.copy_from_slice(&spend_pubkey);

    println!();
    println!("{}", "Your Stealth Meta-Address".yellow().bold());
    println!();
    println!(
        "{}",
        format_meta_address(&scan_pubkey_arr, &spend_pubkey_arr)
    );
    println!();
    println!("{}:", "Components".dimmed());
    println!("  Scan pubkey:  {}", hex::encode(&scan_pubkey_arr));
    println!("  Spend pubkey: {}", hex::encode(&spend_pubkey_arr));
    println!();
    println!(
        "{}",
        "Share the meta-address above to receive private payments.".dimmed()
    );

    Ok(())
}
