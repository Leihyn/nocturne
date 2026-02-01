# Nocturne Privacy

Elegant privacy protocol for Solana with stealth addresses, ZK proofs, and confidential transfers.

## Features

- **Stealth Addresses**: Generate unique addresses for each payment (DKSAP)
- **Privacy Pools**: Shield SOL using fixed denominations (0.1, 1, 10, 100 SOL)
- **Confidential Amounts**: Hide arbitrary amounts with Bulletproof range proofs
- **P2P CoinJoin**: Blind signature-based deposit mixing
- **Light Protocol**: Compressed account support for cost savings

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Open http://localhost:3000
```

## Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_PROGRAM_ID=3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT
NEXT_PUBLIC_NETWORK=devnet
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_VERIFIER_URL=http://localhost:3001
NEXT_PUBLIC_COINJOIN_URL=ws://localhost:3002
```

## Usage

### 1. Generate Identity

```typescript
import { Shadowwire } from './lib/shadowwire';

const sw = new Shadowwire(connection);
const identity = await sw.generateIdentity(wallet.publicKey);

// Share your meta-address to receive payments
console.log(identity.metaAddress.encoded);
// stealth:5Kd8...
```

### 2. Send Private Payment (Fixed Denomination)

```typescript
// Send 1 SOL privately
const { note, noteCode } = await sw.sendPrivate(
  wallet.publicKey,
  1, // 1, 10, or 100 SOL
  signTransaction
);

// Share noteCode with recipient
```

### 3. Send Confidential Amount (Any Amount)

```typescript
// Send 2.5 SOL with Bulletproof hiding
const { note, noteCode } = await sw.sendConfidentialAmount(
  wallet.publicKey,
  2.5, // Any amount
  signTransaction
);
```

### 4. Receive Payment

```typescript
// Recipient uses the noteCode to withdraw
const result = await sw.receivePrivate(
  wallet.publicKey,
  noteCode,
  signTransaction
);

console.log('Received at:', result.stealthAddress);
```

## Project Structure

```
frontend/
├── src/
│   ├── app/              # Next.js app router
│   ├── components/       # React components
│   └── lib/              # Core libraries
│       ├── shadowwire.ts     # Main SDK
│       ├── stealth.ts        # DKSAP implementation
│       ├── bulletproof.ts    # Range proofs
│       ├── privacy-pool.ts   # Pool operations
│       ├── zk-crypto.ts      # ZK primitives
│       ├── noir-prover.ts    # Noir circuit prover
│       ├── light-privacy.ts  # Light Protocol
│       └── program.ts        # On-chain instructions
├── public/
│   └── circuits/         # Noir circuit files
└── test-*.mjs           # Test scripts
```

## Key Libraries

| Library | Purpose |
|---------|---------|
| `shadowwire.ts` | Unified privacy SDK |
| `stealth.ts` | DKSAP stealth addresses |
| `bulletproof.ts` | Bulletproof range proofs |
| `light-privacy.ts` | Light Protocol compression |
| `coinjoin/client.ts` | P2P blind CoinJoin |

## Privacy Modes

| Mode | Amount Hidden | Recipient Hidden | Link Hidden |
|------|--------------|------------------|-------------|
| Fixed Denomination | Yes (uniformity) | Yes (stealth) | Yes (ZK proof) |
| Confidential | Yes (Bulletproof) | Yes (stealth) | Yes (ZK proof) |
| CoinJoin + Pool | Yes | Yes | Yes + Depositor hidden |

## Testing

```bash
# Run Light Protocol test
node test-light-protocol.mjs

# Run in browser
npm run dev
# Open DevTools console for debugging
```

## Building for Production

```bash
npm run build
npm run start
```

## Learn More

- [Deployment Guide](../DEPLOYMENT.md) - Full deployment instructions
- [Technical Spec](../TECHNICAL_SPEC.md) - Architecture details
- [Security Analysis](../SECURITY_ANALYSIS.md) - Security considerations

## License

MIT
