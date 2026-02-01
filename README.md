# Nocturne

**Private payments on Solana** — Stealth addresses, ZK proofs, and confidential transfers.

> *Nocturne* — Privacy that works in the shadows.

## Overview

Nocturne is a privacy protocol for Solana that enables fully private transactions. Send and receive SOL without revealing your identity, transaction amounts, or payment history.

### Key Features

- **Stealth Addresses (DKSAP)** — One meta-address, unlimited unique receive addresses
- **Privacy Pools** — Fixed denomination pools (0.1, 1, 10, 100 SOL) with Merkle tree commitments
- **ZK Proofs** — Noir circuits with UltraHonk backend for withdrawal proofs
- **TEE Relay** — Hide your identity by relaying transactions through secure enclaves
- **97% Privacy Score** — Best-in-class unlinkability between deposits and withdrawals

## Live Demo (Devnet)

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

## Deployed Programs (Devnet)

| Program | Address |
|---------|---------|
| Stealth | `3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT` |
| TEE Bridge | `7BWpEN8PqFEZ131A5F8iEniMS6bYREGrabxLHgSdUmVW` |
| TEE Relayer | `8BzTaoLzgaeY6TuV8LcQyNHt8RKukPSf9ijUtUbPD6X1` |

## How It Works

1. **Deposit** — Your SOL enters a privacy pool with a fixed denomination
2. **Get Withdrawal Key** — Receive a secret key that proves your deposit
3. **Withdraw** — Use ZK proof to withdraw to any address (no link to deposit)

```
Depositor A ──┐                    ┌── Recipient X
Depositor B ──┼── Privacy Pool ───┼── Recipient Y
Depositor C ──┘     (ZK Proofs)    └── Recipient Z

No on-chain link between depositors and recipients
```

## Privacy Modes

| Mode | Amount Hidden | Identity Hidden | Link Hidden |
|------|---------------|-----------------|-------------|
| Basic Stealth | No | Recipient only | No |
| Fixed Pool | Yes (uniformity) | Via TEE relay | Yes (ZK) |
| Full Privacy | Yes | Yes | Yes |

## Project Structure

```
nocturne/
├── frontend/            # Next.js web app
│   └── src/lib/
│       ├── shadowwire.ts    # Unified privacy SDK
│       ├── stealth.ts       # DKSAP implementation
│       ├── noir-prover.ts   # ZK proof generation
│       └── tee-encryption.ts # TEE relay client
├── programs/            # Solana smart contracts
│   └── stealth/
│       ├── crypto/          # DKSAP, Poseidon, Merkle
│       ├── instructions/    # On-chain handlers
│       └── state/           # Account structures
├── circuits/            # Noir ZK circuits
│   └── noir/withdraw/       # Withdrawal proof circuit
├── verifier/            # ZK proof verification server
├── relayer/             # Fee relay service
├── cli/                 # Command-line interface
└── scripts/             # Deployment scripts
```

## Quick Start

### Frontend (Recommended)

```bash
# Install dependencies
cd frontend && npm install

# Set up environment
cp .env.example .env.local
# Add your RPC URL (Helius recommended for devnet)

# Start development server
npm run dev
```

### CLI Usage

```bash
# Build the CLI
cargo build --release --package stealth-cli

# Generate stealth keys
./target/release/stealthsol keygen --mnemonic

# Get your meta-address
./target/release/stealthsol address
# Output: stealth:2xK9...

# Send private payment
./target/release/stealthsol send --to stealth:2xK9... --amount 1.0

# Scan for incoming payments
./target/release/stealthsol scan

# Withdraw received funds
./target/release/stealthsol withdraw --all
```

### Deploy Programs

```bash
# Build programs
anchor build --no-idl -- --features production

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Run tests
cargo test --workspace
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Smart Contracts | Solana / Anchor / Rust |
| ZK Circuits | Noir (UltraHonk backend) |
| Frontend | Next.js 16 / TypeScript / Tailwind |
| Cryptography | curve25519-dalek, Poseidon hash |
| TEE | MagicBlock secure enclaves |

## Documentation

| Document | Description |
|----------|-------------|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Full deployment guide |
| [USAGE_GUIDE.md](USAGE_GUIDE.md) | CLI usage instructions |
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | Architecture deep-dive |
| [PRIVACY_ARCHITECTURE.md](PRIVACY_ARCHITECTURE.md) | Privacy guarantees |
| [SECURITY_ANALYSIS.md](SECURITY_ANALYSIS.md) | Security considerations |

## Privacy Guarantees

- **Deposit-Withdrawal Unlinkability**: ZK proofs ensure no on-chain connection
- **Amount Privacy**: Fixed denominations prevent amount correlation
- **Timing Privacy**: Batch withdrawals reduce timing analysis
- **Identity Privacy**: TEE relay hides fee payer identity
- **Address Privacy**: Stealth addresses for each payment

## Security

This is experimental software. Use at your own risk.

See [SECURITY_ANALYSIS.md](SECURITY_ANALYSIS.md) for:
- Threat model and assumptions
- Cryptographic security analysis
- Known limitations
- Audit status

## Contributing

Contributions welcome! Please read the security considerations before submitting PRs that touch cryptographic code.

## License

MIT

---

Built for the Solana ecosystem.
