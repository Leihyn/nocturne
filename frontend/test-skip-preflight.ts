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

// Patch the receivePrivate to skip preflight
import { Shadowwire } from './src/lib/shadowwire';

const keypairPath = path.join(process.env.HOME!, '.config/solana/id.json');
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const payer = Keypair.fromSecretKey(secretKey);

// Note from previous deposit
const NOTE_CODE = 'swn:eyJjIjoiMjMwYjZlMDUzNWFkZDRkNWU1NjY4ODg3MmVlZjNiMmNhNTYxMWUwN2VkYmU0MTcxMzNkNTNhMmNhMjBiMTAxNiIsIm4iOiI2MTI5MmM2MGMxOTBlZDQ4NzRhMjdhMjI5ODE4OWJmMDk1MWQwZjcyODVkMWZhOTVmNWJhNTFmMzdiMGIzNGRkIiwicyI6ImY0YmQ1Mzc4M2FjMmE1MzExMDE1NmNlNzE0N2Q1ZjNjNDNjODdiOTQ3YTY4NTMxMmE1OTAyYzE5OTQxM2M3MzEiLCJpIjowLCJkIjoxLCJyIjoiYmNlMzBjYzQ4NTM0ZjMzNmMzN2U1NzE3YzI1MTQ2OGZmOWU4MjdlYzE0Mzk1Y2QxODY5MTcxYTNiZGI2ODBjMSIsInNjIjoiYnpJdVZiaXExZVVCRUl3TndmRldmR3l6TjR3Qk1vWTV3NlB4eUtTcDZHTT0iLCJzcCI6IkZ6RlhEaEQ3Ym9TTUs1TjNqY3RPNGI0TFRqZnl0eTVXdHA1R3RIcVZWQTc2In0=';

async function main() {
  console.log('Testing with skip preflight...\n');

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  const sw = new Shadowwire(connection);
  await sw.generateIdentity(payer.publicKey);

  const signTransaction = async (tx: any) => {
    tx.partialSign(payer);
    return tx;
  };

  console.log('Receiving with ZK proof (skip preflight)...');
  
  // Manually override sendRawTransaction to skip preflight
  const originalSendRaw = connection.sendRawTransaction.bind(connection);
  connection.sendRawTransaction = async (rawTx: any, opts: any) => {
    return originalSendRaw(rawTx, { ...opts, skipPreflight: true });
  };

  const result = await sw.receivePrivate(payer.publicKey, NOTE_CODE, signTransaction);

  if (result.success) {
    console.log(`✓ SUCCESS: ${result.signature}`);
  } else {
    console.log(`✗ FAILED: ${result.error}`);
  }
}

main();
