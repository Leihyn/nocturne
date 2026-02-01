//! Key generation command with encrypted storage and mnemonic support

use anyhow::{Result, bail};
use colored::Colorize;

use crate::config::format_meta_address;
use crate::crypto::StealthKeys;
use crate::secure_storage::{SecureKeyStorage, KeyData, prompt_new_password};

/// Options for key generation
pub struct KeygenOptions {
    /// Force overwrite existing keys
    pub force: bool,
    /// Use mnemonic for key generation (allows recovery)
    pub with_mnemonic: bool,
    /// Import from existing mnemonic
    pub import_mnemonic: Option<String>,
    /// Passphrase for mnemonic (optional extra security)
    pub passphrase: Option<String>,
}

pub fn run(options: KeygenOptions) -> Result<()> {
    let storage = SecureKeyStorage::new(SecureKeyStorage::default_path());

    // Check for existing keys
    if storage.exists() && !options.force {
        bail!(
            "Stealth keys already exist. Use --force to overwrite.\n\
             Warning: Overwriting keys will make any existing stealth payments unrecoverable!"
        );
    }

    println!("{}", "=== StealthSol Key Generation ===".cyan().bold());
    println!();

    let (keys, mnemonic) = if let Some(ref mnemonic_phrase) = options.import_mnemonic {
        // Import from existing mnemonic
        println!("{}", "Importing keys from mnemonic phrase...".cyan());
        let passphrase = options.passphrase.as_deref().unwrap_or("");
        let keys = StealthKeys::from_mnemonic(mnemonic_phrase, passphrase)?;
        (keys, Some(mnemonic_phrase.clone()))
    } else if options.with_mnemonic {
        // Generate new mnemonic
        println!("{}", "Generating keys with recovery phrase...".cyan());
        let (keys, phrase) = StealthKeys::generate_with_mnemonic()?;
        (keys, Some(phrase))
    } else {
        // Generate random keys (no recovery possible)
        println!("{}", "Generating random keys (no recovery phrase)...".cyan());
        println!(
            "{}",
            "Warning: Without a recovery phrase, losing your password means losing your funds!".yellow()
        );
        println!();
        (StealthKeys::generate(), None)
    };

    // Get password for encryption
    println!();
    println!("{}", "Choose a strong password to encrypt your keys.".cyan());
    println!("{}", "Requirements: 8+ chars, uppercase, lowercase, and numbers".dimmed());
    println!();

    let password = prompt_new_password("Enter password: ")?;

    // Extract key data
    let (scan_secret, spend_secret) = keys.export_secrets();
    let (scan_pubkey, spend_pubkey) = keys.meta_address();

    let key_data = KeyData {
        scan_secret,
        spend_secret,
        scan_pubkey,
        spend_pubkey,
    };

    // Save encrypted
    storage.save(&key_data, &password)?;

    // Display results
    println!();
    println!("{}", "Keys generated and encrypted successfully!".green().bold());
    println!();

    // Show mnemonic if generated
    if let Some(ref phrase) = mnemonic {
        println!("{}", "=== RECOVERY PHRASE - WRITE THIS DOWN! ===".red().bold());
        println!();
        println!("{}", "┌────────────────────────────────────────────────────────────┐".yellow());

        // Display mnemonic words in a grid
        let words: Vec<&str> = phrase.split_whitespace().collect();
        for (i, chunk) in words.chunks(4).enumerate() {
            let line: String = chunk.iter().enumerate()
                .map(|(j, word)| format!("{:2}. {:<12}", i * 4 + j + 1, word))
                .collect::<Vec<_>>()
                .join(" ");
            println!("│ {} │", format!("{:<58}", line).yellow());
        }

        println!("{}", "└────────────────────────────────────────────────────────────┘".yellow());
        println!();
        println!("{}", "CRITICAL: Store this phrase securely OFFLINE!".red().bold());
        println!("{}", "Anyone with this phrase can recover your keys.".red());
        println!("{}", "You will NOT be shown this phrase again.".red());
        println!();
    }

    println!("{}:", "Scan Public Key".yellow());
    println!("  {}", hex::encode(scan_pubkey));
    println!();
    println!("{}:", "Spend Public Key".yellow());
    println!("  {}", hex::encode(spend_pubkey));
    println!();
    println!("{}:", "Meta-Address (share this to receive payments)".yellow());
    println!("  {}", format_meta_address(&scan_pubkey, &spend_pubkey));
    println!();
    println!(
        "{}",
        format!("Encrypted keys saved to: {:?}", SecureKeyStorage::default_path()).dimmed()
    );
    println!();

    if mnemonic.is_none() {
        println!(
            "{}",
            "IMPORTANT: You did not use a recovery phrase.".red().bold()
        );
        println!(
            "{}",
            "If you lose your password, your funds are PERMANENTLY LOST.".red()
        );
        println!(
            "{}",
            "Consider regenerating with --mnemonic for recovery capability.".yellow()
        );
    }

    Ok(())
}

/// Legacy run function for backwards compatibility
#[allow(dead_code)]
pub fn run_simple(force: bool) -> Result<()> {
    run(KeygenOptions {
        force,
        with_mnemonic: true, // Default to mnemonic for safety
        import_mnemonic: None,
        passphrase: None,
    })
}

// Tests require mocking interactive password input
// See cli/src/tests.rs for integration tests
