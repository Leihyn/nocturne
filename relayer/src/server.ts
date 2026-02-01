/**
 * Veil Privacy Relayer
 *
 * Submits withdrawal transactions on behalf of users, paying gas fees.
 * This prevents linking the user's wallet to the withdrawal.
 *
 * Flow:
 * 1. User generates ZK proof locally (Groth16)
 * 2. User sends proof + recipient to relayer
 * 3. Relayer verifies proof format
 * 4. Relayer submits transaction (pays gas)
 * 5. Relayer takes fee from withdrawal amount
 *
 * Supports two modes:
 * - /relay: Oracle-attested proof verification (legacy)
 * - /relay-groth16: On-chain Groth16 verification (trustless)
 */

import express from 'express';
import cors from 'cors';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';

// ============================================
// Configuration
// ============================================

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || '6mKNcFyg2qKuobBkket5tVHKE9178N2CkRonkzkprDrp');

// Relayer fee: 0.5% of withdrawal amount
const RELAYER_FEE_PERCENT = 0.005;
// Minimum fee in lamports (to cover gas)
const MIN_FEE_LAMPORTS = 10_000_000; // 0.01 SOL

// Load relayer keypair from environment
function loadRelayerKeypair(): Keypair {
  const privateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!privateKey) {
    console.warn('⚠️ No RELAYER_PRIVATE_KEY set. Generating ephemeral keypair for testing.');
    return Keypair.generate();
  }
  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

const relayerKeypair = loadRelayerKeypair();
const connection = new Connection(RPC_URL, 'confirmed');

console.log('Relayer Configuration:');
console.log(`  RPC: ${RPC_URL}`);
console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
console.log(`  Relayer Address: ${relayerKeypair.publicKey.toBase58()}`);
console.log(`  Fee: ${RELAYER_FEE_PERCENT * 100}%`);

// ============================================
// PDA Seeds (must match on-chain program)
// ============================================

const POOL_SEED = Buffer.from('privacy_pool');
const NULLIFIER_SEED = Buffer.from('nullifier');
const ANNOUNCEMENT_SEED = Buffer.from('announcement');
const VK_SEED = Buffer.from('vk');

function denominationToBytes(denomination: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(denomination);
  return buf;
}

function getPoolPDA(denomination: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, denominationToBytes(denomination)],
    PROGRAM_ID
  );
}

function getConfigPDA(denomination: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_config'), denominationToBytes(denomination)],
    PROGRAM_ID
  );
}

function getNullifierPDA(denomination: bigint, nullifierHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, denominationToBytes(denomination), nullifierHash],
    PROGRAM_ID
  );
}

function getAnnouncementPDA(ephemeralPubkey: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ANNOUNCEMENT_SEED, ephemeralPubkey],
    PROGRAM_ID
  );
}

function getVKPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VK_SEED], PROGRAM_ID);
}

// ============================================
// Types
// ============================================

interface WithdrawRequest {
  // ZK proof data
  proof: number[];           // Groth16 proof bytes
  merkleRoot: number[];      // 32 bytes
  nullifierHash: number[];   // 32 bytes

  // Stealth address data
  stealthAddress: string;    // Base58 public key
  ephemeralPubkey: number[]; // 32 bytes
  scanPubkey: number[];      // 32 bytes
  spendPubkey: number[];     // 32 bytes
  stealthCommitment: number[]; // 32 bytes

  // Denomination (always 1 SOL now)
  denomination: string;      // Bigint as string
}

interface RelayResult {
  success: boolean;
  signature?: string;
  error?: string;
  fee?: number;
}

// ============================================
// Groth16 Types (On-Chain Verification)
// ============================================

interface Groth16WithdrawRequest {
  // Groth16 proof (256 bytes total)
  piA: number[];  // 64 bytes (G1 point)
  piB: number[];  // 128 bytes (G2 point)
  piC: number[];  // 64 bytes (G1 point)

  // Public inputs
  merkleRoot: number[];     // 32 bytes
  nullifierHash: number[];  // 32 bytes
  recipient: string;        // Base58 public key
  amount: string;           // Amount in lamports as string

  // Denomination (pool)
  denomination: string;
}

// ============================================
// Instruction Builder
// ============================================

const WITHDRAW_DISCRIMINATOR = Buffer.from([0x5a, 0xee, 0x07, 0x11, 0x61, 0x06, 0xb5, 0xdd]);

function buildWithdrawInstruction(
  relayer: PublicKey,
  request: WithdrawRequest,
  relayerFee: bigint
): TransactionInstruction {
  const denomination = BigInt(request.denomination);
  const stealthAddress = new PublicKey(request.stealthAddress);

  // Derive PDAs
  const [poolPDA] = getPoolPDA(denomination);
  const [configPDA] = getConfigPDA(denomination);
  const [nullifierPDA] = getNullifierPDA(denomination, new Uint8Array(request.nullifierHash));
  const [announcementPDA] = getAnnouncementPDA(new Uint8Array(request.ephemeralPubkey));

  // Serialize instruction data
  const proofLen = request.proof.length;
  // No attestation for devnet testing
  const hasAttestation = 0;

  // Data format:
  // discriminator (8) + denomination (8) + proof_len (4) + proof + public_inputs (224) + has_attestation (1) + relayer_fee (8)
  const dataSize = 8 + 8 + 4 + proofLen + 224 + 1 + 8;
  const data = Buffer.alloc(dataSize);

  let offset = 0;

  // Discriminator
  WITHDRAW_DISCRIMINATOR.copy(data, offset);
  offset += 8;

  // Denomination
  data.writeBigUInt64LE(denomination, offset);
  offset += 8;

  // Proof length and bytes
  data.writeUInt32LE(proofLen, offset);
  offset += 4;

  Buffer.from(request.proof).copy(data, offset);
  offset += proofLen;

  // Public inputs: merkle_root(32) + nullifier_hash(32) + stealth_address(32) + ephemeral(32) + scan(32) + spend(32) + commitment(32)
  Buffer.from(request.merkleRoot).copy(data, offset);
  offset += 32;

  Buffer.from(request.nullifierHash).copy(data, offset);
  offset += 32;

  stealthAddress.toBuffer().copy(data, offset);
  offset += 32;

  Buffer.from(request.ephemeralPubkey).copy(data, offset);
  offset += 32;

  Buffer.from(request.scanPubkey).copy(data, offset);
  offset += 32;

  Buffer.from(request.spendPubkey).copy(data, offset);
  offset += 32;

  Buffer.from(request.stealthCommitment).copy(data, offset);
  offset += 32;

  // No attestation
  data.writeUInt8(hasAttestation, offset);
  offset += 1;

  // Relayer fee
  data.writeBigUInt64LE(relayerFee, offset);

  // Build accounts (must match PrivateWithdraw struct order)
  const accounts = [
    { pubkey: relayer, isSigner: true, isWritable: true },           // 1. relayer
    { pubkey: poolPDA, isSigner: false, isWritable: true },          // 2. pool
    { pubkey: configPDA, isSigner: false, isWritable: false },       // 3. config
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },     // 4. nullifier
    { pubkey: stealthAddress, isSigner: false, isWritable: true },   // 5. stealth_address
    { pubkey: announcementPDA, isSigner: false, isWritable: true },  // 6. announcement
    { pubkey: relayer, isSigner: false, isWritable: true },          // 7. relayer_fee_recipient (optional - use relayer as recipient)
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, // 8. instructions_sysvar
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },    // 9. system_program
  ];

  return new TransactionInstruction({
    keys: accounts,
    programId: PROGRAM_ID,
    data,
  });
}

// ============================================
// Groth16 Instruction Builder (On-Chain Verification)
// ============================================

// Anchor discriminator for verified_withdraw
// sha256("global:verified_withdraw")[0..8]
const VERIFIED_WITHDRAW_DISCRIMINATOR = Buffer.from([0x44, 0x34, 0x81, 0x6c, 0x29, 0xc8, 0x4e, 0xb1]);

function buildGroth16WithdrawInstruction(
  relayer: PublicKey,
  request: Groth16WithdrawRequest,
  relayerFee: bigint
): TransactionInstruction {
  const denomination = BigInt(request.denomination);
  const recipient = new PublicKey(request.recipient);
  const amount = BigInt(request.amount);

  // Derive PDAs
  const [poolPDA] = getPoolPDA(denomination);
  const [configPDA] = getConfigPDA(denomination);
  const [vkPDA] = getVKPDA();
  const [nullifierPDA] = getNullifierPDA(denomination, new Uint8Array(request.nullifierHash));

  // Serialize instruction data
  // Format:
  // discriminator (8) +
  // denomination (8) +
  // public_inputs: merkle_root(32) + nullifier_hash(32) + recipient(32) + amount(32) = 128 +
  // proof: piA(64) + piB(128) + piC(64) = 256 +
  // relayer_fee (8)
  const dataSize = 8 + 8 + 128 + 256 + 8;
  const data = Buffer.alloc(dataSize);

  let offset = 0;

  // Discriminator
  VERIFIED_WITHDRAW_DISCRIMINATOR.copy(data, offset);
  offset += 8;

  // Denomination
  data.writeBigUInt64LE(denomination, offset);
  offset += 8;

  // Public inputs
  // merkle_root
  Buffer.from(request.merkleRoot).copy(data, offset);
  offset += 32;

  // nullifier_hash
  Buffer.from(request.nullifierHash).copy(data, offset);
  offset += 32;

  // recipient (as 32 bytes)
  recipient.toBuffer().copy(data, offset);
  offset += 32;

  // amount (as 32-byte field element, little-endian in first 8 bytes)
  const amountBytes = Buffer.alloc(32);
  amountBytes.writeBigUInt64LE(amount, 0);
  amountBytes.copy(data, offset);
  offset += 32;

  // Proof
  // piA (64 bytes)
  Buffer.from(request.piA).copy(data, offset);
  offset += 64;

  // piB (128 bytes)
  Buffer.from(request.piB).copy(data, offset);
  offset += 128;

  // piC (64 bytes)
  Buffer.from(request.piC).copy(data, offset);
  offset += 64;

  // Relayer fee
  data.writeBigUInt64LE(relayerFee, offset);

  // Build accounts (must match VerifiedWithdraw struct order)
  const accounts = [
    { pubkey: relayer, isSigner: true, isWritable: true },           // 1. relayer
    { pubkey: poolPDA, isSigner: false, isWritable: true },          // 2. pool
    { pubkey: configPDA, isSigner: false, isWritable: false },       // 3. config
    { pubkey: vkPDA, isSigner: false, isWritable: false },           // 4. verification_key
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },     // 5. nullifier
    { pubkey: recipient, isSigner: false, isWritable: true },        // 6. recipient
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 7. system_program
  ];

  return new TransactionInstruction({
    keys: accounts,
    programId: PROGRAM_ID,
    data,
  });
}

// ============================================
// API Server
// ============================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Root route - API info
app.get('/', (req, res) => {
  res.json({
    name: 'Veil Privacy Relayer',
    version: '2.0.0',
    description: 'Submits private withdrawals on behalf of users to prevent wallet linking',
    endpoints: {
      'GET /': 'This info page',
      'GET /health': 'Health check',
      'GET /info': 'Relayer address, balance, and fee info',
      'POST /relay': 'Submit a withdrawal (oracle-attested proof)',
      'POST /relay-groth16': 'Submit a withdrawal (on-chain Groth16 verification - TRUSTLESS)',
    },
    relayer: relayerKeypair.publicKey.toBase58(),
    program: PROGRAM_ID.toBase58(),
    fee: `${RELAYER_FEE_PERCENT * 100}%`,
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    relayer: relayerKeypair.publicKey.toBase58(),
    program: PROGRAM_ID.toBase58(),
    fee: `${RELAYER_FEE_PERCENT * 100}%`,
  });
});

// Get relayer info
app.get('/info', async (req, res) => {
  try {
    const balance = await connection.getBalance(relayerKeypair.publicKey);
    res.json({
      address: relayerKeypair.publicKey.toBase58(),
      balance: balance / LAMPORTS_PER_SOL,
      feePercent: RELAYER_FEE_PERCENT * 100,
      minFeeSol: MIN_FEE_LAMPORTS / LAMPORTS_PER_SOL,
      program: PROGRAM_ID.toBase58(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get relayer info' });
  }
});

// Submit withdrawal
app.post('/relay', async (req, res) => {
  try {
    const request: WithdrawRequest = req.body;

    // Validate request
    if (!request.proof || !request.merkleRoot || !request.nullifierHash) {
      return res.status(400).json({ error: 'Missing proof data' });
    }

    if (!request.stealthAddress || !request.ephemeralPubkey) {
      return res.status(400).json({ error: 'Missing stealth address data' });
    }

    const denomination = BigInt(request.denomination || '1000000000');

    // Calculate relayer fee
    let relayerFee = BigInt(Math.floor(Number(denomination) * RELAYER_FEE_PERCENT));
    if (relayerFee < BigInt(MIN_FEE_LAMPORTS)) {
      relayerFee = BigInt(MIN_FEE_LAMPORTS);
    }

    console.log(`\n[Relay] Processing withdrawal:`);
    console.log(`  Recipient: ${request.stealthAddress}`);
    console.log(`  Amount: ${Number(denomination) / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Fee: ${Number(relayerFee) / LAMPORTS_PER_SOL} SOL`);

    // Check if nullifier already used
    const [nullifierPDA] = getNullifierPDA(denomination, new Uint8Array(request.nullifierHash));
    const nullifierAccount = await connection.getAccountInfo(nullifierPDA);
    if (nullifierAccount) {
      return res.status(400).json({ error: 'Nullifier already used (double-spend attempt)' });
    }

    // Build transaction
    const instruction = buildWithdrawInstruction(
      relayerKeypair.publicKey,
      request,
      relayerFee
    );

    const transaction = new Transaction().add(instruction);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = relayerKeypair.publicKey;

    // Sign and send
    console.log(`  Submitting transaction...`);
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [relayerKeypair],
      { commitment: 'confirmed' }
    );

    console.log(`  Success: ${signature}`);

    const result: RelayResult = {
      success: true,
      signature,
      fee: Number(relayerFee) / LAMPORTS_PER_SOL,
    };

    res.json(result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Relay] Error: ${errorMsg}`);

    const result: RelayResult = {
      success: false,
      error: errorMsg,
    };

    res.status(500).json(result);
  }
});

// Submit Groth16 withdrawal (on-chain verification - TRUSTLESS)
app.post('/relay-groth16', async (req, res) => {
  try {
    const request: Groth16WithdrawRequest = req.body;

    // Validate request
    if (!request.piA || !request.piB || !request.piC) {
      return res.status(400).json({ error: 'Missing proof data (piA, piB, piC)' });
    }

    if (request.piA.length !== 64) {
      return res.status(400).json({ error: 'Invalid piA length (expected 64 bytes)' });
    }

    if (request.piB.length !== 128) {
      return res.status(400).json({ error: 'Invalid piB length (expected 128 bytes)' });
    }

    if (request.piC.length !== 64) {
      return res.status(400).json({ error: 'Invalid piC length (expected 64 bytes)' });
    }

    if (!request.merkleRoot || request.merkleRoot.length !== 32) {
      return res.status(400).json({ error: 'Invalid merkleRoot (expected 32 bytes)' });
    }

    if (!request.nullifierHash || request.nullifierHash.length !== 32) {
      return res.status(400).json({ error: 'Invalid nullifierHash (expected 32 bytes)' });
    }

    if (!request.recipient) {
      return res.status(400).json({ error: 'Missing recipient address' });
    }

    const denomination = BigInt(request.denomination || '100000000'); // Default 0.1 SOL
    const amount = BigInt(request.amount || request.denomination || '100000000');

    // Calculate relayer fee
    let relayerFee = BigInt(Math.floor(Number(amount) * RELAYER_FEE_PERCENT));
    if (relayerFee < BigInt(MIN_FEE_LAMPORTS)) {
      relayerFee = BigInt(MIN_FEE_LAMPORTS);
    }

    console.log(`\n[Groth16 Relay] Processing verified withdrawal:`);
    console.log(`  Recipient: ${request.recipient}`);
    console.log(`  Amount: ${Number(amount) / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Fee: ${Number(relayerFee) / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Verification: ON-CHAIN (trustless)`);

    // Check if nullifier already used
    const [nullifierPDA] = getNullifierPDA(denomination, new Uint8Array(request.nullifierHash));
    const nullifierAccount = await connection.getAccountInfo(nullifierPDA);
    if (nullifierAccount) {
      return res.status(400).json({ error: 'Nullifier already used (double-spend attempt)' });
    }

    // Check if verification key is initialized
    const [vkPDA] = getVKPDA();
    const vkAccount = await connection.getAccountInfo(vkPDA);
    if (!vkAccount) {
      return res.status(500).json({ error: 'Verification key not initialized on-chain' });
    }

    // Build transaction with compute budget for Groth16 verification
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000, // Groth16 verification needs ~200k CUs, add buffer
    });

    const instruction = buildGroth16WithdrawInstruction(
      relayerKeypair.publicKey,
      request,
      relayerFee
    );

    const transaction = new Transaction()
      .add(computeBudgetIx)
      .add(instruction);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = relayerKeypair.publicKey;

    // Sign and send
    console.log(`  Submitting transaction with on-chain Groth16 verification...`);
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [relayerKeypair],
      { commitment: 'confirmed' }
    );

    console.log(`  ✅ Success: ${signature}`);

    const result: RelayResult = {
      success: true,
      signature,
      fee: Number(relayerFee) / LAMPORTS_PER_SOL,
    };

    res.json(result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Groth16 Relay] Error: ${errorMsg}`);

    // Extract more detailed error if available
    let detailedError = errorMsg;
    if (err && typeof err === 'object' && 'logs' in err) {
      const logs = (err as any).logs;
      if (Array.isArray(logs)) {
        detailedError = logs.slice(-5).join('\n');
      }
    }

    const result: RelayResult = {
      success: false,
      error: detailedError,
    };

    res.status(500).json(result);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🔒 Veil Relayer v2.0 running on http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health        - Health check`);
  console.log(`  GET  /info          - Relayer info and balance`);
  console.log(`  POST /relay         - Submit withdrawal (oracle-attested)`);
  console.log(`  POST /relay-groth16 - Submit withdrawal (on-chain Groth16 - TRUSTLESS)`);
  console.log(`\n✨ Groth16 on-chain verification enabled!`);
});
