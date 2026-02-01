#!/usr/bin/env npx tsx
/**
 * Set TEE public key for encryption
 * In production, this would come from Intel TDX attestation
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import * as nacl from 'tweetnacl';

const TEE_RELAYER_PROGRAM_ID = new PublicKey('8BzTaoLzgaeY6TuV8LcQyNHt8RKukPSf9ijUtUbPD6X1');
const RELAYER_STATE_SEED = Buffer.from('relayer_state');

// Load authority keypair
const keypairPath = path.join(process.env.HOME!, '.config/solana/id.json');
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const authority = Keypair.fromSecretKey(secretKey);

async function main() {
  console.log('Setting TEE public key...\n');

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  // Derive relayer state PDA
  const [relayerStatePda] = PublicKey.findProgramAddressSync(
    [RELAYER_STATE_SEED],
    TEE_RELAYER_PROGRAM_ID
  );

  // Generate TEE keypair (in production, from TDX attestation)
  // For demo, we'll use a deterministic key derived from authority
  const teeKeypair = nacl.box.keyPair();

  // Save TEE private key for the verifier service to use
  const teeKeyPath = path.join(__dirname, '.tee-keypair.json');
  fs.writeFileSync(teeKeyPath, JSON.stringify({
    publicKey: Array.from(teeKeypair.publicKey),
    secretKey: Array.from(teeKeypair.secretKey),
  }));

  console.log('TEE Public Key:', Buffer.from(teeKeypair.publicKey).toString('hex'));
  console.log('TEE keypair saved to:', teeKeyPath);

  // Build set_tee_pubkey instruction
  // Discriminator for "set_tee_pubkey"
  const discriminator = Buffer.from([0x5d, 0x6a, 0x8e, 0x1c, 0x3b, 0x2f, 0x4a, 0x7d]); // placeholder

  const data = Buffer.concat([
    discriminator,
    Buffer.from(teeKeypair.publicKey),
  ]);

  const setTeeKeyIx = new TransactionInstruction({
    programId: TEE_RELAYER_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: relayerStatePda, isSigner: false, isWritable: true },
    ],
    data,
  });

  const tx = new Transaction().add(setTeeKeyIx);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(authority);

  console.log('\nSending set_tee_pubkey transaction...');

  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log('TX:', sig);

    await connection.confirmTransaction(sig, 'confirmed');
    console.log('\n✅ TEE public key set!');
  } catch (err: any) {
    console.error('Error:', err.message);
    // For now, just save the keys - we can set it later
    console.log('\n⚠️ Could not set on-chain, but TEE keypair is saved locally.');
    console.log('The verifier can use this for encryption/decryption.');
  }
}

main();
