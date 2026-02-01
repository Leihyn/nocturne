# Full Privacy Architecture

## The Problem

Current limitations prevent true privacy:

| Component | Issue |
|-----------|-------|
| On-chain Poseidon | Exceeds 1.4M compute units |
| Light Protocol | User signs their own accounts (linkable) |
| Relayer | Can't withdraw from user's compressed accounts |

## The Solution

```
┌─────────────────────────────────────────────────────────────────┐
│                    FULL PRIVACY ARCHITECTURE                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   USER SIDE (Off-chain)              SOLANA (On-chain)          │
│   ──────────────────────             ─────────────────          │
│                                                                  │
│   1. Generate secrets                                            │
│      nullifier, secret                                           │
│           │                                                      │
│           ▼                                                      │
│   2. Compute commitment              3. DEPOSIT                  │
│      commitment = Poseidon(          ┌──────────────────┐       │
│        nullifier,                    │ Privacy Pool     │       │
│        secret,                       │ ────────────────  │       │
│        amount                        │ • Merkle root    │       │
│      )                               │ • Total deposits │       │
│           │                          │ • SOL balance    │       │
│           └─────────────────────────►│                  │       │
│                                      │ Insert commitment│       │
│                                      │ to Merkle tree   │       │
│                                      └──────────────────┘       │
│                                                                  │
│   ═══════════════════════════════════════════════════════════   │
│                         WAIT PERIOD                              │
│              (Other users deposit, anonymity grows)              │
│   ═══════════════════════════════════════════════════════════   │
│                                                                  │
│   4. Generate ZK Proof               5. VERIFY & WITHDRAW       │
│      ┌─────────────────────┐        ┌──────────────────┐       │
│      │ Noir/Groth16 Prover │        │ On-chain Verifier│       │
│      │ ─────────────────── │        │ ────────────────  │       │
│      │ Proves:             │        │ • Verify proof   │       │
│      │ • I know nullifier  │        │   (~200k CUs)    │       │
│      │ • I know secret     │───────►│ • Check nullifier│       │
│      │ • Commitment is in  │ proof  │ • Send SOL to    │       │
│      │   Merkle tree       │        │   stealth addr   │       │
│      │ • Nullifier hash    │        └──────────────────┘       │
│      │   is correct        │                 │                  │
│      └─────────────────────┘                 │                  │
│                                              ▼                  │
│   6. RELAYER SUBMITS                  ┌──────────────────┐     │
│      ┌─────────────────────┐          │ Stealth Address  │     │
│      │ Relayer Service     │          │ ────────────────  │     │
│      │ ─────────────────── │          │ • Receives SOL   │     │
│      │ • Receives proof    │          │ • Unlinkable to  │     │
│      │ • Pays gas          │─────────►│   depositor      │     │
│      │ • Takes fee         │          │ • User can spend │     │
│      │ • Submits tx        │          │   with stealth   │     │
│      └─────────────────────┘          │   private key    │     │
│                                       └──────────────────┘     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Innovation: On-chain Proof Verification (Not Computation)

### Old Approach (Too Expensive)
```rust
// On-chain: Compute Poseidon hash (1.4M+ CUs) ❌
let commitment = poseidon_hash(&[nullifier, secret, amount]);
let root = compute_merkle_root(commitment, path); // More Poseidon calls
```

### New Approach (Efficient)
```rust
// On-chain: Just verify the proof (~200k CUs) ✅
let is_valid = groth16_verify(
    &verification_key,  // Pre-stored
    &proof,             // From user
    &public_inputs      // merkle_root, nullifier_hash, recipient
);
```

## Implementation Components

### 1. Groth16 Circuit (Circom)
```circom
template Withdraw() {
    // Public inputs
    signal input merkleRoot;
    signal input nullifierHash;
    signal input recipient;
    signal input amount;

    // Private inputs
    signal input nullifier;
    signal input secret;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];

    // Verify nullifier hash
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // Compute commitment
    component commitmentHasher = Poseidon(3);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== amount;

    // Verify Merkle proof
    component merkleProof = MerkleTreeChecker(DEPTH);
    merkleProof.leaf <== commitmentHasher.out;
    for (var i = 0; i < DEPTH; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;
}
```

### 2. On-chain Verifier (Solana)
```rust
use solana_program::alt_bn128::prelude::*;

pub fn verify_withdrawal_proof(
    vk: &VerificationKey,
    proof: &Groth16Proof,
    public_inputs: &[Fr; 4], // root, nullifier_hash, recipient, amount
) -> bool {
    // Solana's native alt_bn128 operations
    // ~200k compute units
    groth16_verify(vk, proof, public_inputs)
}
```

### 3. Privacy Pool (Updated)
```rust
#[account]
pub struct PrivacyPool {
    pub merkle_root: [u8; 32],      // Updated off-chain, verified via proof
    pub verification_key: [u8; 512], // Groth16 VK
    pub total_deposited: u64,
    pub denomination: u64,
}

pub fn withdraw(
    ctx: Context<Withdraw>,
    proof: Groth16Proof,
    nullifier_hash: [u8; 32],
    recipient: Pubkey,
) -> Result<()> {
    // 1. Verify proof (~200k CUs)
    require!(
        verify_proof(&ctx.accounts.pool.verification_key, &proof, ...),
        "Invalid proof"
    );

    // 2. Check nullifier not used
    require!(!is_nullifier_used(&nullifier_hash), "Double spend");

    // 3. Mark nullifier used
    mark_nullifier_used(&nullifier_hash);

    // 4. Transfer SOL to recipient
    transfer_sol(&ctx.accounts.pool, &recipient, amount);

    Ok(())
}
```

### 4. Relayer Service
```typescript
app.post('/withdraw', async (req, res) => {
    const { proof, nullifierHash, recipient, merkleRoot } = req.body;

    // Verify proof format
    if (!isValidProofFormat(proof)) {
        return res.status(400).json({ error: 'Invalid proof' });
    }

    // Build and submit transaction
    const tx = buildWithdrawTx(proof, nullifierHash, recipient);
    tx.feePayer = relayerKeypair.publicKey; // Relayer pays

    const sig = await sendTransaction(tx);

    res.json({ signature: sig, fee: RELAYER_FEE });
});
```

## Privacy Guarantees

| Property | How It's Achieved |
|----------|-------------------|
| **Amount Hidden** | Fixed denominations (all deposits same size) |
| **Deposit-Withdrawal Unlinkable** | ZK proof - proves membership without revealing which |
| **Recipient Hidden** | Stealth address (ECDH-derived one-time address) |
| **Submitter Hidden** | Relayer submits tx (user's wallet never on-chain) |

## Compute Budget Comparison

| Operation | Old (Poseidon on-chain) | New (Proof verification) |
|-----------|------------------------|--------------------------|
| Deposit | 1.4M+ CUs ❌ | ~100k CUs ✅ |
| Withdraw | 1.4M+ CUs ❌ | ~200k CUs ✅ |

## File Structure

```
stealthsol/
├── circuits/
│   └── groth16/
│       ├── withdraw.circom      # Withdrawal circuit
│       ├── deposit.circom       # Deposit circuit
│       └── build/
│           ├── withdraw.wasm    # Compiled circuit
│           ├── withdraw.zkey    # Proving key
│           └── verification_key.json
├── programs/
│   └── stealth/
│       └── src/
│           ├── groth16_verifier.rs  # On-chain verifier
│           └── instructions/
│               └── verified_withdraw.rs
├── frontend/
│   └── src/lib/
│       ├── groth16-prover.ts    # Browser prover
│       └── privacy-pool.ts      # Pool integration
└── relayer/
    └── src/
        └── server.ts            # Relayer with proof support
```

## Next Steps

1. **Create Circom circuit** for withdrawal
2. **Generate proving/verification keys** (trusted setup)
3. **Implement Groth16 verifier** in Solana program
4. **Update pool** to use proof verification
5. **Update relayer** to accept and forward proofs
6. **Test end-to-end** with full privacy
