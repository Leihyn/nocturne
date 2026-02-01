# Privacy Cash Integration Plan

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    VEIL (Frontend)                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            Stealth Addresses (OUR CODE)             │   │
│  │  - DKSAP implementation                             │   │
│  │  - Recipient privacy                                │   │
│  │  - Meta-address generation                          │   │
│  │  - Scanning for payments                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Privacy Cash SDK (INTEGRATE)              │   │
│  │  - deposit() → shield SOL                           │   │
│  │  - withdraw() → unshield to address                 │   │
│  │  - Relayer handles ZK proofs                        │   │
│  │  - Breaks deposit/withdraw link                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Unified Flow (OUR UX)                  │   │
│  │  - sendPrivate() = PC deposit + note                │   │
│  │  - receivePrivate() = PC withdraw → stealth addr    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## User Flow

### Send Private Payment

```
1. Alice wants to send 5 SOL to Bob privately
2. Alice calls sendPrivate(5 SOL, bobMetaAddress)
3. System:
   a. Deposits 5 SOL to Privacy Cash (gets shielded)
   b. Generates note with Privacy Cash commitment
   c. Returns note code to share with Bob
4. Alice shares note code with Bob (off-chain)
```

### Receive Private Payment

```
1. Bob receives note code from Alice
2. Bob calls receivePrivate(noteCode)
3. System:
   a. Derives fresh stealth address from Bob's meta-address
   b. Withdraws from Privacy Cash → stealth address
   c. Creates announcement for Bob's future scanning
4. Bob's funds are in unlinkable stealth address
```

## Privacy Layers

| Layer | What It Hides | Provider |
|-------|--------------|----------|
| Privacy Cash | Deposit ↔ Withdrawal link | Privacy Cash SDK |
| Stealth Addresses | Recipient identity | Our code |
| Unified Flow | User complexity | Our UX |

## Code Changes Required

### 1. Install SDK

```bash
cd frontend
npm install privacy-cash-sdk
```

### 2. Create Privacy Cash Wrapper

New file: `frontend/src/lib/privacy-cash-client.ts`

```typescript
import { PrivacyCash } from 'privacy-cash-sdk';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

export class PrivacyCashClient {
  private client: PrivacyCash;

  constructor(rpcUrl: string, wallet: Keypair | WalletAdapter) {
    this.client = new PrivacyCash({
      RPC_url: rpcUrl,
      owner: wallet // Handle both keypair and adapter
    });
  }

  async deposit(lamports: number): Promise<DepositResult> {
    return await this.client.deposit(lamports);
  }

  async withdraw(recipient: PublicKey, lamports: number): Promise<WithdrawResult> {
    return await this.client.withdraw(recipient.toBase58(), lamports);
  }

  async getPrivateBalance(): Promise<number> {
    return await this.client.getPrivateBalance();
  }
}
```

### 3. Update Veil SDK (formerly Shadowwire)

Modify: `frontend/src/lib/shadowwire.ts` → `frontend/src/lib/veil.ts`

```typescript
import { PrivacyCashClient } from './privacy-cash-client';
import { computeStealthAddress, ... } from './stealth';

export class Veil {
  private pc: PrivacyCashClient;
  private connection: Connection;

  constructor(connection: Connection, rpcUrl: string) {
    this.connection = connection;
    // PC client initialized when wallet connects
  }

  initWithWallet(wallet: WalletAdapter) {
    this.pc = new PrivacyCashClient(this.rpcUrl, wallet);
  }

  /**
   * Send private payment
   * 1. Deposit to Privacy Cash
   * 2. Generate note for recipient
   */
  async sendPrivate(
    amountSol: number,
    recipientMetaAddress?: string
  ): Promise<{ noteCode: string }> {
    const lamports = amountSol * LAMPORTS_PER_SOL;

    // Deposit to Privacy Cash
    const result = await this.pc.deposit(lamports);

    // Create note with PC commitment + recipient info
    const note = {
      pcCommitment: result.commitment,
      amount: lamports,
      recipientMeta: recipientMetaAddress,
      timestamp: Date.now(),
    };

    return { noteCode: this.encodeNote(note) };
  }

  /**
   * Receive private payment
   * 1. Derive stealth address
   * 2. Withdraw from Privacy Cash → stealth address
   */
  async receivePrivate(noteCode: string): Promise<{ stealthAddress: string }> {
    const note = this.decodeNote(noteCode);
    const identity = this.loadIdentity();

    // Derive fresh stealth address
    const stealth = await computeStealthAddress(
      identity.metaAddress.scanPubkey,
      identity.metaAddress.spendPubkey
    );

    // Withdraw from Privacy Cash to stealth address
    await this.pc.withdraw(stealth.stealthAddress, note.amount);

    // Save announcement for scanning
    saveAnnouncement({
      ephemeralPubkey: bs58.encode(stealth.ephemeralPubkey),
      stealthAddress: stealth.stealthAddress.toBase58(),
      timestamp: Date.now(),
    });

    return { stealthAddress: stealth.stealthAddress.toBase58() };
  }
}
```

### 4. Remove Our Pool Implementation

Delete or deprecate:
- `programs/stealth/src/state/privacy_pool.rs` (keep for reference)
- `frontend/src/lib/zk-crypto.ts` (Merkle tree, etc.)
- `frontend/src/lib/noir-prover.ts` (Privacy Cash handles proofs)

### 5. Update Frontend UI

Rename:
- "Shadowwire" → "Veil"
- Update branding/colors

Simplify:
- Remove "ZK Prover" initialization step (Privacy Cash relayer does this)
- Keep stealth identity generation
- Keep send/receive flow

## What We KEEP

1. **Stealth Addresses** - Our unique value
   - `frontend/src/lib/stealth.ts`
   - DKSAP implementation
   - Meta-address format
   - Scanning logic

2. **Unified Flow UX** - Our innovation
   - Simple send/receive
   - Note sharing
   - Identity management

3. **Noir Proofs** - For Aztec bounty (optional)
   - Can keep as alternative mode
   - Or for future features

## What We REPLACE

1. **Our Pool** → Privacy Cash SDK
   - No more on-chain Merkle tree
   - No more Groth16/Noir proofs for pool
   - Relayer handles everything

2. **Our ZK** → Privacy Cash relayer
   - They generate and verify proofs
   - We just call deposit/withdraw

## Benefits

1. **Bounty Eligible** - $15k Privacy Cash bounty
2. **Battle-Tested** - Their code is audited
3. **Simpler** - Less code to maintain
4. **Compliance** - They have selective disclosure

## Timeline

| Task | Estimate |
|------|----------|
| Install SDK, create wrapper | 2-3 hours |
| Update Veil SDK | 3-4 hours |
| Update frontend UI | 2-3 hours |
| Testing | 2-3 hours |
| **Total** | 1-2 days |

## Risks

1. **SDK Compatibility** - Node 24+ requirement
2. **Wallet Adapter** - May need adapter for browser wallets
3. **Mainnet Only?** - Check if devnet supported
4. **Rate Limits** - Relayer may have limits

## Next Steps

1. [ ] Install privacy-cash-sdk
2. [ ] Create PrivacyCashClient wrapper
3. [ ] Rename shadowwire.ts → veil.ts
4. [ ] Update sendPrivate/receivePrivate to use PC
5. [ ] Update frontend UI (rename, simplify)
6. [ ] Test end-to-end flow
7. [ ] Remove unused pool code
