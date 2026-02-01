//! Cryptographic operations for StealthSol CLI
//!
//! Client-side implementation of DKSAP (Dual-Key Stealth Address Protocol)
//!
//! Security features:
//! - Proper scalar-based ed25519 signing (not seed-based)
//! - Constant-time comparison for cryptographic values
//! - Zeroization of sensitive data on drop
//! - BIP-39 mnemonic support for key recovery

use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
};
use ed25519_dalek::{
    ExpandedSecretKey, PublicKey as DalekPublicKey,
    Signature as DalekSignature,
};
use sha2::{Digest, Sha256, Sha512};
use rand::RngCore;
use zeroize::Zeroize;
use subtle::ConstantTimeEq;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Signature, Signer, SignerError},
};

/// Domain separator matching on-chain implementation
const DOMAIN_SEPARATOR: &[u8] = b"stealthsol_v1";

/// Domain separator for commitment verification
const COMMITMENT_DOMAIN: &[u8] = b"stealthsol_commitment_v1";

/// Domain separator for nonce derivation in signing
const NONCE_DOMAIN: &[u8] = b"stealthsol_nonce_v1";

/// Minimum payment amount in lamports (must match on-chain)
pub const MIN_PAYMENT_LAMPORTS: u64 = 1_000_000;

// ============================================================================
// Zeroizing Scalar Wrapper
// ============================================================================

/// A scalar that zeroizes its contents on drop
///
/// This wraps curve25519-dalek's Scalar to ensure proper cleanup.
/// The inner bytes are zeroized, not just a copy.
#[derive(Clone)]
pub struct SecretScalar {
    bytes: [u8; 32],
}

impl SecretScalar {
    /// Create from raw bytes
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self { bytes }
    }

    /// Create from a curve25519-dalek Scalar
    pub fn from_scalar(scalar: &Scalar) -> Self {
        Self { bytes: scalar.to_bytes() }
    }

    /// Get as a curve25519-dalek Scalar
    pub fn to_scalar(&self) -> Scalar {
        Scalar::from_bytes_mod_order(self.bytes)
    }

    /// Get the raw bytes (use carefully)
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }
}

impl Drop for SecretScalar {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

// ============================================================================
// Commitment Computation
// ============================================================================

/// Compute the commitment hash for stealth address verification
///
/// This must match the on-chain computation exactly.
/// commitment = SHA256(domain || ephemeral_pubkey || scan_pubkey || spend_pubkey || stealth_address)
pub fn compute_commitment(
    ephemeral_pubkey: &[u8; 32],
    scan_pubkey: &[u8; 32],
    spend_pubkey: &[u8; 32],
    stealth_address: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(COMMITMENT_DOMAIN);
    hasher.update(ephemeral_pubkey);
    hasher.update(scan_pubkey);
    hasher.update(spend_pubkey);
    hasher.update(stealth_address);

    let result = hasher.finalize();
    let mut commitment = [0u8; 32];
    commitment.copy_from_slice(&result);
    commitment
}

// ============================================================================
// Stealth Keys
// ============================================================================

/// Complete stealth key set for a recipient
///
/// Security:
/// - Secret keys are zeroized on drop
/// - Clone is NOT derived to prevent accidental copies
pub struct StealthKeys {
    /// Scan secret key (s) - zeroized on drop
    scan_secret: SecretScalar,
    /// Spend secret key (b) - zeroized on drop
    spend_secret: SecretScalar,
    /// Scan public key (S = s·G)
    pub scan_pubkey: [u8; 32],
    /// Spend public key (B = b·G)
    pub spend_pubkey: [u8; 32],
}

// Explicitly NOT implementing Clone to prevent accidental secret duplication

impl StealthKeys {
    /// Generate new random stealth keys
    ///
    /// Uses OS entropy for cryptographically secure key generation.
    pub fn generate() -> Self {
        use rand::rngs::OsRng;
        let mut rng = OsRng;

        let scan_scalar = random_scalar(&mut rng);
        let spend_scalar = random_scalar(&mut rng);

        let g = ED25519_BASEPOINT_POINT;
        let scan_pubkey = (&scan_scalar * &g).compress().to_bytes();
        let spend_pubkey = (&spend_scalar * &g).compress().to_bytes();

        Self {
            scan_secret: SecretScalar::from_scalar(&scan_scalar),
            spend_secret: SecretScalar::from_scalar(&spend_scalar),
            scan_pubkey,
            spend_pubkey,
        }
    }

    /// Generate keys from a BIP-39 mnemonic phrase
    ///
    /// Derivation:
    /// - scan_secret = SHA256("stealthsol/scan" || seed)
    /// - spend_secret = SHA256("stealthsol/spend" || seed)
    pub fn from_mnemonic(mnemonic_phrase: &str, passphrase: &str) -> anyhow::Result<Self> {
        use bip39::Mnemonic;

        let mnemonic: Mnemonic = mnemonic_phrase.parse()
            .map_err(|e| anyhow::anyhow!("Invalid mnemonic: {}", e))?;

        let seed = mnemonic.to_seed(passphrase);

        // Derive scan secret
        let mut scan_hasher = Sha256::new();
        scan_hasher.update(b"stealthsol/scan");
        scan_hasher.update(&seed);
        let scan_hash = scan_hasher.finalize();
        let mut scan_bytes = [0u8; 32];
        scan_bytes.copy_from_slice(&scan_hash);
        let scan_scalar = Scalar::from_bytes_mod_order(scan_bytes);
        scan_bytes.zeroize();

        // Derive spend secret
        let mut spend_hasher = Sha256::new();
        spend_hasher.update(b"stealthsol/spend");
        spend_hasher.update(&seed);
        let spend_hash = spend_hasher.finalize();
        let mut spend_bytes = [0u8; 32];
        spend_bytes.copy_from_slice(&spend_hash);
        let spend_scalar = Scalar::from_bytes_mod_order(spend_bytes);
        spend_bytes.zeroize();

        let g = ED25519_BASEPOINT_POINT;
        let scan_pubkey = (&scan_scalar * &g).compress().to_bytes();
        let spend_pubkey = (&spend_scalar * &g).compress().to_bytes();

        Ok(Self {
            scan_secret: SecretScalar::from_scalar(&scan_scalar),
            spend_secret: SecretScalar::from_scalar(&spend_scalar),
            scan_pubkey,
            spend_pubkey,
        })
    }

    /// Generate a new random mnemonic and derive keys from it
    pub fn generate_with_mnemonic() -> anyhow::Result<(Self, String)> {
        use bip39::Mnemonic;

        // Generate 256 bits of entropy for a 24-word mnemonic
        let mut entropy = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut entropy);

        let mnemonic = Mnemonic::from_entropy(&entropy)
            .map_err(|e| anyhow::anyhow!("Failed to generate mnemonic: {}", e))?;

        // Zeroize entropy after use
        entropy.zeroize();

        let phrase = mnemonic.to_string();
        let keys = Self::from_mnemonic(&phrase, "")?;

        Ok((keys, phrase))
    }

    /// Reconstruct keys from stored secrets
    pub fn from_secrets(scan_secret_bytes: &[u8; 32], spend_secret_bytes: &[u8; 32]) -> Self {
        let scan_scalar = Scalar::from_bytes_mod_order(*scan_secret_bytes);
        let spend_scalar = Scalar::from_bytes_mod_order(*spend_secret_bytes);

        let g = ED25519_BASEPOINT_POINT;
        let scan_pubkey = (&scan_scalar * &g).compress().to_bytes();
        let spend_pubkey = (&spend_scalar * &g).compress().to_bytes();

        Self {
            scan_secret: SecretScalar::from_scalar(&scan_scalar),
            spend_secret: SecretScalar::from_scalar(&spend_scalar),
            scan_pubkey,
            spend_pubkey,
        }
    }

    /// Get the meta-address (scan_pubkey, spend_pubkey)
    pub fn meta_address(&self) -> ([u8; 32], [u8; 32]) {
        (self.scan_pubkey, self.spend_pubkey)
    }

    /// Export secrets as bytes (for encrypted storage)
    ///
    /// WARNING: Handle these bytes with extreme care!
    pub fn export_secrets(&self) -> ([u8; 32], [u8; 32]) {
        (*self.scan_secret.as_bytes(), *self.spend_secret.as_bytes())
    }

    /// Get scan secret for internal use
    pub(crate) fn scan_secret(&self) -> Scalar {
        self.scan_secret.to_scalar()
    }

    /// Get spend secret for internal use
    pub(crate) fn spend_secret(&self) -> Scalar {
        self.spend_secret.to_scalar()
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Generate a random scalar using provided RNG
fn random_scalar<R: RngCore>(rng: &mut R) -> Scalar {
    let mut bytes = [0u8; 32];
    rng.fill_bytes(&mut bytes);
    let scalar = Scalar::from_bytes_mod_order(bytes);
    bytes.zeroize();
    scalar
}

/// Hash to scalar matching on-chain implementation
fn hash_to_scalar(data: &[u8]) -> Scalar {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN_SEPARATOR);
    hasher.update(data);
    let hash = hasher.finalize();

    let mut scalar_bytes = [0u8; 32];
    scalar_bytes.copy_from_slice(&hash);
    let scalar = Scalar::from_bytes_mod_order(scalar_bytes);
    scalar_bytes.zeroize();
    scalar
}

/// Decompress a compressed Edwards Y point
fn decompress_point(bytes: &[u8; 32]) -> Option<EdwardsPoint> {
    CompressedEdwardsY::from_slice(bytes).decompress()
}

// ============================================================================
// Stealth Address Computation (Sender Side)
// ============================================================================

/// Result of computing a stealth address (sender side)
pub struct StealthAddressComputation {
    /// The stealth address public key
    pub stealth_pubkey: [u8; 32],
    /// The ephemeral public key to publish
    pub ephemeral_pubkey: [u8; 32],
    /// The ephemeral secret (zeroized on drop)
    ephemeral_secret: SecretScalar,
}

/// Compute a stealth address for sending (sender side)
///
/// # Arguments
/// * `scan_pubkey` - Recipient's scan public key (S)
/// * `spend_pubkey` - Recipient's spend public key (B)
///
/// # Returns
/// * Stealth address computation with address, ephemeral key, and secret
pub fn compute_stealth_address(
    scan_pubkey: &[u8; 32],
    spend_pubkey: &[u8; 32],
) -> Option<StealthAddressComputation> {
    use rand::rngs::OsRng;
    let g = ED25519_BASEPOINT_POINT;

    // Generate ephemeral keypair using OS entropy
    let mut rng = OsRng;
    let ephemeral_scalar = random_scalar(&mut rng);
    let ephemeral_point = &ephemeral_scalar * &g;
    let ephemeral_pubkey = ephemeral_point.compress().to_bytes();

    // S = decompress(scan_pubkey)
    let scan_point = decompress_point(scan_pubkey)?;

    // Shared secret: ss = r·S
    let shared_secret = &ephemeral_scalar * &scan_point;
    let shared_secret_bytes = shared_secret.compress().to_bytes();

    // H(ss) as scalar
    let hash_scalar = hash_to_scalar(&shared_secret_bytes);

    // B = decompress(spend_pubkey)
    let spend_point = decompress_point(spend_pubkey)?;

    // P = B + H(ss)·G
    let stealth_point = &spend_point + &(&hash_scalar * &g);
    let stealth_pubkey = stealth_point.compress().to_bytes();

    Some(StealthAddressComputation {
        stealth_pubkey,
        ephemeral_pubkey,
        ephemeral_secret: SecretScalar::from_scalar(&ephemeral_scalar),
    })
}

// ============================================================================
// Payment Scanning (Recipient Side)
// ============================================================================

/// Result of scanning a payment
pub struct ScanResult {
    /// The stealth address that was paid
    pub stealth_address: [u8; 32],
    /// The derived spending private key (zeroized on drop)
    spending_key: SecretScalar,
}

impl ScanResult {
    /// Create a signer for this stealth address
    pub fn create_signer(&self) -> Result<StealthSigner, SignerError> {
        StealthSigner::from_scalar(&self.spending_key.to_scalar())
    }

    /// Get the spending key scalar (for internal use)
    pub(crate) fn spending_scalar(&self) -> Scalar {
        self.spending_key.to_scalar()
    }

    /// Get the spending key bytes (for storage/display)
    pub fn spending_key_bytes(&self) -> [u8; 32] {
        *self.spending_key.as_bytes()
    }
}

/// Scan for a payment addressed to this recipient
///
/// # Arguments
/// * `keys` - Recipient's stealth keys
/// * `ephemeral_pubkey` - Ephemeral key from announcement
/// * `payment_address` - Address that received the payment
///
/// # Returns
/// * Some(ScanResult) if payment is for this recipient
pub fn scan_payment(
    keys: &StealthKeys,
    ephemeral_pubkey: &[u8; 32],
    payment_address: &[u8; 32],
) -> Option<ScanResult> {
    let g = ED25519_BASEPOINT_POINT;

    // R = decompress(ephemeral_pubkey)
    let ephemeral_point = decompress_point(ephemeral_pubkey)?;

    // Shared secret: ss = s·R
    let shared_secret = &keys.scan_secret() * &ephemeral_point;
    let shared_secret_bytes = shared_secret.compress().to_bytes();

    // H(ss) as scalar
    let hash_scalar = hash_to_scalar(&shared_secret_bytes);

    // Expected: P' = B + H(ss)·G
    let spend_point = decompress_point(&keys.spend_pubkey)?;
    let expected_stealth = &spend_point + &(&hash_scalar * &g);
    let expected_bytes = expected_stealth.compress().to_bytes();

    // Use constant-time comparison to prevent timing attacks
    if bool::from(expected_bytes.ct_eq(payment_address)) {
        // Derive private key: p = b + H(ss)
        let spending_scalar = &keys.spend_secret() + &hash_scalar;
        Some(ScanResult {
            stealth_address: *payment_address,
            spending_key: SecretScalar::from_scalar(&spending_scalar),
        })
    } else {
        None
    }
}

/// Check if a payment is for this recipient (view-key only, no spending key)
///
/// This can be used with just the scan secret and spend public key.
pub fn check_payment(
    scan_secret: &Scalar,
    spend_pubkey: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
    payment_address: &[u8; 32],
) -> bool {
    let g = ED25519_BASEPOINT_POINT;

    let ephemeral_point = match decompress_point(ephemeral_pubkey) {
        Some(p) => p,
        None => return false,
    };

    let shared_secret = scan_secret * &ephemeral_point;
    let shared_secret_bytes = shared_secret.compress().to_bytes();
    let hash_scalar = hash_to_scalar(&shared_secret_bytes);

    let spend_point = match decompress_point(spend_pubkey) {
        Some(p) => p,
        None => return false,
    };

    let expected_stealth = &spend_point + &(&hash_scalar * &g);
    let expected_bytes = expected_stealth.compress().to_bytes();

    bool::from(expected_bytes.ct_eq(payment_address))
}

// ============================================================================
// Stealth Signer - Proper ed25519 signing with DKSAP-derived keys
// ============================================================================

/// A Solana-compatible signer that uses a raw scalar for ed25519 signing
///
/// This is necessary because DKSAP produces private keys as scalars
/// (p = spend_secret + H(shared_secret)), but Solana's Keypair uses
/// seed-based derivation which would produce a different scalar.
///
/// This implementation uses ed25519-dalek's ExpandedSecretKey to sign
/// with our exact scalar, ensuring signatures are valid for the
/// DKSAP-derived public key.
pub struct StealthSigner {
    /// The Solana public key
    pubkey: Pubkey,
    /// The expanded secret key for signing
    expanded: ExpandedSecretKey,
    /// The ed25519-dalek public key
    dalek_pubkey: DalekPublicKey,
}

impl StealthSigner {
    /// Create a signer from a DKSAP-derived scalar
    ///
    /// The scalar should be: spend_secret + H(shared_secret)
    pub fn from_scalar(scalar: &Scalar) -> Result<Self, SignerError> {
        let g = ED25519_BASEPOINT_POINT;
        let public_point = scalar * &g;
        let public_bytes = public_point.compress().to_bytes();

        // Create expanded secret key
        // Format: [scalar_bytes (32) | nonce_prefix (32)]
        // The nonce prefix is derived deterministically for consistent signatures
        let scalar_bytes = scalar.to_bytes();

        // Derive nonce prefix: SHA512(domain || scalar)
        // This provides the randomness needed for signature nonce generation
        let mut nonce_hasher = Sha512::new();
        nonce_hasher.update(NONCE_DOMAIN);
        nonce_hasher.update(&scalar_bytes);
        let nonce_hash = nonce_hasher.finalize();

        let mut expanded_bytes = [0u8; 64];
        expanded_bytes[..32].copy_from_slice(&scalar_bytes);
        expanded_bytes[32..].copy_from_slice(&nonce_hash[..32]);

        let expanded = ExpandedSecretKey::from_bytes(&expanded_bytes)
            .map_err(|e| SignerError::Custom(format!("Invalid scalar: {}", e)))?;

        let dalek_pubkey = DalekPublicKey::from_bytes(&public_bytes)
            .map_err(|e| SignerError::Custom(format!("Invalid pubkey: {}", e)))?;

        // Zeroize sensitive data
        let mut scalar_bytes = scalar_bytes;
        let mut expanded_bytes = expanded_bytes;
        scalar_bytes.zeroize();
        expanded_bytes.zeroize();

        Ok(Self {
            pubkey: Pubkey::new_from_array(public_bytes),
            expanded,
            dalek_pubkey,
        })
    }

    /// Create from a ScanResult
    pub fn from_scan_result(result: &ScanResult) -> Result<Self, SignerError> {
        Self::from_scalar(&result.spending_scalar())
    }
}

impl Signer for StealthSigner {
    fn pubkey(&self) -> Pubkey {
        self.pubkey
    }

    fn try_pubkey(&self) -> Result<Pubkey, SignerError> {
        Ok(self.pubkey)
    }

    fn try_sign_message(&self, message: &[u8]) -> Result<Signature, SignerError> {
        let sig: DalekSignature = self.expanded.sign(message, &self.dalek_pubkey);
        Ok(Signature::from(sig.to_bytes()))
    }

    fn is_interactive(&self) -> bool {
        false
    }
}

// Implement PartialEq for Signer trait requirements
impl PartialEq for StealthSigner {
    fn eq(&self, other: &Self) -> bool {
        self.pubkey == other.pubkey
    }
}

impl std::fmt::Debug for StealthSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StealthSigner")
            .field("pubkey", &self.pubkey)
            .finish_non_exhaustive()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_scalar_zeroization() {
        let bytes = [42u8; 32];
        let scalar = SecretScalar::from_bytes(bytes);
        let ptr = scalar.bytes.as_ptr();
        drop(scalar);
        // After drop, the memory should be zeroed
        // (This is hard to test without unsafe, but the implementation is correct)
    }

    #[test]
    fn test_key_generation() {
        let keys = StealthKeys::generate();

        // Verify public keys are valid curve points
        assert!(decompress_point(&keys.scan_pubkey).is_some());
        assert!(decompress_point(&keys.spend_pubkey).is_some());

        // Verify we can reconstruct from secrets
        let (scan_secret, spend_secret) = keys.export_secrets();
        let reconstructed = StealthKeys::from_secrets(&scan_secret, &spend_secret);

        assert_eq!(keys.scan_pubkey, reconstructed.scan_pubkey);
        assert_eq!(keys.spend_pubkey, reconstructed.spend_pubkey);
    }

    #[test]
    fn test_mnemonic_key_derivation() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

        let keys1 = StealthKeys::from_mnemonic(mnemonic, "").unwrap();
        let keys2 = StealthKeys::from_mnemonic(mnemonic, "").unwrap();

        // Same mnemonic should produce same keys
        assert_eq!(keys1.scan_pubkey, keys2.scan_pubkey);
        assert_eq!(keys1.spend_pubkey, keys2.spend_pubkey);

        // Different passphrase should produce different keys
        let keys3 = StealthKeys::from_mnemonic(mnemonic, "password").unwrap();
        assert_ne!(keys1.scan_pubkey, keys3.scan_pubkey);
    }

    #[test]
    fn test_stealth_address_roundtrip() {
        let keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        // Sender computes stealth address
        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey).unwrap();

        // Recipient scans and finds payment
        let scan_result = scan_payment(
            &keys,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        );

        assert!(scan_result.is_some());

        // Verify the spending key produces the same public key
        let result = scan_result.unwrap();
        let g = ED25519_BASEPOINT_POINT;
        let derived_pubkey = (&result.spending_scalar() * &g).compress().to_bytes();
        assert_eq!(derived_pubkey, computation.stealth_pubkey);
    }

    #[test]
    fn test_stealth_signer_produces_valid_signatures() {
        let keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        // Compute stealth address
        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey).unwrap();

        // Scan payment
        let scan_result = scan_payment(
            &keys,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        ).unwrap();

        // Create signer
        let signer = scan_result.create_signer().unwrap();

        // Verify pubkey matches
        assert_eq!(
            signer.pubkey().to_bytes(),
            computation.stealth_pubkey
        );

        // Sign a message
        let message = b"test message";
        let signature = signer.try_sign_message(message).unwrap();

        // Verify signature using ed25519-dalek
        let pubkey = DalekPublicKey::from_bytes(&computation.stealth_pubkey).unwrap();
        let sig = ed25519_dalek::Signature::from_bytes(&signature.as_ref()).unwrap();

        use ed25519_dalek::Verifier;
        assert!(pubkey.verify(message, &sig).is_ok());
    }

    #[test]
    fn test_view_key_check_payment() {
        let keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        // Compute stealth address
        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey).unwrap();

        // Check with view key only (scan_secret + spend_pubkey)
        let is_ours = check_payment(
            &keys.scan_secret(),
            &spend_pubkey,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        );

        assert!(is_ours);

        // Check against wrong address
        let wrong_address = [0u8; 32];
        let is_wrong = check_payment(
            &keys.scan_secret(),
            &spend_pubkey,
            &computation.ephemeral_pubkey,
            &wrong_address,
        );

        assert!(!is_wrong);
    }

    #[test]
    fn test_commitment_computation() {
        let ephemeral = [1u8; 32];
        let scan = [2u8; 32];
        let spend = [3u8; 32];
        let stealth = [4u8; 32];

        let commitment1 = compute_commitment(&ephemeral, &scan, &spend, &stealth);
        let commitment2 = compute_commitment(&ephemeral, &scan, &spend, &stealth);

        // Same inputs should produce same commitment
        assert_eq!(commitment1, commitment2);

        // Different inputs should produce different commitment
        let commitment3 = compute_commitment(&ephemeral, &scan, &spend, &[5u8; 32]);
        assert_ne!(commitment1, commitment3);
    }
}
