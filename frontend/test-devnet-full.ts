#!/usr/bin/env npx tsx
const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (index: number) => [...storage.keys()][index] ?? null,
};

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { Shadowwire } from './src/lib/shadowwire';

const keypairPath = path.join(process.env.HOME!, '.config/solana/id.json');
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const payer = Keypair.fromSecretKey(secretKey);

const DEVNET_URL = 'https://api.devnet.solana.com';

async function main() {
  console.log('='.repeat(50));
  console.log('StealthSol E2E Test - DEVNET (0.1 SOL)');
  console.log('='.repeat(50));

  const connection = new Connection(DEVNET_URL, 'confirmed');
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  const sw = new Shadowwire(connection);
  const identity = await sw.generateIdentity(payer.publicKey);
  console.log(`Identity created\n`);

  const signTransaction = async (tx: any) => {
    tx.partialSign(payer);
    return tx;
  };

  console.log('[1] Shielding 0.1 SOL...');
  try {
    const result = await sw.sendPrivate(payer.publicKey, 0.1 as any, signTransaction, identity.metaAddress.encoded);
    console.log(`✓ Shield TX: ${result.signature}`);
    console.log(`✓ Note: ${result.noteCode.substring(0, 50)}...`);

    console.log('\n[2] Waiting 5s...');
    await new Promise(r => setTimeout(r, 5000));

    console.log('\n[3] Receiving with ZK proof...');
    const receiveResult = await sw.receivePrivate(payer.publicKey, result.noteCode, signTransaction);

    if (receiveResult.success) {
      console.log(`✓ Receive TX: ${receiveResult.signature}`);
      console.log('\n' + '='.repeat(50));
      console.log('✅ E2E TEST PASSED');
      console.log('='.repeat(50));
    } else {
      console.log(`✗ Receive failed: ${receiveResult.error}`);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    if (err.logs) err.logs.forEach((l: string) => console.log(l));
  }
}

main();
