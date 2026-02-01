/**
 * Initialize the 1 SOL privacy pool on devnet
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const PROGRAM_ID = new PublicKey('3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT');
const RPC_URL = 'https://api.devnet.solana.com';

// PDA Seeds
const POOL_SEED = Buffer.from('privacy_pool');
const CONFIG_SEED = Buffer.from('pool_config');

// 1 SOL denomination
const DENOMINATION = BigInt(1_000_000_000);

// Instruction discriminator for initialize_pool
// sha256("global:initialize_pool")[:8]
const INIT_POOL_DISCRIMINATOR = Buffer.from([0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28]);

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
    [CONFIG_SEED, denominationToBytes(denomination)],
    PROGRAM_ID
  );
}

async function main() {
  console.log('Initializing 1 SOL Privacy Pool on Devnet\n');

  // Load keypair from default Solana config or environment
  let authority: Keypair;

  const keypairPath = process.env.KEYPAIR_PATH ||
    path.join(process.env.HOME || '', '.config/solana/id.json');

  try {
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
    console.log('Authority:', authority.publicKey.toBase58());
  } catch (err) {
    console.error('Failed to load keypair from:', keypairPath);
    console.error('Set KEYPAIR_PATH env var or create a keypair with: solana-keygen new');
    process.exit(1);
  }

  const connection = new Connection(RPC_URL, 'confirmed');

  // Check authority balance
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Authority balance:', balance / 1e9, 'SOL');

  if (balance < 0.1 * 1e9) {
    console.error('Insufficient balance. Need at least 0.1 SOL for rent.');
    console.log('Get devnet SOL: solana airdrop 1 --url devnet');
    process.exit(1);
  }

  // Derive PDAs
  const [poolPDA, poolBump] = getPoolPDA(DENOMINATION);
  const [configPDA, configBump] = getConfigPDA(DENOMINATION);

  console.log('\nPDAs:');
  console.log('  Pool:', poolPDA.toBase58());
  console.log('  Config:', configPDA.toBase58());

  // Check if already initialized
  const poolInfo = await connection.getAccountInfo(poolPDA);
  if (poolInfo) {
    console.log('\nPool already initialized!');
    console.log('Data length:', poolInfo.data.length, 'bytes');
    return;
  }

  // Build instruction data: discriminator (8) + denomination (8)
  const data = Buffer.alloc(16);
  INIT_POOL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(DENOMINATION, 8);

  // Build instruction
  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });

  console.log('\nSending transaction...');

  try {
    const tx = new Transaction().add(instruction);
    const signature = await sendAndConfirmTransaction(
      connection,
      tx,
      [authority],
      { commitment: 'confirmed' }
    );

    console.log('\nPool initialized successfully!');
    console.log('Signature:', signature);
    console.log('\nView on explorer:');
    console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  } catch (err) {
    console.error('\nTransaction failed:', err);
    process.exit(1);
  }
}

main().catch(console.error);
