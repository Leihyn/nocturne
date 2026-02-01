# Security Analysis & Improvements for StealthSol

This document outlines security considerations, identified issues, and recommended improvements for the StealthSol stealth address protocol implementation.

## Table of Contents

1. [Current Security Status](#current-security-status)
2. [Critical Issues](#critical-issues)
3. [High Priority Improvements](#high-priority-improvements)
4. [Medium Priority Improvements](#medium-priority-improvements)
5. [Low Priority Improvements](#low-priority-improvements)
6. [Security Best Practices](#security-best-practices)

---

## Current Security Status

### What's Protected

| Asset | Protection Level | Notes |
|-------|-----------------|-------|
| Recipient Identity | ✅ Strong | Each payment goes to unique address |
| Payment Linkability | ✅ Strong | Addresses are unlinkable without scan key |
| Spending Keys | ⚠️ Medium | Derived correctly, but storage needs work |
| Secret Key Storage | ❌ Weak | Currently stored in plaintext JSON |

### What's NOT Protected (by design)

- Sender identity (visible on-chain)
- Transaction amounts (visible on-chain)
- Transaction timing (visible on-chain)

---

## Critical Issues

### 1. Plaintext Secret Key Storage

**Location:** `cli/src/config.rs:53-74`

**Issue:** Secret keys are stored as plaintext hex strings in `~/.stealth/keys.json`.

```rust
// Current implementation
pub struct StoredKeys {
    pub scan_secret: String,  // Plaintext hex!
    pub spend_secret: String, // Plaintext hex!
    // ...
}
```

**Risk:** Any process with file read access can steal the keys.

**Recommended Fix:**

```rust
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Argon2, password_hash::SaltString};

pub struct EncryptedKeys {
    /// Encrypted key blob (AES-256-GCM)
    pub ciphertext: Vec<u8>,
    /// Nonce for AES-GCM
    pub nonce: [u8; 12],
    /// Salt for key derivation
    pub salt: [u8; 32],
    /// Argon2 parameters
    pub argon2_params: Argon2Params,
}

impl EncryptedKeys {
    pub fn encrypt(keys: &StoredKeys, password: &str) -> Result<Self> {
        // 1. Derive encryption key from password using Argon2id
        // 2. Encrypt with AES-256-GCM
        // 3. Store ciphertext + nonce + salt
    }

    pub fn decrypt(&self, password: &str) -> Result<StoredKeys> {
        // 1. Derive key from password
        // 2. Decrypt and verify authentication tag
    }
}
```

**Dependencies to add:**
```toml
aes-gcm = "0.10"
argon2 = "0.5"
```

---

### 2. Insufficient Curve Point Validation

**Location:** `programs/stealth/src/crypto/keys.rs:12-31`

**Issue:** The `validate_curve_point` function only checks for all-zeros and all-ones, not actual curve membership.

```rust
// Current - too permissive
pub fn validate_curve_point(bytes: &[u8; 32]) -> bool {
    if bytes.iter().all(|&b| b == 0) { return false; }
    if bytes.iter().all(|&b| b == 0xFF) { return false; }
    true  // Accepts many invalid points!
}
```

**Risk:** Attackers could submit invalid curve points that cause issues during DKSAP operations.

**Recommended Fix:**

```rust
use curve25519_dalek::edwards::CompressedEdwardsY;

pub fn validate_curve_point(bytes: &[u8; 32]) -> bool {
    // Reject identity and obviously invalid
    if bytes.iter().all(|&b| b == 0) { return false; }
    if bytes.iter().all(|&b| b == 0xFF) { return false; }

    // Actually try to decompress the point
    // Note: This is expensive on-chain, consider doing off-chain
    CompressedEdwardsY::from_slice(bytes)
        .decompress()
        .is_some()
}
```

**Trade-off:** Full validation is expensive on-chain (~10k compute units). Consider:
- Doing full validation off-chain in CLI
- Using a lighter on-chain check
- Accepting the risk for invalid payments (they just won't be spendable)

---

### 3. No Rate Limiting on Announcements

**Location:** `programs/stealth/src/instructions/send.rs`

**Issue:** Anyone can spam the announcement system, making scanning expensive.

**Risk:** DoS attack on recipients by creating millions of fake announcements.

**Recommended Fix:**

```rust
// Option 1: Require minimum payment amount
const MIN_PAYMENT_LAMPORTS: u64 = 10_000; // 0.00001 SOL

require!(amount >= MIN_PAYMENT_LAMPORTS, StealthError::PaymentTooSmall);

// Option 2: Charge for announcement creation
const ANNOUNCEMENT_FEE: u64 = 5_000;
// Transfer fee to protocol treasury

// Option 3: Use account compression (future enhancement)
```

---

## High Priority Improvements

### 4. Add Memory Locking for Secrets

**Issue:** Secrets may be swapped to disk by the OS.

```rust
// Add to Cargo.toml
memsec = "0.7"

// In crypto.rs
use memsec::mlock;

impl StealthKeys {
    pub fn generate() -> Self {
        let mut keys = Self::generate_inner();
        // Lock memory pages containing secrets
        unsafe {
            mlock(
                &keys.scan_secret as *const _ as *const u8,
                std::mem::size_of::<Scalar>()
            );
            mlock(
                &keys.spend_secret as *const _ as *const u8,
                std::mem::size_of::<Scalar>()
            );
        }
        keys
    }
}
```

### 5. Implement Constant-Time Comparison

**Location:** `cli/src/crypto.rs:205`

**Issue:** Payment address comparison may leak timing information.

```rust
// Current - potentially timing-vulnerable
if expected_bytes == *payment_address {

// Recommended - constant time
use subtle::ConstantTimeEq;

if expected_bytes.ct_eq(payment_address).into() {
```

**Dependencies:**
```toml
subtle = "2.5"
```

### 6. Add Scan Key Delegation Security

**Issue:** View keys can be exported but there's no revocation mechanism.

**Recommended:**
- Add optional view key expiration
- Implement view key derivation with salt (allows multiple view keys)
- Add on-chain view key registry for revocation

```rust
pub struct DelegatedViewKey {
    pub scan_pubkey: [u8; 32],
    pub delegation_id: [u8; 16],  // Unique ID
    pub expires_at: Option<i64>,   // Unix timestamp
    pub permissions: ViewKeyPermissions,
}

pub struct ViewKeyPermissions {
    pub can_see_amounts: bool,
    pub can_see_sender: bool,
    pub max_lookback_slots: Option<u64>,
}
```

---

## Medium Priority Improvements

### 7. Implement Proper Error Handling for Crypto Operations

**Location:** `cli/src/crypto.rs`

**Issue:** Some crypto operations use `expect()` which panics.

```rust
// Current
let keypair = solana_sdk::signature::Keypair::from_bytes(&keypair_bytes)
    .expect("Valid keypair bytes");

// Recommended
let keypair = solana_sdk::signature::Keypair::from_bytes(&keypair_bytes)
    .map_err(|e| CryptoError::InvalidKeypair(e.to_string()))?;
```

### 8. Add Announcement Indexing

**Issue:** Scanning requires fetching all program accounts, which is O(n) and expensive.

**Recommended:**
```rust
// Add index account per recipient
#[account]
pub struct RecipientIndex {
    pub recipient_registry: Pubkey,
    pub announcement_count: u64,
    pub announcements: Vec<Pubkey>,  // Or use linked list
}

// Or use account compression with SPL Account Compression
```

### 9. Implement Secure Random Number Generation Audit

**Location:** `cli/src/crypto.rs:79-83`

**Current:** Uses `rand::thread_rng()` which is cryptographically secure but worth auditing.

**Recommended:**
```rust
use rand::rngs::OsRng;

fn random_scalar() -> Scalar {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);  // Uses OS entropy
    Scalar::from_bytes_mod_order(bytes)
}
```

### 10. Add Transaction Privacy Warnings

**Issue:** Users may not understand what IS and ISN'T private.

**Recommended:** Add clear warnings in CLI:
```
Warning: The following information is PUBLIC:
- Your wallet address (sender)
- The transaction amount
- The transaction time

Private information:
- The recipient's identity
- Connection between this payment and the recipient's other payments
```

---

## Low Priority Improvements

### 11. Implement Stealth Address Checksum

Add checksum to meta-address format to detect typos:

```rust
pub fn format_meta_address_with_checksum(scan: &[u8; 32], spend: &[u8; 32]) -> String {
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(scan);
    data[32..].copy_from_slice(spend);

    // Add 4-byte checksum
    let checksum = &sha256(&sha256(&data))[..4];

    let mut with_checksum = [0u8; 68];
    with_checksum[..64].copy_from_slice(&data);
    with_checksum[64..].copy_from_slice(checksum);

    format!("stealth:{}", bs58::encode(&with_checksum).into_string())
}
```

### 12. Add Hardware Wallet Support

For production use, support hardware wallets for key storage:
- Ledger integration for signing
- Keep spend key on hardware device
- Only expose scan key to software

### 13. Implement Key Backup Verification

Add a secure way to verify backups without exposing keys:

```rust
pub fn generate_backup_verification_code(keys: &StealthKeys) -> String {
    // Generate a short code that proves backup is valid
    // Without revealing the actual keys
    let hash = sha256(&[
        &keys.scan_secret.to_bytes()[..],
        &keys.spend_secret.to_bytes()[..],
    ].concat());

    // Return first 8 characters
    hex::encode(&hash[..4])
}
```

---

## Security Best Practices

### For Users

1. **Never share your secret keys** - Only share your meta-address
2. **Backup keys securely** - Use encrypted storage or hardware wallet
3. **Verify meta-addresses** - Check the address before sending
4. **Use unique meta-addresses** - Consider generating new keys for different purposes
5. **Monitor announcements** - Scan regularly to detect payments

### For Developers

1. **Run security audits** before mainnet deployment
2. **Use fuzzing** to test cryptographic code
3. **Implement proper logging** without exposing sensitive data
4. **Add monitoring** for unusual patterns
5. **Document threat model** clearly

---

## Audit Checklist

- [ ] External security audit of cryptographic implementation
- [ ] Formal verification of DKSAP protocol implementation
- [ ] Penetration testing of CLI and on-chain program
- [ ] Review of all dependencies for vulnerabilities
- [ ] Fuzzing of parsing and cryptographic functions
- [ ] Review of error handling and edge cases
- [ ] Analysis of potential DoS vectors
- [ ] Review of key management implementation

---

## References

- [DKSAP Specification](https://eprint.iacr.org/2014/764.pdf)
- [Solana Security Best Practices](https://docs.solana.com/developing/programming-model/security)
- [Curve25519 Security Considerations](https://cr.yp.to/ecdh/curve25519-20060209.pdf)
- [OWASP Cryptographic Guidelines](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2024-01-16 | Initial security analysis |
