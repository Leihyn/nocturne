#!/usr/bin/env npx tsx
// Mock localStorage
const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (index: number) => [...storage.keys()][index] ?? null,
};

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

const keypairPath = path.join(process.env.HOME!, '.config/solana/id.json');
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const payer = Keypair.fromSecretKey(secretKey);

const PROGRAM_ID = new PublicKey('3D37zdZf1nQ9RtPsobc7kX6hR8SvieBbqQWBTZwhMzBT');
const DEVNET_URL = 'https://api.devnet.solana.com';

// 0.1 SOL denomination
const DENOMINATION = BigInt(100_000_000);
const POOL_SEED = Buffer.from('privacy_pool');
const CONFIG_SEED = Buffer.from('pool_config');
const INIT_POOL_DISCRIMINATOR = Buffer.from([0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28]);

function denominationToBytes(d: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(d);
  return buf;
}

async function main() {
  console.log('Testing 0.1 SOL pool on devnet...\n');
  
  const connection = new Connection(DEVNET_URL, 'confirmed');
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Get PDAs
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [POOL_SEED, denominationToBytes(DENOMINATION)],
    PROGRAM_ID
  );
  const [configPDA] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED, denominationToBytes(DENOMINATION)],
    PROGRAM_ID
  );

  console.log(`Pool PDA: ${poolPDA.toBase58()}`);

  // Check if pool exists
  const poolInfo = await connection.getAccountInfo(poolPDA);
  if (poolInfo) {
    console.log(`Pool exists with ${poolInfo.data.length} bytes`);
  } else {
    console.log('Pool does not exist, initializing...');
    
    const data = Buffer.alloc(16);
    INIT_POOL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(DENOMINATION, 8);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log(`Pool initialized: ${sig}`);
  }

  // Now test with Shadowwire using 0.1 denomination
  // For now just check pool is ready
  const newPoolInfo = await connection.getAccountInfo(poolPDA);
  console.log(`\nPool ready: ${newPoolInfo?.data.length} bytes`);
  
  if (newPoolInfo && newPoolInfo.data.length > 8000) {
    console.log('✓ Pool has correct size for new program');
  } else {
    console.log('✗ Pool size mismatch');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.logs) err.logs.forEach((l: string) => console.log(l));
});
