# Groth16 On-Chain Verification - Status

## What's Implemented

✅ **On-chain Groth16 verifier** (`programs/stealth/src/zk/groth16.rs`)
- Uses Solana's alt_bn128 precompiles
- Implements full pairing check

✅ **verified_withdraw instruction** (`programs/stealth/src/instructions/verified_withdraw.rs`)
- Loads VK from PDA
- Verifies proof on-chain
- Transfers funds

✅ **Relayer with Groth16 endpoint** (`relayer/src/server.ts`)
- POST /relay-groth16
- Validates proof format
- Sets compute budget

✅ **Frontend client** (`frontend/src/lib/relayer.ts`)
- Groth16RelayerClient class
- Type-safe API

✅ **Supporting scripts**
- VK conversion
- VK initialization
- E2E test

## What's NOT Working Yet

### 1. Program Not Deployed ❌
The current deployed program doesn't have `verified_withdraw`.

**Fix:**
```bash
anchor build
anchor deploy --provider.cluster devnet
```

### 2. alt_bn128 Precompile Availability ❌
Solana's alt_bn128 precompiles (for BN254 curve operations) were added in v1.16, but:
- May not be enabled on all devnet validators
- Compute costs may vary

**Check:**
```bash
solana feature status alt_bn128_compression
```

### 3. Verification Key Not Initialized ❌
The VK PDA needs to be created before withdrawals work.

**Fix:**
```bash
cd frontend && node scripts/init-verification-key.mjs
```

### 4. Merkle Tree Sync ❌
The test script uses a simplified Merkle tree. Real usage needs:
- Query actual on-chain Merkle root
- Get correct path elements from pool state

### 5. Circuit Compatibility ⚠️
The withdraw.circom circuit expects:
- commitment = Poseidon(nullifier, secret, amount, recipient)
- 4 public inputs in specific order

The proof generation must match exactly.

## Testing Checklist

1. [ ] Deploy updated program with `verified_withdraw`
2. [ ] Initialize verification key on-chain
3. [ ] Make a deposit to get a valid commitment in the Merkle tree
4. [ ] Query the actual Merkle root and path from on-chain state
5. [ ] Generate proof with correct public inputs
6. [ ] Submit via relayer

## Alternative: Use Oracle Mode (Works Now)

The existing `private_withdraw` with oracle attestation works on devnet:
- Uses Ed25519 signature verification (available everywhere)
- Requires trusted verifier to attest proof validity
- Less trustless but functional

## Compute Budget

| Operation | Estimated CUs |
|-----------|---------------|
| alt_bn128_multiplication | ~40k per call |
| alt_bn128_addition | ~10k per call |
| alt_bn128_pairing (4 pairs) | ~150k |
| **Total Groth16 verification** | **~200k CUs** |

This fits within Solana's 1.4M compute limit.

## To Make It Work

```bash
# 1. Build and deploy the program
cd /path/to/stealthsol
anchor build
anchor deploy --provider.cluster devnet

# 2. Initialize verification key
cd frontend
node scripts/init-verification-key.mjs

# 3. Start relayer
cd ../relayer
npm run dev

# 4. Test (after making a deposit)
cd ../frontend
node scripts/test-groth16-e2e.mjs
```

## Why Oracle Mode Works But Groth16 Might Not

| Aspect | Oracle Mode | Groth16 Mode |
|--------|-------------|--------------|
| Verification | Off-chain (Ed25519 sig) | On-chain (alt_bn128) |
| Trust | Trusted verifier | Trustless |
| Availability | Works everywhere | Needs alt_bn128 enabled |
| Compute | ~50k CUs | ~200k CUs |
| Current Status | ✅ Working | ⚠️ Needs deployment |
