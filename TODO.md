# StealthSol Privacy Enhancement TODO

## Current Status
- [x] Stealth addresses (DKSAP) - hides recipient
- [x] Fixed-denomination pools - hides amount
- [x] ZK proofs (Noir) - hides deposit-withdrawal link
- [x] Stealth withdrawals - hides withdrawal recipient
- [x] **Depositor privacy** - P2P Blind CoinJoin (IMPLEMENTED)

## Option B: Simple Batched Deposits (Backup Plan)
> Simpler alternative if P2P CoinJoin proves too complex

- [ ] Deposit queue contract
- [ ] Batch processing when N users ready
- [ ] Random commitment ordering
- [ ] Single transaction for all deposits

## Option C: P2P Blind CoinJoin (IMPLEMENTING)
> Full cryptographic privacy for depositors

### Architecture
```
┌─────────────────────────────────────────────────┐
│  P2P BLIND COINJOIN PROTOCOL                    │
├─────────────────────────────────────────────────┤
│  Phase 1: COORDINATION                          │
│  - Users connect to coordination layer          │
│  - Wait for N participants (min 5)              │
│  - Exchange public keys                         │
├─────────────────────────────────────────────────┤
│  Phase 2: BLINDING                              │
│  - Each user blinds their commitment            │
│  - Blinded commitments sent to coordinator      │
│  - Coordinator signs without seeing values      │
├─────────────────────────────────────────────────┤
│  Phase 3: SHUFFLE                               │
│  - Users unblind signatures                     │
│  - Submit unblinded commitments anonymously     │
│  - Commitments shuffled (unlinkable to users)   │
├─────────────────────────────────────────────────┤
│  Phase 4: TRANSACTION                           │
│  - Multi-input transaction constructed          │
│  - All users sign their inputs                  │
│  - Single tx submitted to Solana                │
├─────────────────────────────────────────────────┤
│  Result: Observer sees N depositors             │
│  but CANNOT link depositor → commitment         │
│  (Cryptographic guarantee via blind signatures) │
└─────────────────────────────────────────────────┘
```

### Implementation Tasks
- [x] Blind signature library (RSA blind sigs)
- [x] Coordination server (WebSocket)
- [x] Client-side protocol handler
- [x] Multi-signer transaction builder
- [x] Timeout/abort handling
- [x] Frontend UI for CoinJoin deposits
- [ ] Testing with multiple participants

### Files Created
- [x] `coinjoin/src/server.ts` - Coordination server
- [x] `coinjoin/src/blind-sig.ts` - Blind signature crypto
- [x] `coinjoin/src/types.ts` - Protocol types
- [x] `frontend/src/lib/coinjoin/client.ts` - Client protocol
- [x] `frontend/src/lib/coinjoin/transaction-builder.ts` - Multi-signer tx builder
- [x] `frontend/src/lib/coinjoin/index.ts` - Frontend exports

## Hackathon Bounties Target
- [ ] Track 01: Private Payments ($15k) - MAIN TARGET
- [ ] Aztec/Noir Bounty ($10k) - Already using Noir
- [ ] Helius Bounty ($5k) - Switch to Helius RPC
- [ ] Quicknode Bounty ($3k) - Use Quicknode RPC

## Privacy Properties After CoinJoin
| Property | Status | Method |
|----------|--------|--------|
| Amount | HIDDEN | Fixed denomination pools |
| Deposit→Withdrawal | HIDDEN | ZK proof (Noir) |
| Recipient | HIDDEN | Stealth addresses |
| **Depositor** | **HIDDEN** | **P2P Blind CoinJoin** |

## Timeline
- [x] Day 1: Blind signature implementation
- [x] Day 2: Coordination server + client protocol
- [x] Day 3: Frontend integration + testing
- [ ] Day 4: Polish, documentation, demo video

## How to Test CoinJoin

1. Start the CoinJoin coordination server:
   ```bash
   cd coinjoin && npm run dev
   ```

2. Start the frontend:
   ```bash
   cd frontend && npm run dev
   ```

3. Open multiple browser windows/tabs with different wallets
4. Enable "P2P CoinJoin Deposit" toggle on each
5. Click deposit on each (they will wait for 5 participants by default)
6. Once all participants join, the protocol executes automatically
