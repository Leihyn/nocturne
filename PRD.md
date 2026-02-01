# Product Requirements Document: Stealth Address Protocol

## Executive Summary

**Product Name:** StealthSol
**Category:** Privacy infrastructure / Payment protocol
**Target Hackathon Prizes:** $20k+ (Track 01 + Helius)
**Go-to-Market:** Standard for private payments on Solana

### Vision
Become the default method for receiving payments privately on Solana - like having a new bank account for every transaction.

### Problem Statement
Sharing your Solana address means exposing your entire financial life:
- Every transaction you've ever made
- Your total balance
- Every dApp you've used
- Everyone who's paid you or you've paid

This creates real problems:
- **Personal safety**: Wealthy users become targets
- **Business privacy**: Competitors see your financials
- **Social awkwardness**: Friends/family see your wealth
- **Discrimination**: Services can profile based on history

### Solution
Stealth addresses using DKSAP (Dual-Key Stealth Address Protocol):
- Share ONE meta-address, receive payments to UNLIMITED unique addresses
- Only you can link payments to your identity
- Each payment goes to a fresh address with no history
- Standard across the Solana ecosystem

---

## Phase 1: Hackathon MVP (Win First)

### Scope
| Feature | Priority | Status |
|---------|----------|--------|
| Generate stealth key pairs | P0 | Must have |
| Register meta-address on-chain | P0 | Must have |
| Send SOL to stealth address | P0 | Must have |
| Scan for incoming payments | P0 | Must have |
| Withdraw from stealth address | P0 | Must have |
| CLI interface | P0 | Must have |
| Key backup/restore | P1 | Should have |

### MVP Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      MVP Architecture                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    CLI Application (Rust)                    │   │
│  │                                                              │   │
│  │  Commands:                                                   │   │
│  │  $ stealth keygen          # Generate scan + spend keys      │   │
│  │  $ stealth register        # Register meta-address on-chain  │   │
│  │  $ stealth send <meta>     # Send to someone's meta-address  │   │
│  │  $ stealth scan            # Check for incoming payments     │   │
│  │  $ stealth withdraw <addr> # Withdraw from stealth address   │   │
│  │  $ stealth balance         # Show total stealth balance      │   │
│  │                                                              │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │                                   │
│                                 ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  Stealth Program (Anchor)                    │   │
│  │                                                              │   │
│  │  ┌───────────────────┐    ┌───────────────────────────────┐│   │
│  │  │     Registry      │    │        Announcements          ││   │
│  │  │                   │    │                               ││   │
│  │  │  owner -> (S, B)  │    │  ephemeral_key -> stealth_addr││   │
│  │  │  (meta-addresses) │    │  (for scanning)               ││   │
│  │  └───────────────────┘    └───────────────────────────────┘│   │
│  │                                                              │   │
│  │  Instructions:                                               │   │
│  │  • register(scan_pubkey, spend_pubkey)                      │   │
│  │  • send(recipient_meta, amount, ephemeral_key)              │   │
│  │  • withdraw(stealth_addr, signature)                        │   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                 │                                   │
│                                 ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                       Solana L1                              │   │
│  │  • Registry PDAs (persistent meta-addresses)                │   │
│  │  • Announcement accounts (ephemeral keys for scanning)      │   │
│  │  • Stealth PDAs (receive payments)                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### MVP Technical Specifications

#### Core Cryptography (DKSAP)

```rust
// Key Generation
pub struct StealthKeys {
    /// Scan key pair (s, S) - for detecting payments
    pub scan_secret: Scalar,
    pub scan_pubkey: EdwardsPoint,

    /// Spend key pair (b, B) - for spending received funds
    pub spend_secret: Scalar,
    pub spend_pubkey: EdwardsPoint,
}

impl StealthKeys {
    pub fn generate() -> Self {
        let mut rng = rand::thread_rng();

        let scan_secret = Scalar::random(&mut rng);
        let scan_pubkey = &scan_secret * &ED25519_BASEPOINT_TABLE;

        let spend_secret = Scalar::random(&mut rng);
        let spend_pubkey = &spend_secret * &ED25519_BASEPOINT_TABLE;

        Self {
            scan_secret,
            scan_pubkey,
            spend_secret,
            spend_pubkey,
        }
    }

    /// Export meta-address for sharing
    pub fn meta_address(&self) -> StealthMetaAddress {
        StealthMetaAddress {
            scan_pubkey: self.scan_pubkey.compress().to_bytes(),
            spend_pubkey: self.spend_pubkey.compress().to_bytes(),
        }
    }
}

// Sending to stealth address
pub fn compute_stealth_address(
    meta: &StealthMetaAddress,
    ephemeral_secret: &Scalar,
) -> (Pubkey, [u8; 32]) {
    let g = ED25519_BASEPOINT_POINT;

    // R = r·G (ephemeral public key)
    let ephemeral_pubkey = ephemeral_secret * g;

    // S (scan public key)
    let scan_point = decompress(&meta.scan_pubkey);

    // Shared secret: ss = r·S
    let shared_secret = ephemeral_secret * scan_point;

    // P = B + H(ss)·G
    let spend_point = decompress(&meta.spend_pubkey);
    let hash_scalar = hash_to_scalar(&shared_secret.compress().to_bytes());
    let stealth_point = spend_point + (hash_scalar * g);

    (
        Pubkey::new_from_array(stealth_point.compress().to_bytes()),
        ephemeral_pubkey.compress().to_bytes(),
    )
}

// Scanning for payments
pub fn scan_payment(
    keys: &StealthKeys,
    ephemeral_pubkey: &[u8; 32],
    payment_address: &Pubkey,
) -> Option<Scalar> {
    let g = ED25519_BASEPOINT_POINT;

    // R (ephemeral public key from announcement)
    let ephemeral_point = decompress(ephemeral_pubkey);

    // ss = s·R (same as sender's r·S)
    let shared_secret = keys.scan_secret * ephemeral_point;

    // P' = B + H(ss)·G
    let hash_scalar = hash_to_scalar(&shared_secret.compress().to_bytes());
    let expected_stealth = keys.spend_pubkey + (hash_scalar * g);

    if expected_stealth.compress().to_bytes() == payment_address.to_bytes() {
        // Derive spending key: p = b + H(ss)
        Some(keys.spend_secret + hash_scalar)
    } else {
        None
    }
}
```

#### On-Chain Program

```rust
// Registry account (stores meta-address)
#[account]
pub struct StealthRegistry {
    pub owner: Pubkey,           // Main wallet (for updates)
    pub scan_pubkey: [u8; 32],   // S
    pub spend_pubkey: [u8; 32],  // B
    pub label: [u8; 32],         // Optional human-readable label
    pub created_at: i64,
    pub bump: u8,
}

// Announcement (for scanning)
#[account]
pub struct StealthAnnouncement {
    pub ephemeral_key: [u8; 32], // R
    pub stealth_address: Pubkey, // P (derived address)
    pub timestamp: i64,
    pub bump: u8,
}

// Instructions
#[program]
pub mod stealth_sol {
    pub fn register(
        ctx: Context<Register>,
        scan_pubkey: [u8; 32],
        spend_pubkey: [u8; 32],
        label: [u8; 32],
    ) -> Result<()>;

    pub fn send(
        ctx: Context<Send>,
        ephemeral_key: [u8; 32],
        amount: u64,
    ) -> Result<()>;

    pub fn withdraw(
        ctx: Context<Withdraw>,
    ) -> Result<()>;
}
```

### MVP User Flow

```
RECIPIENT SETUP:
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  1. $ stealth keygen                                            │
│     > Generating stealth keys...                                │
│     > Scan key:  7Hj4...qK8z (keep private!)                   │
│     > Spend key: 9Lm2...xN4r (keep private!)                   │
│     > Keys saved to ~/.stealth/keys.json                       │
│                                                                 │
│  2. $ stealth register --label "Alice Payments"                 │
│     > Registering meta-address on-chain...                      │
│     > Transaction: 5Yx7...                                      │
│     > Your stealth meta-address:                                │
│     > stealth:7Hj4qK8z9Lm2xN4r...                              │
│     > Share this address to receive private payments!           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

SENDER FLOW:
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  3. $ stealth send stealth:7Hj4qK8z9Lm2xN4r... --amount 1.5    │
│     > Computing stealth address...                              │
│     > Sending 1.5 SOL to one-time address...                   │
│     > Transaction: 8Kp3...                                      │
│     > Payment sent privately!                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

RECIPIENT RECEIVES:
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  4. $ stealth scan                                              │
│     > Scanning for payments...                                  │
│     > Found 1 new payment:                                      │
│     >   Address: 3Zk8...mN2q                                   │
│     >   Amount: 1.5 SOL                                        │
│     >   Time: 2025-01-13 14:32:00                              │
│                                                                 │
│  5. $ stealth withdraw 3Zk8...mN2q --to <main-wallet>          │
│     > Deriving spending key...                                  │
│     > Withdrawing 1.5 SOL...                                   │
│     > Transaction: 2Qr7...                                      │
│     > Funds withdrawn to main wallet!                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### MVP Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Key generation | Works | Valid curve points generated |
| Send to stealth | Works | Payment arrives at derived address |
| Scan detection | 100% | All payments detected by scanner |
| Withdraw | Works | Funds recoverable with derived key |
| Unlinkability | Proven | Each payment to unique address |

---

## Phase 2: Production System (Scale)

### Production Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Production Architecture                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                          Client Layer                                   │ │
│  │                                                                         │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐      │ │
│  │  │    CLI     │  │  Web Wallet│  │  Mobile    │  │    SDK     │      │ │
│  │  │   (Rust)   │  │  Extension │  │   App      │  │  (Rust/TS) │      │ │
│  │  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘      │ │
│  │        └───────────────┴───────────────┴───────────────┘              │ │
│  │                                │                                       │ │
│  │                    ┌───────────▼───────────┐                          │ │
│  │                    │   StealthSol Client   │                          │ │
│  │                    │   Library (Core)      │                          │ │
│  │                    └───────────┬───────────┘                          │ │
│  └────────────────────────────────┼────────────────────────────────────────┘ │
│                                   │                                          │
│  ┌────────────────────────────────▼────────────────────────────────────────┐ │
│  │                         Service Layer                                    │ │
│  │                                                                          │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │ │
│  │  │  Scanner Service │  │  Indexer Service │  │  Relayer Service │     │ │
│  │  │                  │  │                  │  │                  │     │ │
│  │  │  • Watch chain   │  │  • Index meta-   │  │  • Gas-less txs  │     │ │
│  │  │  • Match payments│  │    addresses     │  │  • Batch sends   │     │ │
│  │  │  • Push notifs   │  │  • Cache lookups │  │  • Privacy proxy │     │ │
│  │  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘     │ │
│  │           └─────────────────────┼─────────────────────┘               │ │
│  └─────────────────────────────────┼─────────────────────────────────────────┘ │
│                                    │                                          │
│  ┌─────────────────────────────────▼─────────────────────────────────────────┐ │
│  │                          Solana Layer                                      │ │
│  │                                                                            │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐│ │
│  │  │                      StealthSol Program                               ││ │
│  │  │                                                                       ││ │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐││ │
│  │  │  │  Registry   │  │Announcements│  │  Token Ext  │  │  Compliance │││ │
│  │  │  │  (meta-addr)│  │ (ephemeral) │  │  (SPL)      │  │  (optional) │││ │
│  │  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘││ │
│  │  └──────────────────────────────────────────────────────────────────────┘│ │
│  │                                                                            │ │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                         RPC Providers                               │  │ │
│  │  │  Helius (primary) │ Quicknode (backup) │ Self-hosted (privacy)    │  │ │
│  │  └────────────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                          Data Layer                                        │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────────┐  │ │
│  │  │  Postgres  │  │   Redis    │  │  Encrypted │  │    Monitoring      │  │ │
│  │  │  (Index)   │  │  (Cache)   │  │  Storage   │  │   (Prometheus)     │  │ │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Scalability Design

#### Announcement Storage

```rust
// Current: Individual accounts per announcement
// Problem: Expensive to scan all accounts

// Production: Compressed announcement log
#[account]
pub struct AnnouncementBatch {
    pub start_slot: u64,
    pub end_slot: u64,
    pub count: u16,
    pub announcements: Vec<CompressedAnnouncement>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CompressedAnnouncement {
    pub ephemeral_key: [u8; 32],
    pub stealth_address: [u8; 32],  // Just bytes, not full Pubkey
    pub slot_offset: u16,           // Relative to batch start
}

// Efficient scanning with indexer
pub struct ScannerService {
    pub async fn scan_range(
        &self,
        keys: &StealthKeys,
        from_slot: u64,
        to_slot: u64,
    ) -> Vec<DetectedPayment> {
        // 1. Fetch announcement batches from indexer
        // 2. Parallel scan across batches
        // 3. Return matching payments
    }
}
```

#### Multi-Token Support

```rust
// Extend to support any SPL token
pub fn send_token(
    ctx: Context<SendToken>,
    ephemeral_key: [u8; 32],
    amount: u64,
    token_mint: Pubkey,
) -> Result<()> {
    // 1. Compute stealth address same as SOL
    // 2. Create stealth token account (ATA)
    // 3. Transfer tokens to stealth ATA
    // 4. Record announcement
}
```

### Production Features Roadmap

#### Phase 2A: Core Enhancements
- [ ] SPL token support (USDC, USDT, etc.)
- [ ] Batch scanning (1000x faster)
- [ ] Push notifications (webhooks)
- [ ] View key delegation (accounting without spend)
- [ ] ENS-style stealth names

#### Phase 2B: Ecosystem Integration
- [ ] Wallet adapter (Phantom, Backpack)
- [ ] Payment links (QR codes)
- [ ] Merchant SDK (e-commerce)
- [ ] Cross-program composability
- [ ] Bridge integration

#### Phase 2C: Advanced Privacy
- [ ] Amount encryption (Pedersen commitments)
- [ ] Mixer integration (break withdrawal link)
- [ ] Multi-recipient (batch payments)
- [ ] Scheduled payments (subscriptions)
- [ ] Compliance proofs (selective disclosure)

---

## Privacy Analysis

### What's Protected

| Property | Status | Details |
|----------|--------|---------|
| Recipient identity | Protected | Each payment to new address |
| Payment history | Protected | Addresses unlinkable |
| Balance | Protected | Split across many addresses |
| Sender identity | Not protected | Sender is visible |
| Amount | Not protected | Could add encryption |

### Comparison with Alternatives

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Privacy Comparison Matrix                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Feature          │ Stealth Addr │ Tornado │ Zcash │ Monero        │
│  ─────────────────┼──────────────┼─────────┼───────┼───────────────│
│  New addr/payment │     Yes      │   No    │  Yes  │    Yes        │
│  No fixed denom   │     Yes      │   No    │  Yes  │    Yes        │
│  No deposit wait  │     Yes      │   No    │  Yes  │    Yes        │
│  Sender privacy   │     No       │  Yes    │  Yes  │    Yes        │
│  Amount privacy   │     No*      │  Yes    │  Yes  │    Yes        │
│  Native to Solana │     Yes      │   No    │  No   │    No         │
│  Composable       │     Yes      │   No    │  No   │    No         │
│                                                                     │
│  * Can be added with additional crypto                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### View Key Delegation

```rust
// Allow read-only access (e.g., for accountants, auditors)
pub struct ViewKeys {
    pub scan_secret: Scalar,   // Can detect payments
    pub spend_pubkey: [u8; 32], // Can verify ownership
    // NO spend_secret - cannot withdraw
}

impl ViewKeys {
    pub fn from_full_keys(keys: &StealthKeys) -> Self {
        Self {
            scan_secret: keys.scan_secret,
            spend_pubkey: keys.spend_pubkey.compress().to_bytes(),
        }
    }

    /// Can scan for payments but cannot spend
    pub fn scan(&self, announcement: &Announcement) -> Option<Pubkey> {
        // Same scan logic, returns address but no spending key
    }
}
```

---

## Technical Specifications

### Cryptographic Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Curve | Curve25519 | Solana native, fast |
| Hash | SHA-256 | Standard, audited |
| Key size | 256 bits | Standard security |
| Address size | 32 bytes | Solana Pubkey |

### Security Assumptions

1. **ECDH Security**: Computational Diffie-Hellman is hard
2. **Hash Security**: SHA-256 is collision-resistant
3. **No RNG Weakness**: System RNG is cryptographically secure
4. **Key Storage**: Private keys stored securely (user responsibility)

### Error Handling

```rust
#[error_code]
pub enum StealthError {
    #[msg("Invalid scan public key")]
    InvalidScanPubkey,

    #[msg("Invalid spend public key")]
    InvalidSpendPubkey,

    #[msg("Invalid ephemeral key")]
    InvalidEphemeralKey,

    #[msg("Stealth address mismatch")]
    AddressMismatch,

    #[msg("Insufficient funds in stealth address")]
    InsufficientFunds,

    #[msg("Already registered")]
    AlreadyRegistered,
}
```

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Key loss | Medium | Critical | Backup tools, seed phrase |
| Scan miss | Low | Medium | Redundant scanning, indexer |
| Address reuse | Low | Low | Protocol prevents reuse |
| Quantum threat | Low (future) | Critical | Upgrade path to PQ crypto |
| Regulatory | Medium | High | Compliance features |

---

## Success Criteria

### Hackathon Win Conditions
1. **Working Demo**: Full send/scan/withdraw cycle
2. **Novel Crypto**: First Rust DKSAP on Solana
3. **Clear Explanation**: Judges understand the privacy model
4. **Developer Focus**: CLI + SDK for integration

### Production Launch Conditions
1. **Crypto Audit**: DKSAP implementation verified
2. **Key Management**: Secure backup/restore
3. **Ecosystem Adoption**: Wallet integrations
4. **Documentation**: Complete protocol spec

---

## Appendix: File Structure

```
stealthsol/
├── Cargo.toml
├── Anchor.toml
├── programs/
│   └── stealth/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── instructions/
│           │   ├── mod.rs
│           │   ├── register.rs
│           │   ├── send.rs
│           │   └── withdraw.rs
│           ├── state/
│           │   ├── mod.rs
│           │   ├── registry.rs
│           │   └── announcement.rs
│           ├── crypto/
│           │   ├── mod.rs
│           │   ├── dksap.rs
│           │   └── keys.rs
│           └── error.rs
├── cli/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── keygen.rs
│       │   ├── register.rs
│       │   ├── send.rs
│       │   ├── scan.rs
│       │   └── withdraw.rs
│       └── config.rs
├── sdk/
│   ├── Cargo.toml              # Rust SDK
│   └── src/
│       ├── lib.rs
│       ├── client.rs
│       └── crypto.rs
├── tests/
│   ├── crypto_test.rs
│   └── integration_test.rs
└── docs/
    ├── README.md
    ├── PROTOCOL.md
    └── SECURITY.md
```
