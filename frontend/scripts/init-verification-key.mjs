/**
 * Initialize Verification Key On-Chain
 *
 * Stores the Groth16 verification key on Solana so the program
 * can verify proofs trustlessly without an oracle.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';

// ============================================
// Configuration
// ============================================

const HELIUS_API_KEY = 'e7e2d907-2029-49d3-95c5-7658a3aeb8b6';
const RPC_URL = `https://devnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`;
const PROGRAM_ID = new PublicKey('6mKNcFyg2qKuobBkket5tVHKE9178N2CkRonkzkprDrp');

// PDA seed for verification key
const VK_SEED = Buffer.from('vk');

// ============================================
// Helpers
// ============================================

function getVerificationKeyPDA() {
  return PublicKey.findProgramAddressSync(
    [VK_SEED],
    PROGRAM_ID
  );
}

/**
 * Build initialize_verification_key instruction
 *
 * Anchor discriminator: sha256("global:initialize_verification_key")[0..8]
 * = 0x51ba79b66c1f8c65
 */
function buildInitVKInstruction(authority, vkPDA, vkData) {
  // Anchor discriminator for initialize_verification_key
  const discriminator = Buffer.from([0x51, 0xba, 0x79, 0xb6, 0x6c, 0x1f, 0x8c, 0x65]);

  // Borsh-serialize the vk_data Vec<u8>
  // Format: length (u32 LE) + bytes
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(vkData.length, 0);

  const instructionData = Buffer.concat([
    discriminator,
    lengthBuffer,
    vkData,
  ]);

  const keys = [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: vkPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: instructionData,
  });
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('Initialize Verification Key On-Chain');
  console.log('='.repeat(60));

  // Load keypair
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  console.log(`\n[1] Loading keypair from ${keypairPath}...`);
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log(`    Authority: ${authority.publicKey.toBase58()}`);

  // Connect
  const connection = new Connection(RPC_URL, 'confirmed');
  const balance = await connection.getBalance(authority.publicKey);
  console.log(`    Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Get VK PDA
  const [vkPDA, bump] = getVerificationKeyPDA();
  console.log(`\n[2] Verification Key PDA: ${vkPDA.toBase58()}`);
  console.log(`    Bump: ${bump}`);

  // Check if already initialized
  const vkAccount = await connection.getAccountInfo(vkPDA);
  if (vkAccount) {
    console.log(`\n    ⚠️  Verification key already initialized!`);
    console.log(`    Account size: ${vkAccount.data.length} bytes`);
    console.log(`    Owner: ${vkAccount.owner.toBase58()}`);

    // Parse to check if it's valid
    // Skip 8 byte discriminator, then 32 byte authority
    const storedAuthority = new PublicKey(vkAccount.data.slice(8, 40));
    console.log(`    Stored Authority: ${storedAuthority.toBase58()}`);

    // Read vk_data length
    const vkDataLength = vkAccount.data.readUInt32LE(40);
    console.log(`    VK Data Length: ${vkDataLength} bytes`);

    console.log(`\n    Use update_verification_key to modify.`);
    return;
  }

  // Load verification key bytes
  const vkBytesPath = '../circuits/build/withdraw/verification_key_bytes.json';
  console.log(`\n[3] Loading verification key from ${vkBytesPath}...`);

  const vkBytes = JSON.parse(fs.readFileSync(vkBytesPath, 'utf-8'));
  const vkData = Buffer.from(vkBytes);
  console.log(`    VK size: ${vkData.length} bytes`);

  // Build transaction
  console.log(`\n[4] Building transaction...`);

  const instruction = buildInitVKInstruction(
    authority.publicKey,
    vkPDA,
    vkData
  );

  const tx = new Transaction().add(instruction);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = authority.publicKey;

  tx.sign(authority);

  // Send transaction
  console.log(`\n[5] Sending transaction...`);

  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    console.log(`    Tx: ${sig}`);

    await connection.confirmTransaction({
      signature: sig,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');

    console.log(`    ✅ Verification key initialized!`);
    console.log(`    Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

    // Verify
    const newVkAccount = await connection.getAccountInfo(vkPDA);
    if (newVkAccount) {
      console.log(`\n[6] Verification:`);
      console.log(`    Account size: ${newVkAccount.data.length} bytes`);
      console.log(`    Owner: ${newVkAccount.owner.toBase58()}`);
    }

  } catch (err) {
    console.log(`    ❌ Failed: ${err.message}`);
    if (err.logs) {
      console.log(`\n    Logs:`);
      err.logs.forEach(log => console.log(`      ${log}`));
    }
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
