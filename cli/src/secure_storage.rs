//! Secure key storage with encryption at rest
//!
//! Uses AES-256-GCM for encryption and Argon2id for key derivation.
//! Keys are never stored in plaintext.

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use argon2::{
    password_hash::{rand_core::RngCore, SaltString},
    Argon2, PasswordHasher, PasswordVerifier,
};
use serde::{Deserialize, Serialize};
use anyhow::{Result, Context, bail};
use zeroize::Zeroize;
use std::fs;
use std::path::PathBuf;

/// Argon2 parameters for key derivation
const ARGON2_M_COST: u32 = 65536;  // 64 MB memory
const ARGON2_T_COST: u32 = 3;      // 3 iterations
const ARGON2_P_COST: u32 = 4;      // 4 parallel lanes

/// Encrypted key file format
#[derive(Serialize, Deserialize)]
pub struct EncryptedKeyFile {
    /// Version for future compatibility
    pub version: u8,
    /// Salt for Argon2 (base64)
    pub salt: String,
    /// Nonce for AES-GCM (base64)
    pub nonce: String,
    /// Encrypted data (base64)
    pub ciphertext: String,
    /// Password hash for verification (optional, using Argon2)
    pub password_hash: Option<String>,
    /// Creation timestamp
    pub created_at: String,
}

/// Unencrypted key data (internal use only)
#[derive(Serialize, Deserialize, Zeroize)]
#[zeroize(drop)]
pub struct KeyData {
    pub scan_secret: [u8; 32],
    pub spend_secret: [u8; 32],
    pub scan_pubkey: [u8; 32],
    pub spend_pubkey: [u8; 32],
}

impl EncryptedKeyFile {
    /// Encrypt key data with a password
    pub fn encrypt(data: &KeyData, password: &str) -> Result<Self> {
        // Generate random salt
        let salt = SaltString::generate(&mut OsRng);

        // Derive encryption key using Argon2id
        let argon2 = Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            argon2::Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
                .map_err(|e| anyhow::anyhow!("Argon2 params error: {}", e))?,
        );

        // Derive 32-byte key
        let mut key_bytes = [0u8; 32];
        argon2
            .hash_password_into(password.as_bytes(), salt.as_str().as_bytes(), &mut key_bytes)
            .map_err(|e| anyhow::anyhow!("Key derivation failed: {}", e))?;

        // Create cipher
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|e| anyhow::anyhow!("Cipher creation failed: {}", e))?;

        // Generate random nonce
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from(nonce_bytes);

        // Serialize key data
        let plaintext = serde_json::to_vec(data)?;

        // Encrypt
        let ciphertext = cipher
            .encrypt(&nonce, plaintext.as_ref())
            .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

        // Create password hash for verification (optional extra security)
        let password_hash = argon2
            .hash_password(password.as_bytes(), &salt)
            .ok()
            .map(|h| h.to_string());

        // Clear sensitive data
        key_bytes.zeroize();

        Ok(Self {
            version: 1,
            salt: salt.as_str().to_string(),
            nonce: b64::encode(&nonce_bytes),
            ciphertext: b64::encode(&ciphertext),
            password_hash,
            created_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// Decrypt key data with a password
    pub fn decrypt(&self, password: &str) -> Result<KeyData> {
        // Verify password if hash is present
        if let Some(ref hash) = self.password_hash {
            let parsed_hash = argon2::PasswordHash::new(hash)
                .map_err(|e| anyhow::anyhow!("Invalid password hash: {}", e))?;

            Argon2::default()
                .verify_password(password.as_bytes(), &parsed_hash)
                .map_err(|_| anyhow::anyhow!("Invalid password"))?;
        }

        // Derive encryption key
        let argon2 = Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            argon2::Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
                .map_err(|e| anyhow::anyhow!("Argon2 params error: {}", e))?,
        );

        let mut key_bytes = [0u8; 32];
        argon2
            .hash_password_into(password.as_bytes(), self.salt.as_bytes(), &mut key_bytes)
            .map_err(|e| anyhow::anyhow!("Key derivation failed: {}", e))?;

        // Create cipher
        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|e| anyhow::anyhow!("Cipher creation failed: {}", e))?;

        // Decode nonce and ciphertext
        let nonce_bytes = b64::decode(&self.nonce)
            .context("Invalid nonce encoding")?;
        let ciphertext = b64::decode(&self.ciphertext)
            .context("Invalid ciphertext encoding")?;

        if nonce_bytes.len() != 12 {
            bail!("Invalid nonce length");
        }

        let nonce_array: [u8; 12] = nonce_bytes.try_into()
            .map_err(|_| anyhow::anyhow!("Failed to convert nonce to array"))?;
        let nonce = Nonce::from(nonce_array);

        // Decrypt
        let plaintext = cipher
            .decrypt(&nonce, ciphertext.as_ref())
            .map_err(|_| anyhow::anyhow!("Decryption failed - wrong password or corrupted data"))?;

        // Clear sensitive data
        key_bytes.zeroize();

        // Deserialize
        let data: KeyData = serde_json::from_slice(&plaintext)
            .context("Failed to parse decrypted key data")?;

        Ok(data)
    }
}

/// Secure key storage manager
pub struct SecureKeyStorage {
    path: PathBuf,
}

impl SecureKeyStorage {
    /// Create a new secure key storage at the given path
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Get the default storage path
    pub fn default_path() -> PathBuf {
        dirs::home_dir()
            .expect("Could not find home directory")
            .join(".stealth")
            .join("keys.enc")
    }

    /// Check if encrypted keys exist
    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Save encrypted keys
    pub fn save(&self, data: &KeyData, password: &str) -> Result<()> {
        let encrypted = EncryptedKeyFile::encrypt(data, password)?;
        let json = serde_json::to_string_pretty(&encrypted)?;

        // Ensure directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Write with restrictive permissions
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(&self.path, &json)?;
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))?;
        }

        #[cfg(not(unix))]
        {
            fs::write(&self.path, &json)?;
        }

        Ok(())
    }

    /// Load and decrypt keys
    pub fn load(&self, password: &str) -> Result<KeyData> {
        let json = fs::read_to_string(&self.path)
            .context("Failed to read encrypted key file")?;

        let encrypted: EncryptedKeyFile = serde_json::from_str(&json)
            .context("Failed to parse encrypted key file")?;

        encrypted.decrypt(password)
    }

    /// Change the password for stored keys
    pub fn change_password(&self, old_password: &str, new_password: &str) -> Result<()> {
        let data = self.load(old_password)?;
        self.save(&data, new_password)?;
        Ok(())
    }

    /// Delete stored keys (requires password confirmation)
    pub fn delete(&self, password: &str) -> Result<()> {
        // Verify password first
        let _ = self.load(password)?;
        fs::remove_file(&self.path)?;
        Ok(())
    }
}

/// Password strength validation
pub fn validate_password_strength(password: &str) -> Result<()> {
    if password.len() < 8 {
        bail!("Password must be at least 8 characters");
    }

    let has_upper = password.chars().any(|c| c.is_uppercase());
    let has_lower = password.chars().any(|c| c.is_lowercase());
    let has_digit = password.chars().any(|c| c.is_numeric());

    if !has_upper || !has_lower || !has_digit {
        bail!("Password must contain uppercase, lowercase, and numeric characters");
    }

    Ok(())
}

/// Prompt for password securely (hides input)
pub fn prompt_password(prompt: &str) -> Result<String> {
    rpassword::prompt_password(prompt)
        .context("Failed to read password")
}

/// Prompt for password with confirmation
pub fn prompt_new_password(prompt: &str) -> Result<String> {
    let password = prompt_password(prompt)?;
    let confirm = prompt_password("Confirm password: ")?;

    if password != confirm {
        bail!("Passwords do not match");
    }

    validate_password_strength(&password)?;

    Ok(password)
}

// Base64 encoding/decoding helpers
mod b64 {
    use base64::{engine::general_purpose::STANDARD, Engine};

    pub fn encode(data: &[u8]) -> String {
        STANDARD.encode(data)
    }

    pub fn decode(s: &str) -> anyhow::Result<Vec<u8>> {
        STANDARD.decode(s).map_err(|e| anyhow::anyhow!("Base64 decode error: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let data = KeyData {
            scan_secret: [0x42; 32],
            spend_secret: [0x43; 32],
            scan_pubkey: [0x44; 32],
            spend_pubkey: [0x45; 32],
        };

        let password = "TestPassword123";

        let encrypted = EncryptedKeyFile::encrypt(&data, password).unwrap();
        let decrypted = encrypted.decrypt(password).unwrap();

        assert_eq!(data.scan_secret, decrypted.scan_secret);
        assert_eq!(data.spend_secret, decrypted.spend_secret);
        assert_eq!(data.scan_pubkey, decrypted.scan_pubkey);
        assert_eq!(data.spend_pubkey, decrypted.spend_pubkey);
    }

    #[test]
    fn test_wrong_password_fails() {
        let data = KeyData {
            scan_secret: [0x42; 32],
            spend_secret: [0x43; 32],
            scan_pubkey: [0x44; 32],
            spend_pubkey: [0x45; 32],
        };

        let password = "TestPassword123";
        let wrong_password = "WrongPassword123";

        let encrypted = EncryptedKeyFile::encrypt(&data, password).unwrap();
        let result = encrypted.decrypt(wrong_password);

        assert!(result.is_err());
    }

    #[test]
    fn test_password_validation() {
        assert!(validate_password_strength("short").is_err());
        assert!(validate_password_strength("alllowercase").is_err());
        assert!(validate_password_strength("ALLUPPERCASE").is_err());
        assert!(validate_password_strength("NoNumbers").is_err());
        assert!(validate_password_strength("ValidPass123").is_ok());
    }
}
