# StealthSol Production Fixes

## Overview

This document outlines the comprehensive fixes needed to bring StealthSol from hackathon demo to production quality.

---

## 1. RSA Blind Signatures - FIXED

**File:** `coinjoin/src/blind-sig.ts`

**Changes Made:**
- Upgraded to 2048-bit minimum key size (enforced)
- Increased Miller-Rabin iterations from 20 to 64 (2^-128 false positive probability)
- Added small prime factorization check for faster rejection
- Ensured |p - q| is large enough to prevent Fermat factorization
- Added Carmichael's totient (λ) instead of Euler's (φ) for private key
- Added constant-time comparison for signature verification
- Added input validation for signature verification

---

## 2. On-Chain Merkle Tree - FIXED

**Status:** Frontend now syncs with on-chain Merkle tree.

**Changes Made:**
- Added `getPoolRootHistory()` to fetch current and historical roots from on-chain
- Added `isValidMerkleRoot()` to validate proof roots against on-chain state
- Frontend can now generate proofs against the on-chain root

**Files Modified:**
- `frontend/src/lib/program.ts` - Added pool state fetching functions

---

## 3. On-Chain ZK Verifier - FIXED

**Status:** Full Groth16 verification implemented using Solana's BN254 syscalls.

**Changes Made:**
- Implemented `verify_groth16()` with full pairing-based verification
- Uses `alt_bn128_multiplication` for scalar multiplication
- Uses `alt_bn128_addition` for point addition
- Uses `alt_bn128_pairing` for multi-pairing check
- Added `negate_g1()` for point negation
- Added `is_valid_scalar()` for input validation
- Added `verify_proof_with_fallback()` that tries Groth16 first, falls back to oracle

**Verification Equation:**
```rust
// e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1
// Where vk_x = IC[0] + Σ(public_inputs[i] · IC[i+1])
```

**Files Modified:**
- `programs/stealth/src/zk/groth16.rs` - Full Groth16 implementation
- `programs/stealth/src/zk/verifier.rs` - Integration with fallback

---

## 4. Decentralized CoinJoin - FIXED

**Status:** Threshold RSA with Shamir's Secret Sharing implemented.

**Changes Made:**
- Implemented `splitSecret()` for Shamir's Secret Sharing over prime field
- Implemented `reconstructSecret()` using Lagrange interpolation
- Added `splitRSAKey()` to distribute RSA private key as t-of-n shares
- Added `generatePartialSignature()` for distributed signing
- Added `combinePartialSignatures()` using Lagrange in exponent
- Added `ThresholdSession` for coordinating multi-party signing
- Default configuration: 3-of-5 threshold

**Files Created:**
- `coinjoin/src/threshold-rsa.ts` - Full threshold RSA implementation

---

## 5. Multi-Party Transaction Signing - FIXED

**Status:** Full multi-party signing support implemented.

**Changes Made:**
- Added `getCoinJoinMessageToSign()` - Serializes transaction message for signing
- Added `applyCoinJoinSignatures()` - Applies collected signatures to transaction
- Added `verifyCoinJoinSignatures()` - Verifies all required signatures present
- Added `extractSignatureFromSignedTx()` - Extracts signature from wallet-signed tx
- Added `CollectedSignature` interface for signature collection

**Files Modified:**
- `frontend/src/lib/coinjoin/transaction-builder.ts` - Full signing implementation
- `frontend/src/lib/coinjoin/index.ts` - Updated exports

---

## 6. Security Hardening - FIXED

### Input Validation (server.ts) - FIXED ✅
- Added `validateClientMessage()` for all message types
- Added `validateHex()` for hex string validation
- Added `validateDenomination()` for valid pool denominations
- Validates message structure before processing

### Rate Limiting - FIXED ✅
- 30 requests per minute per IP
- 5 concurrent connections per IP
- Automatic cleanup of stale rate limit entries

### Session Authentication - FIXED ✅
- JOIN messages now require Ed25519 signature from wallet
- Server verifies signature using @noble/ed25519
- Signatures include wallet, timestamp, and denomination
- 5-minute max signature age to prevent replay attacks
- Base58 decoding for Solana public keys

### Secure Secret Storage - FIXED ✅
- AES-256-GCM authenticated encryption for notes
- PBKDF2 key derivation with 600,000 iterations
- Random IV (96-bit) and salt (256-bit) per encryption
- SecureNoteStorage class with unlock/lock, add/remove/find
- Export/import backup functionality
- Password change support

---

## 7. Privacy Leak Mitigations - FIXED

### Timing Correlation - FIXED ✅
- Random 5-35 second delay before joining CoinJoin
- Uses cryptographically random delay generation
- Configurable via `TIMING_PROTECTION` constants

### Withdrawal Timing - FIXED ✅
- 24-hour minimum delay between deposit and withdrawal
- 48-hour warning threshold for early withdrawals
- `checkWithdrawalTiming()` validates withdrawal eligibility
- `formatWithdrawalWaitTime()` for user display

### IP Privacy Awareness - FIXED ✅
- `checkIPPrivacy()` detects Tor .onion connections
- Warns users when not using Tor/VPN
- Logs warning to console for transparency

### IP Privacy (Tor Integration) - FIXED ✅
- Full Tor hidden service (.onion) configuration support
- `getOnionAddress()` - Reads .onion address from hidden service
- `generateTorrc()` - Generates torrc configuration
- `requireTorMiddleware()` - Enforces Tor-only connections
- `shouldAcceptConnection()` - WebSocket Tor validation
- `checkTorHealth()` - Health check for Tor status
- `loadConfigFromEnv()` - Environment-based configuration
- SOCKS5 proxy configuration for outbound Tor connections

---

## 8. Code Quality - FIXED

### Structured Error Types - FIXED ✅
Created `frontend/src/lib/coinjoin/errors.ts` with:
- `CoinJoinError` class with error codes, timestamps, recoverability
- `CoinJoinErrorCode` enum with 15+ specific error types
- `isCoinJoinError()` type guard
- `wrapError()` for converting unknown errors
- `Errors` factory object for creating specific errors
- `toUserMessage()` for safe user-facing messages
- `toJSON()` for safe logging (excludes sensitive data)

---

## Implementation Priority

### Phase 1 (Hackathon Critical) - COMPLETE
1. [x] Fix RSA implementation (2048-bit, proper primality testing)
2. [x] Sync frontend with on-chain Merkle tree (getPoolRootHistory, isValidMerkleRoot)
3. [x] Fix multi-party transaction signing (getCoinJoinMessageToSign, applyCoinJoinSignatures)
4. [x] Add basic input validation (validateClientMessage, validateHex)

### Phase 2 (Post-Hackathon) - COMPLETE
5. [x] Add rate limiting and authentication (checkRateLimit, connection limits)
6. [x] Add privacy leak mitigations (timing correlation, withdrawal delays, IP warnings)
7. [x] Add structured error handling (CoinJoinError, error codes)
8. [x] Implement on-chain Groth16 verifier (using Solana alt_bn128 syscalls)

### Phase 2.5 (Infrastructure) - COMPLETE
9. [x] Decentralize CoinJoin with threshold RSA (coinjoin/src/threshold-rsa.ts)

### Phase 3 (Production) - IN PROGRESS
10. [x] Implement secure secret storage (frontend/src/lib/secure-storage.ts)
11. [x] Integrate IP privacy (Tor hidden service) (coinjoin/src/tor-support.ts)
12. [ ] Security audit
13. [ ] Formal verification of ZK circuits

---

## Files Modified

### RSA Security (coinjoin/src/blind-sig.ts)
- 2048-bit minimum key size enforced
- 64 Miller-Rabin iterations for primality testing
- Carmichael's totient (λ) for private key
- Constant-time comparison for signature verification

### On-Chain Merkle Sync (frontend/src/lib/program.ts)
- `getPoolRootHistory()` - Fetch current and historical roots
- `isValidMerkleRoot()` - Validate proof root against on-chain state

### Multi-Party Signing (frontend/src/lib/coinjoin/transaction-builder.ts)
- `getCoinJoinMessageToSign()` - Get serialized message for signing
- `applyCoinJoinSignatures()` - Apply collected signatures
- `verifyCoinJoinSignatures()` - Verify all signatures present
- `extractSignatureFromSignedTx()` - Extract signature from wallet-signed tx

### Security Hardening (coinjoin/src/server.ts)
- Rate limiting per IP (30 requests/minute)
- Connection limiting (5 per IP)
- Input validation for all message types
- Hex string validation

### Privacy Protections (frontend/src/lib/coinjoin/client.ts)
- Random 5-35 second delay before joining (timing correlation)
- IP privacy awareness warnings

### Privacy Protections (frontend/src/lib/zk-crypto.ts)
- 24-hour minimum withdrawal delay
- 48-hour privacy warning threshold
- `checkWithdrawalTiming()` - Validates withdrawal eligibility

### Error Handling (frontend/src/lib/coinjoin/errors.ts)
- `CoinJoinError` class with error codes
- User-safe error messages
- Error factory functions

### Session Authentication (coinjoin/src/server.ts, types.ts)
- Ed25519 signature verification using @noble/ed25519
- Base58 decoding for Solana public keys
- JOIN message now includes timestamp and signature
- 5-minute max signature age validation

### Secure Secret Storage (frontend/src/lib/secure-storage.ts)
- AES-256-GCM encryption with PBKDF2 key derivation
- `SecureNoteStorage` class for encrypted note management
- `encryptData()` / `decryptData()` functions
- Export/import backup functionality

### Threshold RSA (coinjoin/src/threshold-rsa.ts)
- `splitSecret()` / `reconstructSecret()` - Shamir's Secret Sharing
- `splitRSAKey()` - Distribute RSA private key
- `generatePartialSignature()` / `combinePartialSignatures()` - Distributed signing
- `ThresholdSession` - Coordinate multi-party signing sessions

### Tor Hidden Service (coinjoin/src/tor-support.ts)
- `getOnionAddress()` - Read .onion address
- `generateTorrc()` - Generate torrc configuration
- `requireTorMiddleware()` - Enforce Tor-only connections
- `checkTorHealth()` - Tor status health check
- `getTorProxyConfig()` - SOCKS5 proxy configuration

### On-Chain Groth16 Verifier (programs/stealth/src/zk/groth16.rs)
- Full Groth16 verification using Solana's alt_bn128 syscalls
- `verify_groth16()` - Main verification function
- `negate_g1()` - Point negation for pairing equation
- `is_valid_scalar()` - Scalar field validation
- Uses multi-pairing check: e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1
- Computes vk_x = IC[0] + Σ(public_inputs[i] · IC[i+1])

### Verifier Integration (programs/stealth/src/zk/verifier.rs)
- `verify_groth16_onchain()` - On-chain Groth16 verification
- `verify_proof_with_fallback()` - Tries Groth16 first, falls back to oracle

---

## Testing Checklist

- [x] RSA key generation produces valid 2048-bit keys
- [x] Blind signatures verify correctly
- [x] On-chain Merkle root matches local computation (getPoolRootHistory, isValidMerkleRoot)
- [x] Groth16 verifier compiles and is ready for on-chain use
- [x] Multi-party signing collects all signatures
- [x] Rate limiting prevents abuse
- [x] Session authentication prevents impersonation (Ed25519 signature verification)
- [x] Encrypted notes decrypt correctly (AES-256-GCM + PBKDF2)
- [x] Threshold RSA secret sharing works (testSecretSharing())
- [ ] End-to-end CoinJoin flow with multiple participants
- [ ] Privacy leak mitigations work correctly (timing delays)
- [ ] Tor hidden service connectivity test
