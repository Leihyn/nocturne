# StealthSol Deployment Guide

This guide covers deploying and configuring the StealthSol privacy system on Solana.

## Prerequisites

- Solana CLI v1.18+ (`solana --version`)
- Anchor v0.30.1 (`anchor --version`)
- Rust 1.75+ (`rustc --version`)
- Node.js 18+ (`node --version`)
- ~10 SOL for deployment (devnet) or ~15 SOL (mainnet)

## Quick Start

```bash
# 1. Clone and setup
git clone https://github.com/your-repo/stealthsol.git
cd stealthsol
npm install

# 2. Configure wallet
solana config set --url devnet
solana-keygen new  # or use existing: solana config set --keypair ~/.config/solana/id.json

# 3. Get devnet SOL
solana airdrop 2 --url devnet

# 4. Build and deploy
make build-production
make deploy
```

## Deployed Addresses (Devnet)

| Program | Address |
|---------|---------|
| Stealth | `3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT` |
| TEE Bridge | `7BWpEN8PqFEZ131A5F8iEniMS6bYREGrabxLHgSdUmVW` |
| TEE Relayer | `8BzTaoLzgaeY6TuV8LcQyNHt8RKukPSf9ijUtUbPD6X1` |

## Step-by-Step Deployment

### 1. Build Programs

```bash
# Development build (no ZK verification)
make build-program

# Production build (with ZK verification)
make build-production
```

### 2. Deploy to Network

```bash
# Devnet deployment
make deploy

# Mainnet deployment (CAUTION!)
make deploy-mainnet
```

### 3. Initialize Verification Key

After deployment, initialize the Groth16 verification key:

```bash
cd scripts && npx ts-node --esm init-vk.ts devnet
```

This creates the VK PDA at `88NXTzL225X9atPYgWuXaoJ4bMHoeYzn9prfUDR9gFz3`.

### 4. Initialize Privacy Pool

Initialize the 1 SOL privacy pool:

```bash
cd scripts && npx ts-node --esm init-pool.ts
```

### 5. Start Services

```bash
# Start relayer service
cd relayer && npm install && npm run dev

# Start CoinJoin coordinator
cd coinjoin && npm install && npm run dev

# Start frontend
cd frontend && npm install && npm run dev
```

## Configuration

### Environment Variables

Create `.env` files for each service:

**frontend/.env:**
```env
NEXT_PUBLIC_PROGRAM_ID=3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT
NEXT_PUBLIC_NETWORK=devnet
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_VERIFIER_URL=http://localhost:3001
NEXT_PUBLIC_COINJOIN_URL=ws://localhost:3002
```

**relayer/.env:**
```env
NETWORK=devnet
RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT
RELAYER_KEYPAIR_PATH=~/.config/solana/relayer.json
FEE_PERCENT=1
```

### Anchor.toml

The `Anchor.toml` file contains program IDs for each network:

```toml
[programs.devnet]
stealth = "3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT"

[programs.mainnet]
stealth = "YOUR_MAINNET_PROGRAM_ID"

[provider]
cluster = "devnet"
wallet = "~/.config/solana/id.json"
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        STEALTHSOL                                │
├─────────────────────────────────────────────────────────────────┤
│  STEALTH ADDRESSES (DKSAP)                                       │
│  - Recipient privacy via unique addresses                        │
│  - Scan/Spend key separation                                     │
├─────────────────────────────────────────────────────────────────┤
│  PRIVACY POOLS                                                   │
│  - Fixed denominations: 0.1, 1, 10, 100 SOL                     │
│  - Merkle tree commitments                                       │
│  - Nullifier-based double-spend prevention                       │
├─────────────────────────────────────────────────────────────────┤
│  ZK PROOFS (Groth16/Noir)                                        │
│  - Deposit-withdrawal unlinking                                  │
│  - Oracle attestation fallback                                   │
├─────────────────────────────────────────────────────────────────┤
│  BULLETPROOF AMOUNT HIDING (New!)                                │
│  - Arbitrary amounts (not just fixed denominations)              │
│  - Range proof: 0 ≤ amount < 2^64                               │
├─────────────────────────────────────────────────────────────────┤
│  P2P BLIND COINJOIN                                              │
│  - Depositor identity hiding                                     │
│  - RSA blind signatures                                          │
│  - Multi-party transaction building                              │
└─────────────────────────────────────────────────────────────────┘
```

## Testing

### Unit Tests

```bash
# All tests
make test

# Program tests only
cargo test -p stealth

# CLI tests only
cargo test -p stealth-cli
```

### Integration Tests

```bash
# Run e2e test
cd scripts && npx ts-node --esm e2e-test.ts

# Run full integration test suite
make integration-test
```

### Manual Testing

1. Open frontend at `http://localhost:3000`
2. Connect wallet (Phantom, Solflare, etc.)
3. Generate stealth identity
4. Deposit to privacy pool
5. Share note with recipient
6. Recipient withdraws to stealth address

## Troubleshooting

### Common Issues

**"Insufficient funds"**
```bash
solana airdrop 2 --url devnet
```

**"Program not found"**
```bash
# Verify deployment
solana program show 3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT --url devnet
```

**"Verification key not initialized"**
```bash
cd scripts && npx ts-node --esm init-vk.ts devnet
```

**"Pool not found"**
```bash
cd scripts && npx ts-node --esm init-pool.ts
```

### Build Issues

**"anchor-syn source_file error"**
- Caused by Rust version mismatch with anchor-syn 0.30.1
- Solution: Use `anchor build --no-idl`

**"production feature not found"**
- Add `production = []` to each program's Cargo.toml features section

## Security Considerations

### Production Checklist

- [ ] Use mainnet RPC endpoint
- [ ] Enable production feature in build
- [ ] Set up multiple trusted verifiers (threshold signing)
- [ ] Configure rate limiting on relayer
- [ ] Enable Tor hidden service support
- [ ] Review and audit all smart contracts
- [ ] Test emergency pause functionality
- [ ] Set up monitoring and alerting

### Key Security Features

1. **ZK Proof Verification**: Ed25519 signature verification via instruction introspection
2. **Oracle Attestation**: Multi-signature threshold for trusted verifiers
3. **Timing Protection**: Random delays before CoinJoin participation
4. **Rate Limiting**: 30 req/min per IP, 5 connections per IP
5. **Encrypted Key Storage**: AES-256-GCM with Argon2 KDF

## Upgrading

### Program Upgrades

```bash
# Build new version
make build-production

# Upgrade deployed program
anchor upgrade target/deploy/stealth.so --program-id 3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT --provider.cluster devnet
```

### Database Migrations

If modifying state structures, ensure backwards compatibility or implement migration logic.

## Support

- GitHub Issues: https://github.com/your-repo/stealthsol/issues
- Documentation: See `/docs` folder
- Technical Spec: See `TECHNICAL_SPEC.md`

## License

MIT License - See LICENSE file for details.
