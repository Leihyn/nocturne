# StealthSol: Building Private Payments on Solana

How stealth addresses, ZK proofs, and privacy pools combine to create untraceable transactions.

---

## The Problem

Every Solana transaction is public. When you receive SOL, the entire world can see:

- **Who** sent it
- **Who** received it
- **How much** was sent
- **When** it happened

For businesses, this means competitors see your revenue. For individuals, it means anyone can track your financial life. For protocols, it means MEV bots can front-run your trades.

Privacy isn't about hiding wrongdoing. It's about **not broadcasting your financial life to everyone**.

---

## The Solution: Three Layers of Privacy

StealthSol implements a defense-in-depth approach with three complementary technologies:

| Layer | Technology | What It Hides |
|-------|------------|---------------|
| 1. Stealth Addresses | DKSAP | **WHO** receives funds |
| 2. ZK Privacy Pool | Groth16 + Merkle Trees | **WHICH** deposit is being spent |
| 3. ShadowWire | Pedersen Commitments | **HOW MUCH** is transferred |

Each layer addresses a different privacy leak. Together, they create a complete privacy solution.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Traditional Payment                       │
│                                                                  │
│   Alice ──────────────────────────────────────► Bob             │
│     │                                             │              │
│     └── Public: sender, receiver, amount, time ──┘              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        StealthSol Payment                        │
│                                                                  │
│   Alice ─── [Stealth Address] ─── [ZK Pool] ─── [Hidden Amt] ───│
│     │                                                   │        │
│     └── Public: only that *something* happened ────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Stealth Addresses (DKSAP)

### The Problem

If you publish a wallet address, anyone can:
- Track all your incoming payments
- See your total balance
- Link your identity to your transactions

### The Solution: One-Time Addresses

Stealth addresses let senders create unique, one-time addresses that only the recipient can control. Different from a regular address that you reuse, each stealth address is used exactly once.

### How It Works

The **Dual-Key Stealth Address Protocol (DKSAP)** uses two keypairs:

```
Recipient publishes (once):
├── Scan Public Key (S)    → Used to detect incoming payments
└── Spend Public Key (B)   → Used to derive stealth addresses

Sender generates (per payment):
├── Ephemeral Keypair (r, R)
├── Shared Secret: ss = ECDH(r, S)
└── Stealth Address: P = B + hash(ss)*G
```

**The magic**: Only the recipient (with private keys s, b) can compute the same stealth address and derive its private key.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         DKSAP Flow                                │
│                                                                   │
│  1. BOB publishes meta-address: (scan_pub, spend_pub)            │
│                                                                   │
│  2. ALICE wants to pay Bob:                                       │
│     ┌─────────────────────────────────────────────────────┐      │
│     │  r, R = generate_ephemeral()                         │      │
│     │  shared_secret = ECDH(r, scan_pub)                   │      │
│     │  stealth_addr = spend_pub + H(shared_secret) * G     │      │
│     └─────────────────────────────────────────────────────┘      │
│                                                                   │
│  3. ALICE sends SOL to stealth_addr + publishes R                │
│                                                                   │
│  4. BOB scans announcements:                                      │
│     ┌─────────────────────────────────────────────────────┐      │
│     │  For each announcement with ephemeral R:             │      │
│     │    shared_secret = ECDH(scan_priv, R)                │      │
│     │    expected_addr = spend_pub + H(shared_secret) * G  │      │
│     │    if expected_addr == announced_addr: MINE!         │      │
│     └─────────────────────────────────────────────────────┘      │
│                                                                   │
│  5. BOB derives private key:                                      │
│     stealth_priv = spend_priv + H(shared_secret)                 │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### On-Chain Components

```rust
/// Meta-address stored in registry PDA
#[account]
pub struct StealthRegistry {
    pub owner: Pubkey,           // Bob's main wallet
    pub scan_pubkey: [u8; 32],   // For detecting payments
    pub spend_pubkey: [u8; 32],  // For deriving stealth addresses
    pub bump: u8,
}

/// Announcement for each stealth payment
#[account]
pub struct StealthAnnouncement {
    pub ephemeral_pubkey: [u8; 32],  // R - needed for recipient to derive key
    pub stealth_address: Pubkey,      // The one-time address
    pub commitment: [u8; 32],         // Hash binding the derivation
    pub amount: u64,
    pub slot: u64,
    pub timestamp: i64,
}
```

### Result

- **Sender privacy**: No link between Alice and the stealth address
- **Recipient privacy**: Bob's main wallet never appears on-chain
- **Unlinkability**: Different stealth addresses can't be linked to each other

---

## Layer 2: ZK Privacy Pool

### The Problem

Even with stealth addresses, there's a leak: when Bob withdraws from a stealth address, someone might correlate:
- A 10 SOL deposit to stealth address X
- A 10 SOL withdrawal happening shortly after
- Timing analysis links them together

### The Solution: Fixed-Denomination Pools

Instead of arbitrary amounts, we use **fixed deposit sizes**: 1 SOL, 10 SOL, or 100 SOL pools.

```
┌─────────────────────────────────────────────────────────────────┐
│                    10 SOL Privacy Pool                           │
│                                                                  │
│   Deposits (all 10 SOL):                                         │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐             │
│   │  A  │ │  B  │ │  C  │ │ YOU │ │  E  │ │  F  │  ...         │
│   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘             │
│      │       │       │       │       │       │                  │
│      └───────┴───────┴───────┼───────┴───────┘                  │
│                              │                                   │
│                    Merkle Tree Root                              │
│                              │                                   │
│                     ZK Proof: "I know                            │
│                     one of these deposits"                       │
│                              │                                   │
│                              ▼                                   │
│                        Withdrawal                                │
│                    (can't tell which)                            │
└─────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Deposit**: User deposits 10 SOL + provides a commitment `C = hash(secret, nullifier)`
2. **Wait**: Commitment is added to a Merkle tree with other deposits
3. **Withdraw**: User proves (via ZK) they know a secret in the tree, without revealing which one

### The Circuit

```circom
template Withdraw(levels) {
    // Private inputs (known only to prover)
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Public inputs (verified on-chain)
    signal input root;           // Current Merkle root
    signal input nullifierHash;  // Prevents double-spend
    signal input recipient;      // Where funds go

    // Compute leaf commitment
    component hasher = Poseidon(2);
    hasher.inputs[0] <== secret;
    hasher.inputs[1] <== nullifier;
    signal leaf <== hasher.out;

    // Verify Merkle membership
    component tree = MerkleProof(levels);
    tree.leaf <== leaf;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // Constrain: computed root must equal public root
    root === tree.root;

    // Compute nullifier hash (for double-spend prevention)
    component nh = Poseidon(1);
    nh.inputs[0] <== nullifier;
    nullifierHash === nh.out;
}
```

### On-Chain Verification

The Solana program verifies Groth16 proofs without any trusted oracle:

```rust
pub fn withdraw(
    ctx: Context<Withdraw>,
    proof: Groth16Proof,
    root: [u8; 32],
    nullifier_hash: [u8; 32],
) -> Result<()> {
    // Check nullifier hasn't been used
    require!(
        !ctx.accounts.pool.nullifiers.contains(&nullifier_hash),
        StealthError::NullifierAlreadyUsed
    );

    // Verify ZK proof on-chain
    let public_inputs = vec![root, nullifier_hash, recipient_bytes];
    let is_valid = verify_groth16(&proof, &public_inputs, &vk)?;
    require!(is_valid, StealthError::ProofInvalid);

    // Mark nullifier as spent
    ctx.accounts.pool.nullifiers.insert(nullifier_hash);

    // Transfer funds
    // ...
}
```

### Anonymity Set

Your privacy is proportional to the pool size:

| Pool | Anonymity Set | Privacy Level |
|------|---------------|---------------|
| 10 deposits | 1 in 10 | Low |
| 100 deposits | 1 in 100 | Medium |
| 1000 deposits | 1 in 1000 | High |

The longer you wait (more deposits after yours), the larger your anonymity set.

---

## Layer 3: ShadowWire (Amount Privacy)

### The Problem

Fixed denomination pools have a limitation: amounts are public. If you need to transfer 37 SOL:
- 3x 10 SOL + 7x 1 SOL = 10 transactions = linkable pattern

### The Solution: Pedersen Commitments

Hide the actual amount while still proving it's valid:

```
Commitment = amount * G + blinding * H

Properties:
- Hides the amount (only sender/receiver know)
- Additive: C(a) + C(b) = C(a+b)
- Binding: Can't change amount after committing
```

### Range Proofs

The catch: we need to prove the amount is valid (positive, within bounds) without revealing it.

```
┌───────────────────────────────────────────────────────────────┐
│                    Bulletproof Range Proof                     │
│                                                                │
│  Proves: 0 ≤ amount ≤ 2^64                                    │
│  Without revealing: actual amount                              │
│                                                                │
│  Size: ~700 bytes (logarithmic in bit-range)                  │
│  Verification: ~1ms                                            │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                   ShadowWire Transaction                        │
│                                                                 │
│  Input Commitments (encrypted balances):                        │
│  ┌──────────────┐  ┌──────────────┐                            │
│  │ C_in1 = 50*G │  │ C_in2 = 30*G │                            │
│  │    + r1*H    │  │    + r2*H    │                            │
│  └──────────────┘  └──────────────┘                            │
│         │                  │                                    │
│         └────────┬─────────┘                                    │
│                  │                                              │
│                  ▼                                              │
│         ┌───────────────┐                                       │
│         │  Balance Proof │  Proves: inputs = outputs            │
│         │  Range Proofs  │  Proves: all amounts ≥ 0             │
│         └───────────────┘                                       │
│                  │                                              │
│         ┌───────┴───────┐                                       │
│         │               │                                       │
│         ▼               ▼                                       │
│  ┌──────────────┐  ┌──────────────┐                            │
│  │C_out1 = 45*G │  │C_out2 = 35*G │                            │
│  │    + r3*H    │  │    + r4*H    │                            │
│  └──────────────┘  └──────────────┘                            │
│                                                                 │
│  On-chain sees: commitments + proofs                            │
│  Cannot determine: actual amounts                               │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Implementation Status

ShadowWire is the most complex layer. Current status:

| Component | Status | Notes |
|-----------|--------|-------|
| Pedersen commitments | Implemented | Uses curve25519-dalek |
| Range proofs | Partial | Bulletproofs integration pending |
| Balance proofs | Designed | Circuit development needed |
| On-chain verifier | Planned | Compute budget challenges |

For production deployments, **the fixed-denomination pools provide strong privacy** without the complexity of Pedersen commitments.

---

## System Architecture

### Complete Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    StealthSol Complete Flow                      │
│                                                                  │
│  SENDER (Alice)                                                  │
│  ├── 1. Look up Bob's meta-address from registry                │
│  ├── 2. Generate ephemeral keypair                               │
│  ├── 3. Derive stealth address                                   │
│  ├── 4. Generate ZK proof of correct derivation                  │
│  └── 5. Submit: payment + proof + announcement                   │
│                                                                  │
│  ON-CHAIN                                                        │
│  ├── Verify ZK proof (Groth16)                                   │
│  ├── Transfer SOL to stealth address                             │
│  └── Store announcement (ephemeral pubkey, commitment)           │
│                                                                  │
│  RECIPIENT (Bob)                                                 │
│  ├── 1. Scan announcements using scan key                        │
│  ├── 2. Try to derive expected stealth address for each          │
│  ├── 3. If match found: compute stealth private key              │
│  └── 4. Withdraw: direct or via privacy pool                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Program Structure

```
programs/stealth/
├── src/
│   ├── lib.rs                    # Entry point, instruction dispatch
│   ├── state/
│   │   ├── registry.rs           # Meta-address storage
│   │   ├── announcement.rs       # Payment announcements
│   │   └── pool.rs               # Privacy pool state
│   ├── instructions/
│   │   ├── register.rs           # Register meta-address
│   │   ├── send.rs               # Basic stealth send
│   │   ├── verify_send.rs        # ZK-verified stealth send
│   │   ├── init_pool.rs          # Create privacy pool
│   │   ├── deposit.rs            # Pool deposit
│   │   └── withdraw.rs           # ZK-verified withdrawal
│   ├── zk/
│   │   ├── groth16.rs            # Proof verification
│   │   ├── types.rs              # Proof structures
│   │   └── bn254.rs              # Curve operations
│   └── error.rs                  # Error definitions
│
circuits/
├── stealth/
│   └── derivation.circom         # Stealth address derivation proof
└── pool/
    └── withdraw.circom           # Pool withdrawal proof
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Proof system | Groth16 | Small proofs (~200 bytes), fast verification |
| Hash function | Poseidon | SNARK-friendly, ~8x cheaper than SHA256 in circuits |
| Merkle tree | Incremental (depth 20) | 1M deposits, efficient updates |
| Curve | BN254 | Native Solana support, battle-tested |
| Pool sizes | 1/10/100 SOL | Balance between privacy and usability |

---

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Link stealth addresses | ZK proofs hide derivation details |
| Track withdrawals | Privacy pools break deposit-withdraw links |
| Timing analysis | Wait for larger anonymity set |
| Amount correlation | Fixed denominations (or Pedersen) |
| Malicious sender | Commitments verified on-chain |
| Double-spend | Nullifier tracking |

### What's NOT Hidden

- Transaction fees (paid by sender)
- Timing of transactions (visible on-chain)
- That *a* stealth transaction occurred
- Pool deposit/withdrawal events (just not which is linked)

### Operational Security

For maximum privacy:

1. **Use Tor/VPN** when interacting with the protocol
2. **Wait** for anonymity set to grow before withdrawing
3. **Split** large amounts across multiple pool sizes
4. **Don't** withdraw immediately after depositing
5. **Use** different wallets for deposits and withdrawals

---

## Getting Started

### Prerequisites

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Anchor framework
cargo install --git https://github.com/coral-xyz/anchor anchor-cli

# Node.js (for circuits and frontend)
curl -fsSL https://bun.sh/install | bash
```

### Build and Deploy

```bash
# Clone repository
git clone https://github.com/your-org/stealthsol
cd stealthsol

# Build Anchor program
anchor build

# Deploy to devnet
solana config set --url devnet
anchor deploy

# Initialize verification key
bun run scripts/init-vk.ts
```

### Register Meta-Address

```typescript
import { StealthClient } from './sdk';

const client = new StealthClient(connection, wallet);

// Generate and register meta-address
const { scanKeypair, spendKeypair } = client.generateMetaAddress();
await client.register(scanKeypair.publicKey, spendKeypair.publicKey);

// Save keys securely - loss means loss of funds!
```

### Send Stealth Payment

```typescript
// Look up recipient's meta-address
const registry = await client.getRegistry(recipientWallet);

// Send 1 SOL privately
await client.stealthSend(
  registry.scanPubkey,
  registry.spendPubkey,
  1_000_000_000 // lamports
);
```

### Scan for Payments

```typescript
// Scan all announcements
const payments = await client.scan(scanPrivateKey, spendPublicKey);

for (const payment of payments) {
  console.log(`Found payment: ${payment.amount} lamports`);
  console.log(`Stealth address: ${payment.stealthAddress}`);

  // Derive private key to spend
  const privateKey = client.deriveStealthPrivateKey(
    scanPrivateKey,
    spendPrivateKey,
    payment.ephemeralPubkey
  );
}
```

---

## Roadmap

### Current (v0.1)

- [x] Stealth address registry
- [x] Basic stealth send
- [x] ZK-verified stealth send
- [x] Announcement scanning
- [x] Devnet deployment

### Next (v0.2)

- [ ] Privacy pool implementation
- [ ] Pool deposit/withdraw circuits
- [ ] On-chain Merkle tree
- [ ] CLI wallet

### Future (v1.0)

- [ ] SPL token support
- [ ] Multi-pool strategies
- [ ] Mobile SDK
- [ ] Mainnet deployment

---

## Comparison

### vs Traditional Mixers

| Feature | Traditional Mixer | StealthSol |
|---------|-------------------|------------|
| Custody | Custodial | Non-custodial |
| Trust | Trust operator | Trustless (ZK) |
| Verification | Off-chain | On-chain |
| Address reuse | Required | Never |

### vs Other Privacy Solutions

| Solution | Chain | Privacy Model | Trade-offs |
|----------|-------|---------------|------------|
| Tornado Cash | Ethereum | ZK pools | High gas, regulatory risk |
| Zcash | Own chain | ZK shielded | Limited ecosystem |
| Monero | Own chain | Ring signatures | Not programmable |
| **StealthSol** | Solana | Stealth + ZK pools | New, smaller anonymity set |

---

## Resources

| Resource | Link |
|----------|------|
| Repository | [GitHub](https://github.com/your-org/stealthsol) |
| Documentation | Coming soon |
| Deployed Program | `6mKNcFyg2qKuobBkket5tVHKE9178N2CkRonkzkprDrp` (Devnet) |

### Further Reading

- [EIP-5564: Stealth Addresses](https://eips.ethereum.org/EIPS/eip-5564)
- [DKSAP Specification](https://vitalik.ca/general/2020/01/28/stealth.html)
- [Groth16 Paper](https://eprint.iacr.org/2016/260.pdf)
- [Tornado Cash Architecture](https://tornado.cash/audits/tornado_cryptography_review.pdf)

---

## Contributing

We welcome contributions. Areas of focus:

1. **Circuit optimization** - Reduce constraint count
2. **SDK development** - Better developer experience
3. **Security audits** - Review ZK circuits and on-chain code
4. **Documentation** - Tutorials and examples

---

## Disclaimer

This software is experimental. Use at your own risk. Not audited for production use.

Privacy tools must be used responsibly and in compliance with applicable laws.

---

*Built on Solana. Verified by math. Private by design.*
