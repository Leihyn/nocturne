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

async function main() {
  console.log('Fresh 1 SOL test with skip preflight...\n');

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  // Override to skip preflight
  const originalSendRaw = connection.sendRawTransaction.bind(connection);
  connection.sendRawTransaction = async (rawTx: any, opts: any) => {
    return originalSendRaw(rawTx, { ...opts, skipPreflight: true });
  };

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  const sw = new Shadowwire(connection);
  const identity = await sw.generateIdentity(payer.publicKey);

  const signTransaction = async (tx: any) => {
    tx.partialSign(payer);
    return tx;
  };

  console.log('[1] Shielding 1 SOL...');
  const result = await sw.sendPrivate(payer.publicKey, 1 as any, signTransaction, identity.metaAddress.encoded);
  console.log(`✓ Shield: ${result.signature.substring(0, 20)}...`);

  console.log('\n[2] Waiting 5s...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n[3] Receiving...');
  const receiveResult = await sw.receivePrivate(payer.publicKey, result.noteCode, signTransaction);

  if (receiveResult.success) {
    console.log(`\n✅ SUCCESS: ${receiveResult.signature}`);
  } else {
    console.log(`\n✗ FAILED: ${receiveResult.error}`);
  }
}

main().catch(e => console.error(e.message));
