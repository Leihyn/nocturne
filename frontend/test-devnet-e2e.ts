#!/usr/bin/env npx tsx
/**
 * Quick E2E test on devnet
 */

// Mock localStorage for Node.js
const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (index: number) => [...storage.keys()][index] ?? null,
};

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { Shadowwire } from './src/lib/shadowwire';

const keypairPath = path.join(process.env.HOME!, '.config/solana/id.json');
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const payer = Keypair.fromSecretKey(secretKey);

const DEVNET_URL = 'https://api.devnet.solana.com';

async function main() {
  console.log('='.repeat(50));
  console.log('StealthSol E2E Test - DEVNET');
  console.log('='.repeat(50));

  const connection = new Connection(DEVNET_URL, 'confirmed');

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 1.1 * LAMPORTS_PER_SOL) {
    console.log('Need at least 1.1 SOL for test');
    process.exit(1);
  }

  const sw = new Shadowwire(connection);
  const identity = await sw.generateIdentity(payer.publicKey);
  console.log(`Identity: ${identity.metaAddress.encoded.substring(0, 40)}...`);

  const signTransaction = async (tx: any) => {
    tx.partialSign(payer);
    return tx;
  };

  // Shield
  console.log('\n[1] Shielding 1 SOL...');
  const result = await sw.sendPrivate(payer.publicKey, 1 as any, signTransaction, identity.metaAddress.encoded);
  console.log(`✓ Shield TX: ${result.signature.substring(0, 20)}...`);
  console.log(`✓ Note: ${result.noteCode.substring(0, 40)}...`);

  // Wait
  console.log('\n[2] Waiting for confirmation...');
  await new Promise(r => setTimeout(r, 5000));

  // Receive
  console.log('\n[3] Receiving with ZK proof...');
  const receiveResult = await sw.receivePrivate(payer.publicKey, result.noteCode, signTransaction);

  if (receiveResult.success) {
    console.log(`✓ Receive TX: ${receiveResult.signature.substring(0, 20)}...`);
    console.log('\n' + '='.repeat(50));
    console.log('✅ E2E TEST PASSED ON DEVNET');
    console.log('='.repeat(50));
  } else {
    console.log(`✗ Error: ${receiveResult.error}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
