# Light Protocol Integration (Future)

## Current State

StealthSol currently uses a custom ZK verification approach:
- Groth16 proofs generated off-chain (circuits/)
- On-chain verification requires Solana 2.0 (alt_bn128 syscalls)
- Fallback: Oracle attestation for Solana 1.x

## Why Light Protocol?

[Light Protocol](https://www.lightprotocol.com/) provides production-ready ZK infrastructure for Solana:

### Benefits

1. **Works on Current Solana**
   - No need to wait for Solana 2.0
   - Production-ready today

2. **ZK Compression**
   - Compressed accounts reduce rent costs
   - More efficient state management

3. **Audited & Battle-tested**
   - Security audits completed
   - Used in production applications

4. **Native Privacy Primitives**
   - Built-in private state
   - Efficient nullifier tracking
   - Merkle tree management

### Light Protocol Features

```
┌────────────────────────────────────────────────────────────┐
│                    LIGHT PROTOCOL                          │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ZK Compression          Private State         Indexing    │
│  ├─ Compressed accounts  ├─ Encrypted state   ├─ Photon   │
│  ├─ 10-100x cheaper     ├─ ZK proofs         ├─ Fast     │
│  └─ Same security       └─ Nullifiers        └─ Reliable │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

## Integration Plan

### Phase 1: Research (1-2 weeks)
- [ ] Study Light Protocol documentation
- [ ] Understand compressed account model
- [ ] Review their privacy primitives
- [ ] Assess compatibility with StealthSol

### Phase 2: Prototype (2-3 weeks)
- [ ] Create test integration
- [ ] Migrate nullifier tracking to Light
- [ ] Test Merkle tree operations
- [ ] Benchmark performance

### Phase 3: Migration (3-4 weeks)
- [ ] Replace custom ZK with Light's infrastructure
- [ ] Update privacy pool to use compressed accounts
- [ ] Implement efficient nullifier checks
- [ ] Maintain backward compatibility

### Phase 4: Optimization (1-2 weeks)
- [ ] Optimize for cost (rent savings)
- [ ] Optimize for speed (proof verification)
- [ ] Full integration testing
- [ ] Security audit

## Code Changes Required

### Current Architecture
```
StealthSol
├── Custom Groth16 verifier (zk/)
├── On-chain Merkle tree (state/privacy_pool.rs)
├── Manual nullifier tracking (state/privacy_pool.rs)
└── Oracle attestation fallback
```

### With Light Protocol
```
StealthSol + Light
├── Light's ZK verification
├── Compressed Merkle tree (Light)
├── Light's nullifier infrastructure
└── Photon indexer integration
```

## Resources

- Light Protocol Docs: https://docs.lightprotocol.com/
- GitHub: https://github.com/Lightprotocol
- ZK Compression: https://www.zkcompression.com/

## Notes

The unified privacy flow we implemented is compatible with Light Protocol:
- Deposit/withdraw logic remains the same
- Stealth address derivation unchanged
- Only the ZK infrastructure changes

Migration should be transparent to frontend (Shadowwire).
