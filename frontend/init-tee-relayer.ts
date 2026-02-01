#!/usr/bin/env npx tsx
/**
 * Initialize the TEE Relayer on devnet
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

const TEE_RELAYER_PROGRAM_ID = new PublicKey('8BzTaoLzgaeY6TuV8LcQyNHt8RKukPSf9ijUtUbPD6X1');
const RELAYER_STATE_SEED = Buffer.from('relayer_state');

// Load keypair
const keypairPath = path.join(process.env.HOME!, '.config/solana/id.json');
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const authority = Keypair.fromSecretKey(secretKey);

async function main() {
  console.log('Initializing TEE Relayer on devnet...\n');

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  // Derive relayer state PDA
  const [relayerStatePda, bump] = PublicKey.findProgramAddressSync(
    [RELAYER_STATE_SEED],
    TEE_RELAYER_PROGRAM_ID
  );

  console.log('TEE Relayer Program:', TEE_RELAYER_PROGRAM_ID.toBase58());
  console.log('Relayer State PDA:', relayerStatePda.toBase58());
  console.log('Authority:', authority.publicKey.toBase58());

  // Check if already initialized
  const existingAccount = await connection.getAccountInfo(relayerStatePda);
  if (existingAccount) {
    console.log('\n✅ TEE Relayer already initialized!');
    console.log('Account size:', existingAccount.data.length, 'bytes');
    return;
  }

  // Build initialize instruction
  // Discriminator for "initialize" = sha256("global:initialize")[0..8]
  const discriminator = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

  // Fee in basis points (50 = 0.5%)
  const feeBps = 50;
  const feeBpsBuffer = Buffer.alloc(2);
  feeBpsBuffer.writeUInt16LE(feeBps, 0);

  const data = Buffer.concat([discriminator, feeBpsBuffer]);

  const initializeIx = new TransactionInstruction({
    programId: TEE_RELAYER_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: relayerStatePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(initializeIx);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(authority);

  console.log('\nSending initialize transaction...');

  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log('TX:', sig);

    await connection.confirmTransaction(sig, 'confirmed');
    console.log('\n✅ TEE Relayer initialized!');
    console.log('Fee: 0.5% (50 bps)');
  } catch (err: any) {
    console.error('Error:', err.message);
    if (err.logs) {
      console.log('\nLogs:');
      err.logs.forEach((log: string) => console.log(log));
    }
  }
}

main();
