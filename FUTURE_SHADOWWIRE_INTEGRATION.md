# Future Project: ShadowWire Integration (Option B)

Saved for future project development.

## Architecture

```
┌─────────────────────────────────────┐
│         FRONTEND                    │
├─────────────────────────────────────┤
│  Stealth Addresses (KEEP)           │  ← Recipient privacy
│  - DKSAP implementation             │
│  - Scan/Spend keypairs              │
│  - Meta-address sharing             │
├─────────────────────────────────────┤
│  ShadowWire SDK (ADD)               │  ← Bounty eligible
│  - Bulletproof amount hiding        │
│  - Any amount (not just 1/10/100)   │
│  - Curve25519-Dalek cryptography    │
├─────────────────────────────────────┤
│  Simplified Pool (KEEP)             │  ← Deposit/withdraw unlinking
│  - Merkle tree commitments          │
│  - Nullifier tracking               │
└─────────────────────────────────────┘
```

## Radr Labs ShadowWire Overview

**Website:** https://www.radrlabs.io/
**Documentation:** https://www.radrlabs.io/docs/shadowid

### What ShadowWire Provides

- Bulletproofs for hiding arbitrary amounts (not fixed denominations)
- Curve25519-Dalek cryptography
- NPM SDK (3 lines of code to integrate)
- Two transfer modes:
  - **Standard**: Sender hidden, amount + receiver visible
  - **Maximum**: Sender hidden, amount hidden, receiver hidden (Radr-to-Radr)

### Key Difference from Fixed Denominations

| Fixed Denomination Approach | ShadowWire Bulletproofs |
|----------------------------|------------------------|
| Hide amount by uniformity (1/10/100 SOL) | Hide any amount via ZK proof |
| Limited flexibility | Full flexibility |
| Larger anonymity sets | Smaller but arbitrary amounts |

## Integration Plan

### Step 1: Install ShadowWire SDK

```bash
npm install @radrlabs/shadowwire-sdk
```

### Step 2: Replace Amount Handling

**Current (Fixed Denominations):**
```typescript
const DENOMINATIONS = {
  SMALL: 1 * LAMPORTS_PER_SOL,
  MEDIUM: 10 * LAMPORTS_PER_SOL,
  LARGE: 100 * LAMPORTS_PER_SOL,
};
```

**With ShadowWire:**
```typescript
import { ShadowWire } from '@radrlabs/shadowwire-sdk';

// Any amount, hidden via Bulletproofs
const sw = new ShadowWire(connection);
await sw.privateTransfer(wallet, recipient, anyAmount);
```

### Step 3: Keep Stealth Addresses

ShadowWire hides amounts, but NOT recipients. Combine with stealth addresses:

```typescript
// 1. Derive stealth address for recipient
const stealthAddr = deriveStealthAddress(recipientMetaAddress);

// 2. Send via ShadowWire (amount hidden)
await shadowWire.privateTransfer(wallet, stealthAddr, amount);

// 3. Recipient scans and withdraws from stealth address
```

### Step 4: Optional Pool Layer

Keep simplified pool for deposit/withdraw unlinking:

```
User → ShadowWire transfer → Pool deposit → [break link] → Pool withdraw → Stealth address
```

## Privacy Stack Comparison

| Layer | What It Hides | Technology |
|-------|--------------|------------|
| Stealth Addresses | Recipient identity | DKSAP (Curve25519) |
| ShadowWire | Transaction amount | Bulletproofs |
| Pool (optional) | Deposit/withdraw link | Merkle tree + ZK |

## Bounty Potential

**Radr Labs ShadowWire Bounty: $15,000**
- Grand Prize: $10k
- Best integration of USD1: $2.5k
- Best integration to existing app: $2.5k

## Resources

- Radr Labs: https://www.radrlabs.io/
- ShadowID Docs: https://www.radrlabs.io/docs/shadowid
- Radr Fun: https://www.radr.fun/

## Notes

- ShadowWire uses Curve25519 (same as our stealth addresses) - good compatibility
- Bulletproofs are more computationally expensive than fixed denominations
- Consider offering both modes: "Fast" (fixed denom) vs "Flexible" (Bulletproofs)
