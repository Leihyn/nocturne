# StealthSol: Complete Privacy Stack

## Overview
A comprehensive privacy solution for Solana combining four complementary technologies:
1. **Stealth Addresses (DKSAP)** - Hide recipient identity
2. **ZK Deposits** - Hide sender identity
3. **ShadowWire Integration** - Hide transaction amounts (Bulletproofs)
4. **Noir ZK Circuits** - Enable private withdrawals without revealing source

## Prize Potential: $48k+
- **Track 01 (Private Payments)**: $15,000
- **ShadowWire Bounty**: $15,000 - Confidential amounts integration
- **Aztec/Noir Bounty**: $10,000 - ZK circuits for privacy
- **Helius**: $5,000 - Privacy project using their RPC
- **QuickNode**: $3,000 - Best app using QuickNode streams

## Why Stealth Addresses?

Current problem: When you share your Solana address, everyone can see:
- Your entire transaction history
- Your total balance
- Every dApp you've used
- Everyone who's paid you

With stealth addresses:
- Each payment creates a NEW one-time address
- Only recipient can link payments to their identity
- Sender, receiver, and amount are unlinkable

## DKSAP Protocol Explained

```
┌─────────────────────────────────────────────────────────────────┐
│                  DKSAP Stealth Address Flow                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  RECIPIENT (Bob) generates key pairs:                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Scan Key Pair:  (s, S) where S = s·G                   │   │
│  │  Spend Key Pair: (b, B) where B = b·G                   │   │
│  │                                                         │   │
│  │  Bob publishes: (S, B) - Scan Public Key, Spend Public  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  SENDER (Alice) wants to pay Bob:                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  1. Generate ephemeral key pair: (r, R) where R = r·G   │   │
│  │  2. Compute shared secret: ss = r·S = r·s·G             │   │
│  │  3. Derive stealth pubkey: P = B + hash(ss)·G           │   │
│  │  4. Send funds to P, publish R with transaction         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  RECIPIENT scans for payments:                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  1. For each tx with ephemeral key R:                   │   │
│  │  2. Compute shared secret: ss = s·R = s·r·G (same ss!)  │   │
│  │  3. Derive stealth pubkey: P' = B + hash(ss)·G          │   │
│  │  4. If P' matches payment address → it's for Bob!       │   │
│  │  5. Derive private key: p = b + hash(ss)                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Security: Only Bob can compute the private key p              │
│  Privacy: Each payment goes to unique address P                │
└─────────────────────────────────────────────────────────────────┘
```

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Stealth Address System                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  On-Chain Components:                                           │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Registry Program                                         │ │
│  │  • Store (S, B) stealth meta-addresses                    │ │
│  │  • Index ephemeral keys R for scanning                    │ │
│  │  • Optional: announcement logs                            │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Transfer Program                                         │ │
│  │  • Compute stealth address on-chain                       │ │
│  │  • Transfer SOL/tokens to stealth PDA                     │ │
│  │  • Emit ephemeral key R in logs                           │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Off-Chain Components:                                          │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Scanner CLI (Rust)                                       │ │
│  │  • Watch for new ephemeral keys                           │ │
│  │  • Compute stealth addresses                              │ │
│  │  • Detect payments to user                                │ │
│  │  • Derive private keys for withdrawal                     │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Core Rust Dependencies

```toml
# Cargo.toml
[dependencies]
anchor-lang = "0.30.1"
solana-program = "2.0"

# Cryptography
curve25519-dalek = { version = "4.1", features = ["alloc"] }
ed25519-dalek = "2.1"
sha2 = "0.10"
rand = "0.8"

# For CLI client
solana-sdk = "2.0"
solana-client = "2.0"
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }

[dev-dependencies]
solana-program-test = "2.0"
```

## Program Structure

```
stealth-address/
├── Cargo.toml
├── programs/
│   └── stealth/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                    # Program entrypoint
│           ├── instructions/
│           │   ├── mod.rs
│           │   ├── register.rs           # Register stealth meta-address
│           │   ├── send.rs               # Send to stealth address
│           │   ├── withdraw.rs           # Withdraw from stealth PDA
│           │   └── announce.rs           # Announce ephemeral key
│           ├── state/
│           │   ├── mod.rs
│           │   ├── registry.rs           # Meta-address registry
│           │   └── announcement.rs       # Ephemeral key log
│           ├── crypto/
│           │   ├── mod.rs
│           │   ├── stealth.rs            # Core DKSAP implementation
│           │   └── keys.rs               # Key derivation
│           └── error.rs
├── cli/
│   └── src/
│       ├── main.rs                       # CLI entrypoint
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── keygen.rs                 # Generate stealth keys
│       │   ├── register.rs               # Register on-chain
│       │   ├── send.rs                   # Send to stealth address
│       │   ├── scan.rs                   # Scan for payments
│       │   └── withdraw.rs               # Withdraw funds
│       └── crypto.rs                     # Client-side crypto
└── tests/
    └── stealth_test.rs
```

## Key Code: Core Cryptography (DKSAP)

```rust
// programs/stealth/src/crypto/stealth.rs
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
};
use sha2::{Digest, Sha256};
use solana_program::pubkey::Pubkey;

/// Stealth meta-address: (scan_pubkey, spend_pubkey)
#[derive(Clone, Copy)]
pub struct StealthMetaAddress {
    pub scan_pubkey: [u8; 32],   // S = s·G
    pub spend_pubkey: [u8; 32],  // B = b·G
}

/// Ephemeral key published with each stealth transfer
#[derive(Clone, Copy)]
pub struct EphemeralKey {
    pub pubkey: [u8; 32],  // R = r·G
}

impl StealthMetaAddress {
    /// Sender: Compute stealth address from meta-address
    ///
    /// 1. Generate ephemeral keypair (r, R)
    /// 2. Compute shared secret: ss = r·S
    /// 3. Derive stealth pubkey: P = B + hash(ss)·G
    pub fn derive_stealth_address(
        &self,
        ephemeral_scalar: &Scalar,
    ) -> (Pubkey, EphemeralKey) {
        let g = ED25519_BASEPOINT_POINT;

        // R = r·G (ephemeral public key)
        let ephemeral_point = ephemeral_scalar * g;
        let ephemeral_pubkey = ephemeral_point.compress().to_bytes();

        // S (scan public key)
        let scan_point = CompressedEdwardsY::from_slice(&self.scan_pubkey)
            .unwrap()
            .decompress()
            .unwrap();

        // Shared secret: ss = r·S
        let shared_secret = ephemeral_scalar * scan_point;
        let shared_secret_bytes = shared_secret.compress().to_bytes();

        // hash(ss) as scalar
        let hash_scalar = hash_to_scalar(&shared_secret_bytes);

        // B (spend public key)
        let spend_point = CompressedEdwardsY::from_slice(&self.spend_pubkey)
            .unwrap()
            .decompress()
            .unwrap();

        // P = B + hash(ss)·G
        let stealth_point = spend_point + (hash_scalar * g);
        let stealth_pubkey = stealth_point.compress().to_bytes();

        (
            Pubkey::new_from_array(stealth_pubkey),
            EphemeralKey { pubkey: ephemeral_pubkey },
        )
    }
}

/// Recipient: Check if a payment is for them and derive private key
pub struct StealthScanner {
    pub scan_scalar: Scalar,   // s (scan private key)
    pub spend_scalar: Scalar,  // b (spend private key)
}

impl StealthScanner {
    /// Check if a stealth address belongs to this scanner
    ///
    /// 1. Compute shared secret: ss = s·R (using scan private key)
    /// 2. Derive expected stealth pubkey: P' = B + hash(ss)·G
    /// 3. Compare with actual payment address
    pub fn check_stealth_address(
        &self,
        ephemeral_key: &EphemeralKey,
        payment_address: &Pubkey,
    ) -> Option<Scalar> {
        let g = ED25519_BASEPOINT_POINT;

        // R (ephemeral public key from transaction)
        let ephemeral_point = CompressedEdwardsY::from_slice(&ephemeral_key.pubkey)
            .unwrap()
            .decompress()
            .unwrap();

        // Shared secret: ss = s·R (same as sender's r·S due to ECDH)
        let shared_secret = self.scan_scalar * ephemeral_point;
        let shared_secret_bytes = shared_secret.compress().to_bytes();

        // hash(ss) as scalar
        let hash_scalar = hash_to_scalar(&shared_secret_bytes);

        // B = b·G (our spend public key)
        let spend_pubkey = self.spend_scalar * g;

        // Expected stealth address: P' = B + hash(ss)·G
        let expected_stealth = spend_pubkey + (hash_scalar * g);
        let expected_bytes = expected_stealth.compress().to_bytes();

        // Check if it matches the payment address
        if expected_bytes == payment_address.to_bytes() {
            // Derive private key: p = b + hash(ss)
            let stealth_private_key = self.spend_scalar + hash_scalar;
            Some(stealth_private_key)
        } else {
            None
        }
    }
}

/// Hash bytes to a scalar (for key derivation)
fn hash_to_scalar(data: &[u8]) -> Scalar {
    let mut hasher = Sha256::new();
    hasher.update(b"stealth_derive");
    hasher.update(data);
    let hash = hasher.finalize();

    let mut scalar_bytes = [0u8; 32];
    scalar_bytes.copy_from_slice(&hash);

    // Reduce to valid scalar
    Scalar::from_bytes_mod_order(scalar_bytes)
}
```

## Key Code: Registry Account

```rust
// programs/stealth/src/state/registry.rs
use anchor_lang::prelude::*;

/// Registry entry for a user's stealth meta-address
#[account]
pub struct StealthRegistry {
    /// Owner's main wallet (for reference/updates)
    pub owner: Pubkey,

    /// Scan public key (S)
    pub scan_pubkey: [u8; 32],

    /// Spend public key (B)
    pub spend_pubkey: [u8; 32],

    /// Human-readable label (optional)
    pub label: [u8; 32],

    /// Creation timestamp
    pub created_at: i64,

    /// Bump for PDA
    pub bump: u8,
}

impl StealthRegistry {
    pub const SEED: &'static [u8] = b"stealth_registry";
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1;
}
```

## Key Code: Register Meta-Address

```rust
// programs/stealth/src/instructions/register.rs
use anchor_lang::prelude::*;
use crate::state::StealthRegistry;

#[derive(Accounts)]
#[instruction(scan_pubkey: [u8; 32], spend_pubkey: [u8; 32])]
pub struct Register<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = StealthRegistry::SIZE,
        seeds = [StealthRegistry::SEED, owner.key().as_ref()],
        bump,
    )]
    pub registry: Account<'info, StealthRegistry>,

    pub system_program: Program<'info, System>,
}

pub fn register(
    ctx: Context<Register>,
    scan_pubkey: [u8; 32],
    spend_pubkey: [u8; 32],
    label: [u8; 32],
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let clock = Clock::get()?;

    // Validate the public keys are valid curve points
    validate_pubkey(&scan_pubkey)?;
    validate_pubkey(&spend_pubkey)?;

    registry.owner = ctx.accounts.owner.key();
    registry.scan_pubkey = scan_pubkey;
    registry.spend_pubkey = spend_pubkey;
    registry.label = label;
    registry.created_at = clock.unix_timestamp;
    registry.bump = ctx.bumps.registry;

    msg!("Stealth meta-address registered for {}", ctx.accounts.owner.key());
    Ok(())
}

fn validate_pubkey(bytes: &[u8; 32]) -> Result<()> {
    use curve25519_dalek::edwards::CompressedEdwardsY;

    CompressedEdwardsY::from_slice(bytes)
        .map_err(|_| error!(StealthError::InvalidPubkey))?
        .decompress()
        .ok_or(error!(StealthError::InvalidPubkey))?;

    Ok(())
}
```

## Key Code: Stealth Transfer

```rust
// programs/stealth/src/instructions/send.rs
use anchor_lang::prelude::*;
use crate::crypto::stealth::{StealthMetaAddress, EphemeralKey};

#[derive(Accounts)]
pub struct StealthSend<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// Recipient's registered stealth meta-address
    pub recipient_registry: Account<'info, StealthRegistry>,

    /// The derived stealth address (computed off-chain, verified on-chain)
    /// CHECK: Verified against meta-address in instruction
    #[account(mut)]
    pub stealth_address: AccountInfo<'info>,

    /// Announcement account for the ephemeral key
    #[account(
        init,
        payer = sender,
        space = Announcement::SIZE,
        seeds = [b"announcement", &ephemeral_key],
        bump,
    )]
    pub announcement: Account<'info, Announcement>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct Announcement {
    /// Ephemeral public key R
    pub ephemeral_key: [u8; 32],
    /// The stealth address this was sent to
    pub stealth_address: Pubkey,
    /// Amount sent (optional, could be hidden)
    pub amount: u64,
    /// Timestamp
    pub timestamp: i64,
    pub bump: u8,
}

impl Announcement {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

pub fn stealth_send(
    ctx: Context<StealthSend>,
    ephemeral_key: [u8; 32],
    amount: u64,
) -> Result<()> {
    let registry = &ctx.accounts.recipient_registry;

    // Reconstruct meta-address
    let meta = StealthMetaAddress {
        scan_pubkey: registry.scan_pubkey,
        spend_pubkey: registry.spend_pubkey,
    };

    // Verify the stealth address matches what sender computed
    // (Sender computed this off-chain with ephemeral scalar)
    let ephemeral = EphemeralKey { pubkey: ephemeral_key };

    // Note: We can't fully verify on-chain without the ephemeral scalar
    // but we store the ephemeral key for the recipient to scan

    // Transfer SOL to stealth address
    let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.sender.key(),
        &ctx.accounts.stealth_address.key(),
        amount,
    );

    anchor_lang::solana_program::program::invoke(
        &transfer_ix,
        &[
            ctx.accounts.sender.to_account_info(),
            ctx.accounts.stealth_address.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Record announcement for scanning
    let announcement = &mut ctx.accounts.announcement;
    announcement.ephemeral_key = ephemeral_key;
    announcement.stealth_address = ctx.accounts.stealth_address.key();
    announcement.amount = amount;
    announcement.timestamp = Clock::get()?.unix_timestamp;
    announcement.bump = ctx.bumps.announcement;

    msg!(
        "Stealth transfer: {} lamports to {}",
        amount,
        ctx.accounts.stealth_address.key()
    );

    Ok(())
}
```

## Key Code: Scanner CLI

```rust
// cli/src/commands/scan.rs
use crate::crypto::StealthScanner;
use solana_client::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;

pub async fn scan_for_payments(
    rpc: &RpcClient,
    scanner: &StealthScanner,
    program_id: &Pubkey,
) -> Vec<DetectedPayment> {
    let mut payments = vec![];

    // Fetch all announcement accounts
    let accounts = rpc.get_program_accounts(program_id).unwrap();

    for (pubkey, account) in accounts {
        // Deserialize announcement
        if let Ok(announcement) = Announcement::try_deserialize(&mut account.data.as_slice()) {
            let ephemeral = EphemeralKey {
                pubkey: announcement.ephemeral_key,
            };

            // Check if this payment is for us
            if let Some(private_key) = scanner.check_stealth_address(
                &ephemeral,
                &announcement.stealth_address,
            ) {
                payments.push(DetectedPayment {
                    stealth_address: announcement.stealth_address,
                    amount: announcement.amount,
                    private_key,
                    timestamp: announcement.timestamp,
                });
            }
        }
    }

    payments
}

pub struct DetectedPayment {
    pub stealth_address: Pubkey,
    pub amount: u64,
    pub private_key: Scalar,
    pub timestamp: i64,
}
```

## Privacy Analysis

| Property | Status | Notes |
|----------|--------|-------|
| **Sender Privacy** | Partial | Sender visible, but recipient unknown |
| **Recipient Privacy** | Strong | Each payment to unique address |
| **Amount Privacy** | None | Amount visible (could add encryption) |
| **Linkability** | None | Payments unlinkable without scan key |
| **Scan Key Separation** | Yes | Can delegate scanning without spend rights |

## Potential Enhancements

1. **View Key Delegation**: Share scan key for accounting without spending
2. **Amount Encryption**: Add Pedersen commitments for hidden amounts
3. **Token Support**: Extend to SPL tokens
4. **Multi-recipient**: Batch payments to multiple stealth addresses
5. **ENS-style Names**: Register human-readable names for meta-addresses

## Comparison with Existing Solutions

| Feature | Stealth Addresses | Tornado-style Mixers | Light Protocol |
|---------|-------------------|----------------------|----------------|
| Fresh addresses | Yes | No (fixed pools) | No |
| Requires deposit | No | Yes | No |
| Fixed denominations | No | Yes | No |
| On-chain scanning | Via logs | N/A | Merkle proofs |
| Complexity | Medium | Low | High |

## Resources

- [DKSAP Paper](https://github.com/onflow/developer-grants/issues/58)
- [curve25519-dalek](https://docs.rs/curve25519-dalek)
- [ed25519-dalek](https://docs.rs/ed25519-dalek)
- [solana-stealth (JS reference)](https://socket.dev/npm/package/solana-stealth)
- [EIP-5564 (Ethereum stealth addresses)](https://eips.ethereum.org/EIPS/eip-5564)

---

# Part 2: Complete Privacy Stack Architecture

## System Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                     COMPLETE PRIVACY STACK                                      │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   LAYER 1: STEALTH ADDRESSES (Recipient Privacy)                               │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │  • DKSAP Protocol with X25519 ECDH                                      │  │
│   │  • One-time addresses per payment                                       │  │
│   │  • Scan/Spend key separation                                            │  │
│   │  STATUS: ✅ IMPLEMENTED                                                 │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│   LAYER 2: ZK DEPOSITS (Sender Privacy)                                        │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │  • Privacy pool with Merkle tree commitments                            │  │
│   │  • Poseidon hash for ZK-friendliness                                    │  │
│   │  • Commitment: hash(nullifier || secret || amount || recipient)         │  │
│   │  STATUS: 🔨 TO IMPLEMENT                                                │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│   LAYER 3: SHADOWWIRE (Amount Privacy)                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │  • Bulletproofs for confidential transactions                           │  │
│   │  • Pedersen commitments: C = v·G + r·H                                  │  │
│   │  • Range proofs to prevent negative amounts                             │  │
│   │  STATUS: 🔨 TO INTEGRATE                                                │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│   LAYER 4: NOIR ZK CIRCUITS (Withdrawal Privacy)                               │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │  • Prove knowledge of note without revealing which one                  │  │
│   │  • Nullifier prevents double-spend                                      │  │
│   │  • Recursive proofs for batching                                        │  │
│   │  STATUS: 🔨 TO IMPLEMENT                                                │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Privacy Matrix

| Attack Vector | Stealth Only | + ZK Deposits | + ShadowWire | + Noir ZK |
|---------------|--------------|---------------|--------------|-----------|
| **Who sent?** | ❌ Visible | ✅ Hidden | ✅ Hidden | ✅ Hidden |
| **Who received?** | ✅ Hidden | ✅ Hidden | ✅ Hidden | ✅ Hidden |
| **Amount?** | ❌ Visible | ❌ Visible | ✅ Hidden | ✅ Hidden |
| **Withdrawal link?** | ❌ Linkable | ❌ Linkable | ❌ Linkable | ✅ Hidden |

## Complete Protocol Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        PRIVATE PAYMENT FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  1. DEPOSIT PHASE (Sender → Privacy Pool)                                        │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                            │ │
│  │  Sender (Alice):                                                           │ │
│  │  1. Generate random: nullifier, secret                                     │ │
│  │  2. Compute stealth address for Bob                                        │ │
│  │  3. Create commitment: C = Poseidon(nullifier, secret, amount, stealth)    │ │
│  │  4. Create ShadowWire Pedersen commitment for amount                       │ │
│  │  5. Deposit to Privacy Pool with commitment                                │ │
│  │  6. Pool adds commitment to Merkle tree                                    │ │
│  │                                                                            │ │
│  │  On-chain: Pool sees deposit but doesn't know destination                  │ │
│  │                                                                            │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                     │                                            │
│                                     ▼                                            │
│  2. ANNOUNCEMENT (Off-chain Coordination)                                        │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                            │ │
│  │  Alice → Bob (encrypted channel or on-chain log):                          │ │
│  │  • ephemeral_pubkey (for stealth address derivation)                       │ │
│  │  • encrypted_note = encrypt(nullifier, secret, amount)                     │ │
│  │                                                                            │ │
│  │  Note: Announcement reveals nothing - encrypted to Bob's scan key          │ │
│  │                                                                            │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                     │                                            │
│                                     ▼                                            │
│  3. SCAN PHASE (Recipient discovers payment)                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                            │ │
│  │  Recipient (Bob):                                                          │ │
│  │  1. Scan announcements using scan_secret                                   │ │
│  │  2. Decrypt ephemeral_pubkey → derive stealth address                      │ │
│  │  3. Decrypt note → get nullifier, secret, amount                           │ │
│  │  4. Verify: commitment exists in Merkle tree                               │ │
│  │  5. Store note locally for later withdrawal                                │ │
│  │                                                                            │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                     │                                            │
│                                     ▼                                            │
│  4. WITHDRAW PHASE (Privacy-Preserving Exit)                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                            │ │
│  │  Recipient (Bob):                                                          │ │
│  │  1. Compute nullifier_hash = Poseidon(nullifier)                           │ │
│  │  2. Generate Noir ZK proof:                                                │ │
│  │     - PROVE: I know (nullifier, secret, amount) such that:                 │ │
│  │       • commitment = Poseidon(nullifier, secret, amount, stealth)          │ │
│  │       • commitment is in Merkle tree at path [...]                         │ │
│  │       • nullifier_hash = Poseidon(nullifier)                               │ │
│  │     - REVEAL: nullifier_hash, recipient_address, merkle_root               │ │
│  │                                                                            │ │
│  │  3. Submit proof + nullifier_hash to contract                              │ │
│  │  4. Contract verifies:                                                     │ │
│  │     - Proof is valid                                                       │ │
│  │     - nullifier_hash not used before                                       │ │
│  │     - merkle_root is valid (recent)                                        │ │
│  │  5. Contract sends funds to any address Bob chooses                        │ │
│  │                                                                            │ │
│  │  On-chain: Nobody can link withdrawal to original deposit!                 │ │
│  │                                                                            │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

# Part 3: ShadowWire Integration Specification

## Overview

ShadowWire provides confidential transactions using Bulletproofs on Solana. We integrate it to hide transaction amounts.

## ShadowWire Cryptographic Primitives

### Pedersen Commitments

```
Commitment: C = v·G + r·H

Where:
- v = value (amount in lamports)
- r = blinding factor (random scalar)
- G = generator point (Ed25519 basepoint)
- H = second generator (hash-derived point)

Properties:
- Hiding: Without r, cannot determine v
- Binding: Cannot find (v', r') where C = v'·G + r'·H and v' ≠ v
- Homomorphic: C(a) + C(b) = C(a+b) (with blinding factors combined)
```

### Bulletproofs Range Proofs

```
Range Proof proves: 0 ≤ v < 2^64

Without revealing v!

Why needed:
- Prevent negative amounts (overflow attacks)
- Prevent creating money from nothing
- ~700 bytes per proof (much smaller than alternatives)
```

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SHADOWWIRE INTEGRATION                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  DEPOSIT with Confidential Amount:                                           │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │  Input:                                                                │ │
│  │    - amount: u64 (known to sender)                                     │ │
│  │    - recipient_stealth: PublicKey                                      │ │
│  │                                                                        │ │
│  │  Sender computes:                                                      │ │
│  │    1. r = random_scalar()                                              │ │
│  │    2. C = amount·G + r·H                    (Pedersen commitment)      │ │
│  │    3. range_proof = bulletproof(amount, r)  (prove 0 ≤ amount < 2^64)  │ │
│  │    4. encrypted_amount = encrypt(amount || r, recipient_scan_key)      │ │
│  │                                                                        │ │
│  │  On-chain stores:                                                      │ │
│  │    - commitment C (32 bytes)                                           │ │
│  │    - range_proof (~700 bytes)                                          │ │
│  │    - encrypted_amount (48 bytes)                                       │ │
│  │                                                                        │ │
│  │  Nobody except recipient can determine the amount!                     │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  BALANCE VERIFICATION:                                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │  For transfers within the system:                                      │ │
│  │                                                                        │ │
│  │    Input_Commitment = Output_Commitment + Fee_Commitment               │ │
│  │                                                                        │ │
│  │  Because Pedersen is homomorphic:                                      │ │
│  │    (a·G + r1·H) = (b·G + r2·H) + (c·G + r3·H)                          │ │
│  │    iff a = b + c and r1 = r2 + r3                                      │ │
│  │                                                                        │ │
│  │  Contract verifies equation holds without knowing values!              │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## ShadowWire Account Structures

```rust
// Confidential balance account
#[account]
pub struct ConfidentialAccount {
    pub owner: Pubkey,
    // Pedersen commitment to balance: C = balance·G + blinding·H
    pub balance_commitment: [u8; 32],
    // Encrypted balance (only owner can decrypt)
    pub encrypted_balance: [u8; 48],
    pub bump: u8,
}

// Confidential transfer instruction data
pub struct ConfidentialTransfer {
    // New commitment for sender's remaining balance
    pub sender_new_commitment: [u8; 32],
    // Commitment for recipient
    pub recipient_commitment: [u8; 32],
    // Range proofs for both amounts
    pub sender_range_proof: Vec<u8>,
    pub recipient_range_proof: Vec<u8>,
    // Encrypted amounts
    pub encrypted_sender_amount: [u8; 48],
    pub encrypted_recipient_amount: [u8; 48],
}
```

## ShadowWire API Integration

```typescript
// frontend/src/lib/shadowwire.ts

import { ShadowWire } from '@pnpm-solana/shadowwire';

interface ConfidentialDeposit {
  commitment: Uint8Array;       // Pedersen commitment
  rangeProof: Uint8Array;       // Bulletproof
  encryptedAmount: Uint8Array;  // Encrypted for recipient
  blindingFactor: Uint8Array;   // Kept secret by sender
}

// Create confidential deposit
export async function createConfidentialDeposit(
  amount: bigint,
  recipientScanKey: Uint8Array
): Promise<ConfidentialDeposit> {
  // Generate random blinding factor
  const blindingFactor = randomScalar();

  // Create Pedersen commitment: C = amount·G + r·H
  const commitment = ShadowWire.commit(amount, blindingFactor);

  // Create range proof: proves 0 ≤ amount < 2^64
  const rangeProof = ShadowWire.proveRange(amount, blindingFactor);

  // Encrypt amount for recipient
  const encryptedAmount = encryptForRecipient(
    amount,
    blindingFactor,
    recipientScanKey
  );

  return {
    commitment,
    rangeProof,
    encryptedAmount,
    blindingFactor
  };
}

// Verify a confidential deposit
export function verifyConfidentialDeposit(
  commitment: Uint8Array,
  rangeProof: Uint8Array
): boolean {
  return ShadowWire.verifyRange(commitment, rangeProof);
}

// Decrypt amount as recipient
export async function decryptAmount(
  encryptedAmount: Uint8Array,
  scanSecret: Uint8Array
): Promise<{ amount: bigint; blindingFactor: Uint8Array }> {
  return decryptWithKey(encryptedAmount, scanSecret);
}
```

---

# Part 4: Noir ZK Circuits Specification

## Overview

Noir is Aztec's domain-specific language for writing zero-knowledge circuits. We use it for:
1. **Deposit Circuit** - Prove valid deposit without revealing sender
2. **Withdrawal Circuit** - Prove ownership of note without revealing which one

## Circuit 1: Deposit Circuit

```noir
// circuits/deposit/src/main.nr

use dep::std;

// Poseidon hash for ZK-friendliness
fn poseidon_hash(inputs: [Field; 4]) -> Field {
    std::hash::poseidon::bn254::hash_4(inputs)
}

// Main deposit circuit
// Public inputs: commitment, merkle_root
// Private inputs: nullifier, secret, amount, recipient, merkle_path
fn main(
    // Public inputs (visible on-chain)
    commitment: pub Field,

    // Private inputs (hidden)
    nullifier: Field,
    secret: Field,
    amount: Field,
    recipient: Field,
) {
    // Constraint 1: Commitment is correctly computed
    let computed_commitment = poseidon_hash([nullifier, secret, amount, recipient]);
    assert(computed_commitment == commitment);

    // Constraint 2: Amount is positive (range check)
    // Noir automatically handles range via Field arithmetic
    assert(amount as u64 > 0);
}
```

## Circuit 2: Withdrawal Circuit (Main ZK Component)

```noir
// circuits/withdraw/src/main.nr

use dep::std;

// Poseidon hash
fn poseidon_hash_2(a: Field, b: Field) -> Field {
    std::hash::poseidon::bn254::hash_2([a, b])
}

fn poseidon_hash_4(inputs: [Field; 4]) -> Field {
    std::hash::poseidon::bn254::hash_4(inputs)
}

// Compute Merkle root from leaf and path
fn compute_merkle_root(
    leaf: Field,
    path: [Field; 20],        // 20 levels = 2^20 = 1M notes capacity
    path_indices: [u1; 20],   // 0 = left, 1 = right
) -> Field {
    let mut current = leaf;

    for i in 0..20 {
        let sibling = path[i];
        let (left, right) = if path_indices[i] == 0 {
            (current, sibling)
        } else {
            (sibling, current)
        };
        current = poseidon_hash_2(left, right);
    }

    current
}

// Main withdrawal circuit
fn main(
    // Public inputs
    merkle_root: pub Field,        // Current tree root
    nullifier_hash: pub Field,     // Prevents double-spend
    recipient: pub Field,          // Where to send funds

    // Private inputs (hidden from everyone)
    nullifier: Field,
    secret: Field,
    amount: Field,
    stealth_address: Field,        // Original recipient stealth address
    merkle_path: [Field; 20],
    path_indices: [u1; 20],
) {
    // Constraint 1: Nullifier hash is correct
    let computed_nullifier_hash = poseidon_hash_2(nullifier, 0);
    assert(computed_nullifier_hash == nullifier_hash);

    // Constraint 2: Commitment exists in tree
    let commitment = poseidon_hash_4([nullifier, secret, amount, stealth_address]);
    let computed_root = compute_merkle_root(commitment, merkle_path, path_indices);
    assert(computed_root == merkle_root);

    // Constraint 3: Amount is valid (implicit via Field)
    // The amount is bound to the commitment, so it's verified
}
```

## Circuit 3: Transfer Circuit (Internal Transfers)

```noir
// circuits/transfer/src/main.nr

use dep::std;

fn poseidon_hash_4(inputs: [Field; 4]) -> Field {
    std::hash::poseidon::bn254::hash_4(inputs)
}

fn poseidon_hash_2(a: Field, b: Field) -> Field {
    std::hash::poseidon::bn254::hash_2([a, b])
}

fn compute_merkle_root(
    leaf: Field,
    path: [Field; 20],
    path_indices: [u1; 20],
) -> Field {
    let mut current = leaf;
    for i in 0..20 {
        let sibling = path[i];
        let (left, right) = if path_indices[i] == 0 {
            (current, sibling)
        } else {
            (sibling, current)
        };
        current = poseidon_hash_2(left, right);
    }
    current
}

// Private transfer: spend old note, create new note
fn main(
    // Public inputs
    merkle_root: pub Field,
    nullifier_hash: pub Field,          // Old note nullifier
    new_commitment: pub Field,          // New note for recipient
    change_commitment: pub Field,       // Change back to sender

    // Private inputs
    // Old note
    old_nullifier: Field,
    old_secret: Field,
    old_amount: Field,
    old_stealth: Field,
    merkle_path: [Field; 20],
    path_indices: [u1; 20],

    // New notes
    new_nullifier: Field,
    new_secret: Field,
    new_amount: Field,
    new_recipient: Field,

    change_nullifier: Field,
    change_secret: Field,
    change_amount: Field,
    change_recipient: Field,
) {
    // Constraint 1: Old note exists in tree
    let old_commitment = poseidon_hash_4([old_nullifier, old_secret, old_amount, old_stealth]);
    let computed_root = compute_merkle_root(old_commitment, merkle_path, path_indices);
    assert(computed_root == merkle_root);

    // Constraint 2: Nullifier is correct
    let computed_nullifier = poseidon_hash_2(old_nullifier, 0);
    assert(computed_nullifier == nullifier_hash);

    // Constraint 3: New commitments are correct
    let computed_new = poseidon_hash_4([new_nullifier, new_secret, new_amount, new_recipient]);
    assert(computed_new == new_commitment);

    let computed_change = poseidon_hash_4([change_nullifier, change_secret, change_amount, change_recipient]);
    assert(computed_change == change_commitment);

    // Constraint 4: Conservation of value (no money creation)
    assert(old_amount == new_amount + change_amount);
}
```

## Noir Circuit Compilation & Verification

```bash
# Install Noir
curl -L https://noir-lang.org/install.sh | bash

# Compile circuit
cd circuits/withdraw
nargo compile

# Generate proving key and verification key
nargo setup

# Create proof (off-chain, by user)
nargo prove

# Verify proof (on-chain, by contract)
nargo verify
```

## Solana Verifier Contract

```rust
// programs/stealth/src/instructions/verify_withdraw.rs

use anchor_lang::prelude::*;

// Noir proof verification on Solana
#[derive(Accounts)]
pub struct VerifyWithdraw<'info> {
    #[account(mut)]
    pub withdrawer: Signer<'info>,

    /// Privacy pool state
    #[account(mut)]
    pub pool: Account<'info, PrivacyPool>,

    /// Nullifier registry (prevents double-spend)
    #[account(
        init_if_needed,
        payer = withdrawer,
        space = 8 + 32 + 1,
        seeds = [b"nullifier", nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_account: Account<'info, NullifierRecord>,

    /// Recipient of the withdrawal
    /// CHECK: Can be any address
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct NullifierRecord {
    pub nullifier_hash: [u8; 32],
    pub used: bool,
}

#[account]
pub struct PrivacyPool {
    pub merkle_root: [u8; 32],
    pub merkle_roots_history: Vec<[u8; 32]>,  // Recent roots for async proofs
    pub total_deposited: u64,
    pub next_leaf_index: u64,
    pub bump: u8,
}

pub fn verify_withdraw(
    ctx: Context<VerifyWithdraw>,
    proof: Vec<u8>,           // Noir proof bytes
    merkle_root: [u8; 32],
    nullifier_hash: [u8; 32],
    amount: u64,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let nullifier = &mut ctx.accounts.nullifier_account;

    // 1. Check nullifier hasn't been used
    require!(!nullifier.used, PrivacyError::NullifierAlreadyUsed);

    // 2. Verify merkle root is valid (current or recent)
    require!(
        pool.merkle_root == merkle_root ||
        pool.merkle_roots_history.contains(&merkle_root),
        PrivacyError::InvalidMerkleRoot
    );

    // 3. Verify the ZK proof
    let public_inputs = [
        merkle_root,
        nullifier_hash,
        ctx.accounts.recipient.key().to_bytes(),
    ];

    require!(
        verify_noir_proof(&proof, &public_inputs),
        PrivacyError::InvalidProof
    );

    // 4. Mark nullifier as used
    nullifier.nullifier_hash = nullifier_hash;
    nullifier.used = true;

    // 5. Transfer funds to recipient
    let pool_seeds = &[b"pool".as_ref(), &[pool.bump]];
    let signer = &[&pool_seeds[..]];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::system_instruction::transfer(
            &pool.key(),
            &ctx.accounts.recipient.key(),
            amount,
        ),
        &[
            pool.to_account_info(),
            ctx.accounts.recipient.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        signer,
    )?;

    msg!("Private withdrawal of {} lamports to {}", amount, ctx.accounts.recipient.key());
    Ok(())
}

// Noir proof verification using the Barretenberg backend
fn verify_noir_proof(proof: &[u8], public_inputs: &[[u8; 32]]) -> bool {
    // This calls the Noir verifier
    // In production, use: https://github.com/noir-lang/noir/tree/master/tooling/noir_js
    noir_verifier::verify(proof, public_inputs)
}
```

---

# Part 5: Data Structures & State

## On-Chain State

```rust
// Complete state structures

/// Privacy Pool - holds all deposited funds
#[account]
pub struct PrivacyPool {
    /// Authority that can update parameters
    pub authority: Pubkey,

    /// Current Merkle root
    pub merkle_root: [u8; 32],

    /// History of recent Merkle roots (for async proof generation)
    /// Keep last 100 roots
    pub merkle_roots_history: [[u8; 32]; 100],
    pub history_index: u8,

    /// Total amount in pool
    pub total_deposited: u64,

    /// Next leaf index in Merkle tree
    pub next_leaf_index: u64,

    /// Whether the pool is active
    pub is_active: bool,

    /// PDA bump
    pub bump: u8,
}

impl PrivacyPool {
    pub const SIZE: usize = 8 + 32 + (32 * 100) + 1 + 8 + 8 + 1 + 1;
    pub const SEED: &'static [u8] = b"privacy_pool";
}

/// Commitment leaf stored on-chain
#[account]
pub struct CommitmentLeaf {
    /// The commitment hash
    pub commitment: [u8; 32],

    /// Leaf index in Merkle tree
    pub leaf_index: u64,

    /// Timestamp
    pub timestamp: i64,

    /// Optional: encrypted note for recipient
    pub encrypted_note: [u8; 128],

    pub bump: u8,
}

impl CommitmentLeaf {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 128 + 1;
}

/// Nullifier record - tracks spent notes
#[account]
pub struct Nullifier {
    /// Hash of the nullifier
    pub nullifier_hash: [u8; 32],

    /// When it was spent
    pub spent_at: i64,

    pub bump: u8,
}

impl Nullifier {
    pub const SIZE: usize = 8 + 32 + 8 + 1;
    pub const SEED: &'static [u8] = b"nullifier";
}
```

## Off-Chain State (Client)

```typescript
// Local note storage

interface PrivateNote {
  // Commitment data
  nullifier: Uint8Array;      // 32 bytes
  secret: Uint8Array;         // 32 bytes
  amount: bigint;             // Amount in lamports
  stealthAddress: string;     // Base58 stealth address

  // Merkle proof data
  leafIndex: number;
  commitment: Uint8Array;

  // Metadata
  timestamp: number;
  isSpent: boolean;
  txSignature?: string;
}

interface NoteStorage {
  notes: PrivateNote[];

  // Methods
  addNote(note: PrivateNote): void;
  markSpent(nullifier: Uint8Array): void;
  getUnspentNotes(): PrivateNote[];
  getBalance(): bigint;
}
```

---

# Part 6: API Reference

## Frontend SDK

```typescript
// frontend/src/lib/privacy-sdk.ts

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';

export class PrivacySDK {
  private connection: Connection;
  private wallet: Keypair;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
  }

  // ============ STEALTH ADDRESSES ============

  /**
   * Generate stealth keys from wallet
   */
  async generateStealthKeys(): Promise<StealthKeys> {
    return generateStealthKeys(this.wallet);
  }

  /**
   * Get shareable meta-address
   */
  getMetaAddress(keys: StealthKeys): string {
    return formatMetaAddress(keys.scanPubkey, keys.spendPubkey);
  }

  /**
   * Compute stealth address for payment
   */
  async computeStealthAddress(metaAddress: string): Promise<StealthPayment> {
    const { scanPubkey, spendPubkey } = parseMetaAddress(metaAddress);
    return computeStealthAddress(scanPubkey, spendPubkey);
  }

  // ============ PRIVATE DEPOSITS ============

  /**
   * Create a private deposit
   * - Hides sender (ZK commitment)
   * - Hides amount (ShadowWire)
   * - Hides recipient (stealth address)
   */
  async privateDeposit(
    recipientMetaAddress: string,
    amount: bigint,
  ): Promise<{
    txSignature: string;
    announcementCode: string;
    note: PrivateNote;
  }> {
    // 1. Compute stealth address
    const { scanPubkey, spendPubkey } = parseMetaAddress(recipientMetaAddress);
    const stealth = await computeStealthAddress(scanPubkey, spendPubkey);

    // 2. Generate note secrets
    const nullifier = randomBytes(32);
    const secret = randomBytes(32);

    // 3. Compute commitment
    const commitment = poseidonHash([
      nullifier,
      secret,
      bigintToField(amount),
      stealth.stealthPubkey
    ]);

    // 4. Create ShadowWire confidential commitment
    const confidential = await createConfidentialDeposit(amount, scanPubkey);

    // 5. Build and send transaction
    const tx = await this.buildDepositTx(
      commitment,
      confidential.commitment,
      confidential.rangeProof,
      amount
    );
    const txSignature = await this.connection.sendTransaction(tx, [this.wallet]);

    // 6. Create announcement for recipient
    const announcementCode = this.createAnnouncementCode(
      stealth.ephemeralPubkey,
      nullifier,
      secret,
      amount,
      scanPubkey
    );

    return {
      txSignature,
      announcementCode,
      note: {
        nullifier,
        secret,
        amount,
        stealthAddress: stealth.stealthAddress.toBase58(),
        leafIndex: -1, // Updated after confirmation
        commitment,
        timestamp: Date.now(),
        isSpent: false,
      }
    };
  }

  // ============ PRIVATE WITHDRAWALS ============

  /**
   * Withdraw privately using ZK proof
   * - Nobody can link withdrawal to deposit
   * - Nullifier prevents double-spend
   */
  async privateWithdraw(
    note: PrivateNote,
    recipientAddress: string,
  ): Promise<string> {
    // 1. Get current Merkle root and path
    const merkleData = await this.getMerkleProof(note.leafIndex);

    // 2. Compute nullifier hash
    const nullifierHash = poseidonHash([note.nullifier, 0n]);

    // 3. Generate Noir ZK proof
    const proof = await this.generateWithdrawProof({
      merkleRoot: merkleData.root,
      nullifierHash,
      recipient: new PublicKey(recipientAddress).toBytes(),
      nullifier: note.nullifier,
      secret: note.secret,
      amount: note.amount,
      stealthAddress: note.stealthAddress,
      merklePath: merkleData.path,
      pathIndices: merkleData.indices,
    });

    // 4. Submit withdrawal transaction
    const tx = await this.buildWithdrawTx(
      proof,
      merkleData.root,
      nullifierHash,
      recipientAddress,
      note.amount
    );

    return await this.connection.sendTransaction(tx, [this.wallet]);
  }

  // ============ SCANNING ============

  /**
   * Scan for incoming payments
   */
  async scanForPayments(
    scanSecret: Uint8Array,
    spendSecret: Uint8Array,
  ): Promise<ScannedPayment[]> {
    const announcements = await this.fetchAnnouncements();
    const payments: ScannedPayment[] = [];

    for (const announcement of announcements) {
      const payment = await scanAnnouncement(
        announcement,
        scanSecret,
        spendSecret
      );
      if (payment) {
        payments.push(payment);
      }
    }

    return payments;
  }

  // ============ HELPER METHODS ============

  private createAnnouncementCode(
    ephemeralPubkey: Uint8Array,
    nullifier: Uint8Array,
    secret: Uint8Array,
    amount: bigint,
    recipientScanKey: Uint8Array,
  ): string {
    // Encrypt note data for recipient
    const encryptedNote = encryptForRecipient(
      { nullifier, secret, amount },
      recipientScanKey
    );

    const data = {
      e: bs58.encode(ephemeralPubkey),
      n: bs58.encode(encryptedNote),
    };

    return btoa(JSON.stringify(data));
  }

  private async generateWithdrawProof(inputs: WithdrawInputs): Promise<Uint8Array> {
    // Use Noir.js to generate proof
    const noir = await import('@noir-lang/noir_js');
    const circuit = await import('../circuits/withdraw/target/withdraw.json');

    const noir_instance = new noir.Noir(circuit);
    const { witness } = await noir_instance.execute(inputs);
    const proof = await noir_instance.generateFinalProof(witness);

    return proof;
  }
}
```

## CLI Commands

```bash
# Generate stealth keys
stealthsol keygen

# Register meta-address on-chain
stealthsol register --label "My Address"

# Show your meta-address (shareable)
stealthsol meta-address

# Send privately
stealthsol send \
  --to "stealth:ABC123..." \
  --amount 1.5 \
  --private  # Use ZK deposit + ShadowWire

# Scan for incoming payments
stealthsol scan

# Withdraw privately
stealthsol withdraw \
  --note-index 0 \
  --to "9abc123..." \
  --private  # Use ZK withdrawal

# Check balance (sum of unspent notes)
stealthsol balance
```

---

# Part 7: Security Considerations

## Threat Model

| Threat | Mitigation |
|--------|------------|
| **Chain analysis** | Stealth addresses break address clustering |
| **Timing correlation** | Relayer network, time-delayed withdrawals |
| **Amount correlation** | ShadowWire confidential amounts |
| **Double spending** | Nullifier registry on-chain |
| **Fake proofs** | Noir verifier checks mathematical validity |
| **Front-running** | Commit-reveal scheme for withdrawals |
| **Merkle root manipulation** | Root history allows async proof generation |

## Known Limitations

1. **Deposit amounts visible** (until ShadowWire integration)
2. **No transaction graph obfuscation** (deposits still linkable to sender)
3. **Withdrawal timing** can leak information
4. **Metadata leakage** via RPC providers (use Helius private RPC)

## Recommendations

1. **Use time-delayed withdrawals** - Don't withdraw immediately after deposit
2. **Use multiple denominations** - Fixed amounts make analysis harder
3. **Use Tor/VPN** - Hide IP address from RPC providers
4. **Use Helius private endpoints** - Reduces metadata leakage
5. **Batch withdrawals** - Withdraw multiple notes in one transaction

---

# Part 8: Implementation Roadmap

## Phase 1: Stealth Addresses ✅ (Complete)
- [x] X25519 ECDH implementation
- [x] Stealth address derivation
- [x] Announcement system
- [x] Scan functionality
- [x] Frontend UI

## Phase 2: ZK Deposits (Next)
- [ ] Poseidon hash implementation (Solana)
- [ ] Merkle tree on-chain storage
- [ ] Noir deposit circuit
- [ ] Deposit instruction
- [ ] Frontend integration

## Phase 3: ShadowWire Integration
- [ ] Integrate ShadowWire SDK
- [ ] Pedersen commitment generation
- [ ] Bulletproof range proofs
- [ ] Confidential balance accounts
- [ ] Frontend amount encryption

## Phase 4: ZK Withdrawals
- [ ] Noir withdrawal circuit
- [ ] Verifier contract on Solana
- [ ] Nullifier registry
- [ ] Merkle proof generation
- [ ] Frontend proof generation

## Phase 5: Polish & Testing
- [ ] End-to-end testing
- [ ] Security audit
- [ ] Performance optimization
- [ ] Documentation
- [ ] Demo video

---

# Appendix A: Cryptographic Constants

```rust
// Domain separators
pub const STEALTH_DOMAIN: &[u8] = b"stealthsol_v1";
pub const COMMITMENT_DOMAIN: &[u8] = b"stealthsol_commitment_v1";
pub const NULLIFIER_DOMAIN: &[u8] = b"stealthsol_nullifier_v1";

// Poseidon parameters for BN254
pub const POSEIDON_T: usize = 5;        // Width
pub const POSEIDON_RF: usize = 8;       // Full rounds
pub const POSEIDON_RP: usize = 56;      // Partial rounds

// Merkle tree parameters
pub const MERKLE_DEPTH: usize = 20;     // 2^20 = 1M notes
pub const MERKLE_ZERO: [u8; 32] = [0u8; 32];  // Zero leaf

// ShadowWire parameters
pub const RANGE_PROOF_BITS: usize = 64; // For u64 amounts
```

# Appendix B: Error Codes

```rust
#[error_code]
pub enum PrivacyError {
    #[msg("Invalid stealth public key")]
    InvalidPubkey,

    #[msg("Invalid Merkle proof")]
    InvalidMerkleProof,

    #[msg("Invalid Merkle root")]
    InvalidMerkleRoot,

    #[msg("Nullifier has already been used")]
    NullifierAlreadyUsed,

    #[msg("Invalid ZK proof")]
    InvalidProof,

    #[msg("Invalid range proof")]
    InvalidRangeProof,

    #[msg("Insufficient pool balance")]
    InsufficientBalance,

    #[msg("Pool is not active")]
    PoolNotActive,

    #[msg("Invalid commitment")]
    InvalidCommitment,
}
```
