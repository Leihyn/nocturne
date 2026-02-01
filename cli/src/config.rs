//! Configuration and key storage for StealthSol CLI
//!
//! Note: Some functions kept for backwards compatibility or future use.

use std::path::PathBuf;
use std::fs;
use anyhow::{Result, Context, bail};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// Default directory for stealth keys
const STEALTH_DIR: &str = ".stealth";
const KEYS_FILE: &str = "keys.json";

/// Stored stealth keys (encrypted at rest in production)
#[derive(Serialize, Deserialize, Clone)]
pub struct StoredKeys {
    /// Scan secret key (hex encoded)
    pub scan_secret: String,
    /// Spend secret key (hex encoded)
    pub spend_secret: String,
    /// Scan public key (hex encoded)
    pub scan_pubkey: String,
    /// Spend public key (hex encoded)
    pub spend_pubkey: String,
    /// Creation timestamp
    pub created_at: String,
}

impl Drop for StoredKeys {
    fn drop(&mut self) {
        self.scan_secret.zeroize();
        self.spend_secret.zeroize();
    }
}

/// Get the stealth directory path
pub fn stealth_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(STEALTH_DIR)
}

/// Get the keys file path
pub fn keys_file() -> PathBuf {
    stealth_dir().join(KEYS_FILE)
}

/// Check if keys exist
pub fn keys_exist() -> bool {
    keys_file().exists()
}

/// Save keys to disk
pub fn save_keys(keys: &StoredKeys) -> Result<()> {
    let dir = stealth_dir();
    fs::create_dir_all(&dir).context("Failed to create stealth directory")?;

    let path = keys_file();
    let json = serde_json::to_string_pretty(keys)?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&path, &json)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(not(unix))]
    {
        fs::write(&path, &json)?;
    }

    Ok(())
}

/// Load keys from disk
pub fn load_keys() -> Result<StoredKeys> {
    let path = keys_file();
    if !path.exists() {
        bail!("No stealth keys found. Run 'stealth keygen' first.");
    }

    let json = fs::read_to_string(&path).context("Failed to read keys file")?;
    let keys: StoredKeys = serde_json::from_str(&json).context("Failed to parse keys file")?;

    Ok(keys)
}

/// Load Solana keypair from file or default location
pub fn load_solana_keypair(path: Option<&str>) -> Result<solana_sdk::signature::Keypair> {
    let keypair_path = match path {
        Some(p) => PathBuf::from(p),
        None => {
            // Default Solana keypair location
            dirs::home_dir()
                .expect("Could not find home directory")
                .join(".config")
                .join("solana")
                .join("id.json")
        }
    };

    if !keypair_path.exists() {
        bail!(
            "Solana keypair not found at {:?}. Generate one with 'solana-keygen new' or specify path with --keypair",
            keypair_path
        );
    }

    let keypair_bytes = fs::read_to_string(&keypair_path)?;
    let bytes: Vec<u8> = serde_json::from_str(&keypair_bytes)?;
    let keypair = solana_sdk::signature::Keypair::from_bytes(&bytes)?;

    Ok(keypair)
}

/// Format a meta-address for display
pub fn format_meta_address(scan_pubkey: &[u8; 32], spend_pubkey: &[u8; 32]) -> String {
    let mut combined = [0u8; 64];
    combined[..32].copy_from_slice(scan_pubkey);
    combined[32..].copy_from_slice(spend_pubkey);
    format!("stealth:{}", bs58::encode(&combined).into_string())
}

/// Parse a meta-address from string
pub fn parse_meta_address(input: &str) -> Result<([u8; 32], [u8; 32])> {
    let encoded = input.strip_prefix("stealth:").unwrap_or(input);
    let bytes = bs58::decode(encoded).into_vec()?;

    if bytes.len() != 64 {
        bail!("Invalid meta-address length: expected 64 bytes, got {}", bytes.len());
    }

    let mut scan_pubkey = [0u8; 32];
    let mut spend_pubkey = [0u8; 32];
    scan_pubkey.copy_from_slice(&bytes[..32]);
    spend_pubkey.copy_from_slice(&bytes[32..]);

    Ok((scan_pubkey, spend_pubkey))
}
