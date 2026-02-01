#!/usr/bin/env npx ts-node
/**
 * Initialize Verification Keys on Solana
 *
 * After running the trusted setup and deploying the program,
 * this script uploads the Groth16 verification keys to on-chain PDAs.
 *
 * Usage:
 *   npx ts-node scripts/init-vk.ts [network]
 *   npx ts-node scripts/init-vk.ts devnet
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
} from '@solana/web3.js';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Configuration
// ============================================

// Deployed program ID on devnet
const PROGRAM_ID = new PublicKey('3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT');

const NETWORKS: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
  localnet: 'http://localhost:8899',
};

// G1 point size: 64 bytes (32 + 32)
const G1_SIZE = 64;
// G2 point size: 128 bytes (32 * 4)
const G2_SIZE = 128;

// PDA seed - matches the Rust code
const VK_SEED = 'vk';

// ============================================
// Types
// ============================================

interface SolanaVK {
  alpha: number[];
  beta: number[];
  gamma: number[];
  delta: number[];
  ic: number[][];
}

// ============================================
// Borsh Serialization
// ============================================

class VerificationKeyData {
  alpha: Uint8Array;
  beta: Uint8Array;
  gamma: Uint8Array;
  delta: Uint8Array;
  ic: Uint8Array[];

  constructor(vk: SolanaVK) {
    this.alpha = new Uint8Array(vk.alpha);
    this.beta = new Uint8Array(vk.beta);
    this.gamma = new Uint8Array(vk.gamma);
    this.delta = new Uint8Array(vk.delta);
    this.ic = vk.ic.map(point => new Uint8Array(point));
  }

  serialize(): Buffer {
    // Manual borsh serialization matching Rust struct
    const icLen = this.ic.length;
    const totalSize = G1_SIZE + G2_SIZE + G2_SIZE + G2_SIZE + 4 + (G1_SIZE * icLen);
    const buffer = Buffer.alloc(totalSize);
    let offset = 0;

    // alpha (G1)
    Buffer.from(this.alpha).copy(buffer, offset);
    offset += G1_SIZE;

    // beta (G2)
    Buffer.from(this.beta).copy(buffer, offset);
    offset += G2_SIZE;

    // gamma (G2)
    Buffer.from(this.gamma).copy(buffer, offset);
    offset += G2_SIZE;

    // delta (G2)
    Buffer.from(this.delta).copy(buffer, offset);
    offset += G2_SIZE;

    // ic length (u32 LE)
    buffer.writeUInt32LE(icLen, offset);
    offset += 4;

    // ic points
    for (const icPoint of this.ic) {
      Buffer.from(icPoint).copy(buffer, offset);
      offset += G1_SIZE;
    }

    return buffer;
  }
}

// ============================================
// Load Verification Key
// ============================================

function loadVerificationKey(circuitName: string): SolanaVK {
  const vkPath = path.join(
    __dirname,
    '..',
    'programs',
    'stealth',
    'data',
    `${circuitName}_vk.json`
  );

  if (!fs.existsSync(vkPath)) {
    throw new Error(
      `Verification key not found: ${vkPath}\nRun the trusted setup first.`
    );
  }

  const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));
  console.log(`Loaded ${circuitName} verification key`);
  console.log(`  Alpha: ${vk.alpha.length} bytes`);
  console.log(`  Beta: ${vk.beta.length} bytes`);
  console.log(`  Gamma: ${vk.gamma.length} bytes`);
  console.log(`  Delta: ${vk.delta.length} bytes`);
  console.log(`  IC points: ${vk.ic.length}`);

  return vk;
}

// ============================================
// Compute Anchor Discriminator
// ============================================

async function computeDiscriminator(name: string): Promise<Buffer> {
  // Anchor uses SHA256(namespace:name)[0..8]
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(`global:${name}`);
  return hash.digest().slice(0, 8);
}

// ============================================
// Build Instruction
// ============================================

async function buildInitVkInstruction(
  programId: PublicKey,
  payer: PublicKey,
  vk: SolanaVK
): Promise<TransactionInstruction> {
  // Derive PDA for verification key storage
  // Seed is just "vk" without circuit_id
  const [vkPda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(VK_SEED)],
    programId
  );

  console.log(`VK PDA: ${vkPda.toBase58()}`);
  console.log(`VK PDA bump: ${bump}`);

  // Serialize verification key
  const vkData = new VerificationKeyData(vk);
  const vkBytes = vkData.serialize();
  console.log(`VK data size: ${vkBytes.length} bytes`);

  // Build instruction data
  // Discriminator (8 bytes) + vk_data (Vec<u8>: 4 bytes length + data)
  const discriminator = await computeDiscriminator('initialize_verification_key');

  const dataSize = 8 + 4 + vkBytes.length;
  const data = Buffer.alloc(dataSize);
  let offset = 0;

  // Discriminator
  discriminator.copy(data, offset);
  offset += 8;

  // Vec length (u32 LE)
  data.writeUInt32LE(vkBytes.length, offset);
  offset += 4;

  // VK data
  vkBytes.copy(data, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },        // authority
      { pubkey: vkPda, isSigner: false, isWritable: true },       // verification_key
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    programId,
    data,
  });
}

// ============================================
// Main
// ============================================

async function main() {
  const network = process.argv[2] || 'devnet';
  const rpcUrl = NETWORKS[network] || network;

  console.log('');
  console.log('='.repeat(60));
  console.log('  StealthSol Verification Key Initialization');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Network: ${network}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log('');

  // Load keypair
  const keypairPath = process.env.KEYPAIR_PATH ||
    path.join(process.env.HOME || '', '.config', 'solana', 'id.json');

  if (!fs.existsSync(keypairPath)) {
    console.error(`Keypair not found: ${keypairPath}`);
    console.error('Set KEYPAIR_PATH or run: solana-keygen new');
    process.exit(1);
  }

  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  // Connect to network
  const connection = new Connection(rpcUrl, 'confirmed');
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / 1e9} SOL`);

  if (balance < 0.1 * 1e9) {
    console.error('Insufficient balance. Need at least 0.1 SOL');
    process.exit(1);
  }

  console.log('');

  // Load and use the withdraw verification key (primary circuit)
  console.log('Initializing verification key...');

  try {
    const vk = loadVerificationKey('withdraw');
    console.log('');

    const instruction = await buildInitVkInstruction(
      PROGRAM_ID,
      payer.publicKey,
      vk
    );

    const transaction = new Transaction().add(instruction);

    console.log('Sending transaction...');
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [payer],
      { commitment: 'confirmed' }
    );

    console.log(`Transaction: ${signature}`);
    console.log('Verification key initialized successfully!');
    console.log('');
  } catch (err: any) {
    if (err.message?.includes('already in use') || err.logs?.some((l: string) => l.includes('already in use'))) {
      console.log('Verification key already initialized');
      console.log('');
    } else {
      console.error('Failed to initialize VK:', err.message);
      if (err.logs) {
        console.error('Logs:', err.logs);
      }
      throw err;
    }
  }

  console.log('='.repeat(60));
  console.log('  Verification key initialization complete!');
  console.log('='.repeat(60));
  console.log('');
  console.log('Next steps:');
  console.log('  1. Start threshold verifiers: make docker-up');
  console.log('  2. Run frontend: cd frontend && npm run dev');
  console.log('  3. Test with real transactions!');
  console.log('');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
