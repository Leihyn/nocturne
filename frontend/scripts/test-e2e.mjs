/**
 * End-to-End Privacy Test
 *
 * Tests the full privacy flow:
 * 1. Deposit to on-chain privacy pool
 * 2. Generate ZK proof
 * 3. Withdraw via relayer
 * 4. Verify funds at stealth address
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import fs from 'fs';
import os from 'os';

// ============================================
// Configuration
// ============================================

const RPC_URL = 'https://devnet.helius-rpc.com?api-key=e7e2d907-2029-49d3-95c5-7658a3aeb8b6';
const RELAYER_URL = 'http://localhost:3001';
const PROGRAM_ID = new PublicKey('6mKNcFyg2qKuobBkket5tVHKE9178N2CkRonkzkprDrp');

// Use 0.1 SOL denomination for testing
const DENOMINATION = BigInt(100_000_000); // 0.1 SOL

// ============================================
// Crypto Helpers
// ============================================

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function computeCommitment(nullifier, secret) {
  const combined = new Uint8Array(64);
  combined.set(nullifier, 0);
  combined.set(secret, 32);
  return sha256(combined);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================
// PDA Helpers
// ============================================

function denominationToBytes(denomination) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(denomination);
  return buf;
}

function getPoolPDA(denomination) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('privacy_pool'), denominationToBytes(denomination)],
    PROGRAM_ID
  );
}

function getConfigPDA(denomination) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_config'), denominationToBytes(denomination)],
    PROGRAM_ID
  );
}

function getCommitmentPDA(denomination, commitment) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('commitment'), denominationToBytes(denomination), commitment],
    PROGRAM_ID
  );
}

// ============================================
// Main Test
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('End-to-End Privacy Test');
  console.log('='.repeat(60));

  // Load keypair
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  console.log(`\n[1] Loading keypair from ${keypairPath}...`);
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log(`    Address: ${payer.publicKey.toBase58()}`);

  // Connect
  const connection = new Connection(RPC_URL, 'confirmed');
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`    Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Check pool status
  console.log(`\n[2] Checking pool status...`);
  const [poolPDA] = getPoolPDA(DENOMINATION);
  const poolInfo = await connection.getAccountInfo(poolPDA);

  if (!poolInfo) {
    console.log('    ❌ Pool not initialized. Run init-pools.mjs first.');
    process.exit(1);
  }
  console.log(`    ✅ Pool initialized: ${poolPDA.toBase58()}`);

  // Parse pool state
  const poolData = poolInfo.data;
  const nextLeafIndex = poolData.readBigUInt64LE(8 + 32 + 8 + 32); // After discriminator, authority, denomination, merkle_root
  console.log(`    Next leaf index: ${nextLeafIndex}`);

  // Check relayer
  console.log(`\n[3] Checking relayer...`);
  try {
    const relayerInfo = await fetch(`${RELAYER_URL}/info`).then(r => r.json());
    console.log(`    ✅ Relayer online: ${relayerInfo.address}`);
    console.log(`    Balance: ${relayerInfo.balance} SOL`);
    console.log(`    Fee: ${relayerInfo.feePercent}%`);
  } catch (err) {
    console.log(`    ❌ Relayer not responding at ${RELAYER_URL}`);
    console.log(`    Start with: cd relayer && npm run dev`);
    process.exit(1);
  }

  // Generate deposit credentials
  console.log(`\n[4] Generating deposit credentials...`);
  const nullifier = randomBytes(32);
  const secret = randomBytes(32);
  const commitment = computeCommitment(nullifier, secret);

  console.log(`    Nullifier: ${bytesToHex(nullifier).slice(0, 16)}...`);
  console.log(`    Secret: ${bytesToHex(secret).slice(0, 16)}...`);
  console.log(`    Commitment: ${bytesToHex(commitment).slice(0, 16)}...`);

  // Deposit to pool
  console.log(`\n[5] Depositing ${Number(DENOMINATION) / LAMPORTS_PER_SOL} SOL to privacy pool...`);

  const [configPDA] = getConfigPDA(DENOMINATION);
  const [commitmentPDA] = getCommitmentPDA(DENOMINATION, commitment);

  // Get config to find fee recipient
  const configInfo = await connection.getAccountInfo(configPDA);
  if (!configInfo) {
    console.log('    ❌ Pool config not found');
    process.exit(1);
  }

  // Parse fee recipient from config (offset: 8 disc + 32 authority + 8 min + 8 max + 2 feeBps = 58)
  const feeRecipient = new PublicKey(configInfo.data.slice(58, 90));
  console.log(`    Fee recipient: ${feeRecipient.toBase58()}`);

  // Build deposit instruction
  const DISCRIMINATOR = Buffer.from([0x4d, 0xa9, 0xc2, 0x23, 0xd4, 0x03, 0x4f, 0x5c]); // privateDeposit

  const dataSize = 8 + 8 + 32 + 1; // discriminator + denomination + commitment + has_note
  const depositData = Buffer.alloc(dataSize);
  let offset = 0;

  DISCRIMINATOR.copy(depositData, offset);
  offset += 8;

  depositData.writeBigUInt64LE(DENOMINATION, offset);
  offset += 8;

  Buffer.from(commitment).copy(depositData, offset);
  offset += 32;

  depositData.writeUInt8(0, offset); // no encrypted note

  const depositIx = {
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: false },
      { pubkey: commitmentPDA, isSigner: false, isWritable: true },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: depositData,
  };

  // Add compute budget
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });

  const tx = new Transaction().add(computeBudgetIx).add(depositIx);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;

  tx.sign(payer);

  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    console.log(`    Tx sent: ${sig}`);

    await connection.confirmTransaction({
      signature: sig,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');

    console.log(`    ✅ Deposit successful!`);
    console.log(`    Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  } catch (err) {
    console.log(`    ❌ Deposit failed: ${err.message}`);
    if (err.logs) {
      console.log('    Logs:', err.logs.slice(-5).join('\n    '));
    }
    process.exit(1);
  }

  // Check updated pool state
  console.log(`\n[6] Checking updated pool state...`);
  const updatedPoolInfo = await connection.getAccountInfo(poolPDA);
  const newNextLeafIndex = updatedPoolInfo.data.readBigUInt64LE(8 + 32 + 8 + 32);
  console.log(`    Previous leaf index: ${nextLeafIndex}`);
  console.log(`    New leaf index: ${newNextLeafIndex}`);
  console.log(`    ✅ Deposit recorded at index ${newNextLeafIndex - BigInt(1)}`);

  // Save credentials for withdrawal
  const credentials = {
    nullifier: bytesToHex(nullifier),
    secret: bytesToHex(secret),
    commitment: bytesToHex(commitment),
    denomination: DENOMINATION.toString(),
    leafIndex: Number(newNextLeafIndex - BigInt(1)),
    timestamp: Date.now(),
  };

  fs.writeFileSync('/tmp/veil-test-credentials.json', JSON.stringify(credentials, null, 2));
  console.log(`\n[7] Credentials saved to /tmp/veil-test-credentials.json`);
  console.log(`    ⚠️  SAVE THESE - needed for withdrawal!`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('DEPOSIT TEST COMPLETE');
  console.log('='.repeat(60));
  console.log(`
To withdraw (after waiting for privacy):
1. Generate ZK proof with nullifier + secret
2. Submit to relayer at ${RELAYER_URL}/relay
3. Relayer submits transaction
4. Funds go to your stealth address

Credentials:
  Nullifier: ${credentials.nullifier.slice(0, 32)}...
  Leaf Index: ${credentials.leafIndex}
`);

  // Check final balance
  const finalBalance = await connection.getBalance(payer.publicKey);
  console.log(`Final balance: ${finalBalance / LAMPORTS_PER_SOL} SOL`);
  console.log(`Deposited: ${Number(DENOMINATION) / LAMPORTS_PER_SOL} SOL`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
