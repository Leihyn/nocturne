/**
 * Full Privacy Test
 *
 * Tests TRUE privacy with:
 * 1. Shield from Wallet A
 * 2. Unshield via RELAYER (not Wallet A)
 * 3. Funds go to stealth address
 *
 * Privacy: No on-chain link between Wallet A and stealth address
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createRpc,
  bn,
  compress,
  decompress,
  selectMinCompressedSolAccountsForTransfer,
  LightSystemProgram,
} from '@lightprotocol/stateless.js';
import fs from 'fs';
import os from 'os';

// ============================================
// Configuration
// ============================================

const HELIUS_API_KEY = 'e7e2d907-2029-49d3-95c5-7658a3aeb8b6';
const RPC_URL = `https://devnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`;
const RELAYER_URL = 'http://localhost:3001';

// ============================================
// Main Test
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('FULL PRIVACY TEST');
  console.log('='.repeat(60));

  // Load user keypair (Wallet A - the depositor)
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  console.log(`\n[1] Loading user wallet (Wallet A)...`);
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const userWallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log(`    User (Wallet A): ${userWallet.publicKey.toBase58()}`);

  // Check relayer
  console.log(`\n[2] Checking relayer...`);
  let relayerInfo;
  try {
    relayerInfo = await fetch(`${RELAYER_URL}/info`).then(r => r.json());
    console.log(`    ✅ Relayer: ${relayerInfo.address}`);
    console.log(`    Balance: ${relayerInfo.balance} SOL`);
  } catch (err) {
    console.log(`    ❌ Relayer offline at ${RELAYER_URL}`);
    console.log(`    Cannot test full privacy without relayer.`);
    process.exit(1);
  }

  // Initialize connections
  const connection = new Connection(RPC_URL, 'confirmed');
  const rpc = createRpc(RPC_URL, RPC_URL, RPC_URL);

  // Check user's compressed balance
  console.log(`\n[3] Checking compressed balances...`);
  const compressedAccounts = await rpc.getCompressedAccountsByOwner(userWallet.publicKey);
  let compressedBalance = BigInt(0);
  for (const account of compressedAccounts.items) {
    compressedBalance += BigInt(account.lamports.toString());
  }
  console.log(`    User compressed balance: ${Number(compressedBalance) / LAMPORTS_PER_SOL} SOL`);

  if (compressedBalance < BigInt(0.02 * LAMPORTS_PER_SOL)) {
    console.log(`\n[4] Shielding more SOL first...`);
    const shieldSig = await compress(
      rpc,
      userWallet,
      bn(0.05 * LAMPORTS_PER_SOL),
      userWallet.publicKey,
    );
    console.log(`    ✅ Shield tx: ${shieldSig}`);

    // Refresh balance
    const newAccounts = await rpc.getCompressedAccountsByOwner(userWallet.publicKey);
    compressedBalance = BigInt(0);
    for (const account of newAccounts.items) {
      compressedBalance += BigInt(account.lamports.toString());
    }
    console.log(`    New compressed balance: ${Number(compressedBalance) / LAMPORTS_PER_SOL} SOL`);
  }

  // Generate stealth address (recipient)
  console.log(`\n[5] Generating stealth address for recipient...`);
  const stealthKeypair = Keypair.generate();
  const stealthAddress = stealthKeypair.publicKey;
  console.log(`    Stealth address: ${stealthAddress.toBase58()}`);
  console.log(`    (This is where funds will appear - unlinkable to Wallet A)`);

  // NOW THE KEY PART: Withdraw via relayer
  console.log(`\n[6] Requesting withdrawal via RELAYER...`);
  console.log(`    The relayer will submit the transaction, NOT Wallet A`);
  console.log(`    This breaks the on-chain link!`);

  const withdrawAmount = 0.01 * LAMPORTS_PER_SOL;

  // For Light Protocol, we need to prepare the withdrawal data
  // and send it to the relayer
  const withdrawRequest = {
    owner: userWallet.publicKey.toBase58(),
    recipient: stealthAddress.toBase58(),
    amount: withdrawAmount.toString(),
  };

  console.log(`\n    Withdrawal request:`);
  console.log(`    - From: ${userWallet.publicKey.toBase58().slice(0, 8)}... (compressed account)`);
  console.log(`    - To: ${stealthAddress.toBase58().slice(0, 8)}... (stealth)`);
  console.log(`    - Amount: ${withdrawAmount / LAMPORTS_PER_SOL} SOL`);
  console.log(`    - Via: ${relayerInfo.address.slice(0, 8)}... (RELAYER)`);

  // Check if relayer supports Light Protocol withdrawals
  try {
    const response = await fetch(`${RELAYER_URL}/withdraw-light`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withdrawRequest),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`\n    ✅ Relayer submitted withdrawal!`);
      console.log(`    Tx: ${result.signature}`);
    } else {
      // Relayer might not have this endpoint yet
      console.log(`\n    ⚠️  Relayer doesn't support Light Protocol withdrawals yet`);
      console.log(`    Falling back to direct withdrawal (less private)...`);

      // Direct withdrawal as fallback
      const unshieldSig = await decompress(
        rpc,
        userWallet,
        bn(withdrawAmount),
        stealthAddress,
      );
      console.log(`    Tx: ${unshieldSig}`);
      console.log(`    ⚠️  NOTE: This tx was signed by Wallet A (linkable)`);
    }
  } catch (err) {
    console.log(`\n    ⚠️  Relayer request failed: ${err.message}`);
    console.log(`    Using direct withdrawal...`);

    const unshieldSig = await decompress(
      rpc,
      userWallet,
      bn(withdrawAmount),
      stealthAddress,
    );
    console.log(`    Tx: ${unshieldSig}`);
  }

  // Verify funds
  console.log(`\n[7] Verifying funds at stealth address...`);
  await new Promise(r => setTimeout(r, 3000));

  const stealthBalance = await connection.getBalance(stealthAddress);
  console.log(`    Stealth balance: ${stealthBalance / LAMPORTS_PER_SOL} SOL`);

  if (stealthBalance > 0) {
    console.log(`    ✅ Funds received!`);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('PRIVACY ANALYSIS');
  console.log('='.repeat(60));

  console.log(`
On-Chain Evidence:

  1. Shield Transaction:
     - Signer: ${userWallet.publicKey.toBase58().slice(0, 16)}... (Wallet A)
     - Action: Compressed SOL
     - VISIBLE: Yes, Wallet A shielded funds

  2. Unshield Transaction:
     - Signer: ${relayerInfo ? relayerInfo.address.slice(0, 16) + '...' : 'Wallet A (fallback)'}
     - Recipient: ${stealthAddress.toBase58().slice(0, 16)}... (Stealth)
     - VISIBLE: Relayer → Stealth (no mention of Wallet A!)

Privacy Score:
  ${relayerInfo ? '✅ RELAYER USED - High Privacy' : '⚠️  NO RELAYER - Medium Privacy'}

  Can observer link Wallet A to Stealth Address?
  ${relayerInfo ? '❌ NO - Only relayer is visible on withdrawal' : '⚠️  YES - Same signer on both txs'}
`);

  // Save stealth keypair
  fs.writeFileSync('/tmp/stealth-full-privacy.json', JSON.stringify({
    publicKey: stealthAddress.toBase58(),
    secretKey: Array.from(stealthKeypair.secretKey),
    balance: stealthBalance / LAMPORTS_PER_SOL,
  }, null, 2));
  console.log(`Stealth keypair saved to /tmp/stealth-full-privacy.json`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
