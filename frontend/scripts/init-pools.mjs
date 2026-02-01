/**
 * Initialize Privacy Pools on Devnet
 *
 * Run with: node scripts/init-pools.mjs
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';

// Load program bindings (we'll inline the necessary parts)
const PROGRAM_ID_STR = '6mKNcFyg2qKuobBkket5tVHKE9178N2CkRonkzkprDrp';

// Denominations
const DENOMINATIONS = {
  SMALL: BigInt(100_000_000),     // 0.1 SOL
  MEDIUM: BigInt(1_000_000_000),  // 1 SOL
  LARGE: BigInt(10_000_000_000),  // 10 SOL
  XLARGE: BigInt(100_000_000_000) // 100 SOL
};

// RPC URL
const RPC_URL = 'https://devnet.helius-rpc.com?api-key=e7e2d907-2029-49d3-95c5-7658a3aeb8b6';

async function main() {
  console.log('='.repeat(60));
  console.log('Initialize Privacy Pools on Devnet');
  console.log('='.repeat(60));

  // Load keypair
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  console.log(`\nLoading keypair from ${keypairPath}...`);

  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log(`Authority: ${payer.publicKey.toBase58()}`);

  // Connect
  const connection = new Connection(RPC_URL, 'confirmed');
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    console.log('\n⚠️  Low balance! Request airdrop...');
    try {
      const sig = await connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      console.log('Airdrop received');
    } catch (err) {
      console.log('Airdrop failed (rate limited). Continue anyway...');
    }
  }

  // Import program module dynamically
  console.log('\nChecking pool status...');

  // For each denomination, check if initialized
  for (const [name, denomination] of Object.entries(DENOMINATIONS)) {
    const solAmount = Number(denomination) / LAMPORTS_PER_SOL;
    console.log(`\n[${name}] ${solAmount} SOL pool:`);

    // Derive pool PDA
    const { PublicKey } = await import('@solana/web3.js');
    const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);

    const POOL_SEED = Buffer.from('privacy_pool');
    const denomBytes = Buffer.alloc(8);
    denomBytes.writeBigUInt64LE(denomination);

    const [poolPDA] = PublicKey.findProgramAddressSync(
      [POOL_SEED, denomBytes],
      PROGRAM_ID
    );

    console.log(`  Pool PDA: ${poolPDA.toBase58()}`);

    const accountInfo = await connection.getAccountInfo(poolPDA);

    if (accountInfo && accountInfo.owner.equals(PROGRAM_ID)) {
      console.log(`  ✅ Already initialized`);

      // Parse some basic info
      const data = accountInfo.data;
      if (data.length > 88) {
        const depositCount = data.readBigUInt64LE(88 + 640); // After subtrees
        console.log(`  Deposits: ${depositCount}`);
      }
    } else {
      console.log(`  ❌ Not initialized`);
      console.log(`  To initialize, run the initializePool instruction`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Pool Status Check Complete');
  console.log('='.repeat(60));

  console.log('\nTo initialize a pool, use the frontend admin panel or call:');
  console.log('  veil.initializePool(connection, authority, denomination, signTransaction)');
}

main().catch(console.error);
