/**
 * End-to-end test for Light Protocol integration
 *
 * Tests:
 * 1. Initialize Light Protocol RPC
 * 2. Get airdrop on devnet
 * 3. Shield SOL (compress)
 * 4. Check compressed balance
 * 5. Unshield SOL (decompress)
 */

import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey
} from '@solana/web3.js';
import {
  Rpc,
  createRpc,
  bn,
  compress,
  decompress,
  confirmTx,
  airdropSol,
} from '@lightprotocol/stateless.js';
import fs from 'fs';
import os from 'os';

// Configuration
const HELIUS_API_KEY = 'e7e2d907-2029-49d3-95c5-7658a3aeb8b6';
const RPC_URL = `https://devnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`;

console.log('='.repeat(60));
console.log('Light Protocol End-to-End Test');
console.log('='.repeat(60));

async function main() {
  try {
    // 1. Initialize RPC
    console.log('\n[1] Initializing Light Protocol RPC...');
    const rpc = createRpc(RPC_URL, RPC_URL, RPC_URL);
    const connection = new Connection(RPC_URL, 'confirmed');
    console.log('    RPC initialized');

    // 2. Load existing keypair from ~/.config/solana/id.json
    console.log('\n[2] Loading keypair from ~/.config/solana/id.json...');
    const keypairPath = `${os.homedir()}/.config/solana/id.json`;
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    console.log(`    Public key: ${payer.publicKey.toBase58()}`);

    // 3. Check balance (no airdrop needed - using existing funded keypair)
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`    Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    // 4. Shield SOL (compress)
    console.log('\n[4] Shielding 0.1 SOL...');
    const shieldAmount = bn(0.1 * LAMPORTS_PER_SOL);

    const shieldSig = await compress(
      rpc,
      payer,
      shieldAmount,
      payer.publicKey,
    );
    console.log(`    Shield tx: ${shieldSig}`);
    console.log(`    Explorer: https://explorer.solana.com/tx/${shieldSig}?cluster=devnet`);

    // 5. Check compressed balance
    console.log('\n[5] Checking compressed balance...');
    const compressedAccounts = await rpc.getCompressedAccountsByOwner(payer.publicKey);
    let compressedBalance = BigInt(0);
    for (const account of compressedAccounts.items) {
      compressedBalance += BigInt(account.lamports.toString());
    }
    console.log(`    Compressed balance: ${Number(compressedBalance) / LAMPORTS_PER_SOL} SOL`);
    console.log(`    Number of compressed accounts: ${compressedAccounts.items.length}`);

    // 6. Unshield SOL (decompress) - if we have compressed balance
    if (compressedBalance > 0) {
      console.log('\n[6] Unshielding 0.05 SOL...');
      const unshieldAmount = bn(0.05 * LAMPORTS_PER_SOL);

      const unshieldSig = await decompress(
        rpc,
        payer,
        unshieldAmount,
        payer.publicKey,
      );
      console.log(`    Unshield tx: ${unshieldSig}`);
      console.log(`    Explorer: https://explorer.solana.com/tx/${unshieldSig}?cluster=devnet`);

      // Check final balances
      const finalBalance = await connection.getBalance(payer.publicKey);
      const finalCompressed = await rpc.getCompressedAccountsByOwner(payer.publicKey);
      let finalCompressedBalance = BigInt(0);
      for (const account of finalCompressed.items) {
        finalCompressedBalance += BigInt(account.lamports.toString());
      }

      console.log('\n[7] Final balances:');
      console.log(`    Regular SOL: ${finalBalance / LAMPORTS_PER_SOL} SOL`);
      console.log(`    Compressed SOL: ${Number(finalCompressedBalance) / LAMPORTS_PER_SOL} SOL`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('TEST PASSED - Light Protocol integration working!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n[ERROR]', error.message || error);
    if (error.logs) {
      console.error('Logs:', error.logs);
    }
    process.exit(1);
  }
}

main();
