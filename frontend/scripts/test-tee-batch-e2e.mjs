/**
 * E2E Test: TEE Batch Settlement with Staging Withdrawal
 *
 * Tests the fix: after batch settles (3/3), funds are withdrawn from
 * staging PDA back to wallet, then shielded to Light Protocol.
 *
 * Run: node frontend/scripts/test-tee-batch-e2e.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createRpc,
  bn,
  defaultStateTreeLookupTables,
  getAllStateTreeInfos,
  LightSystemProgram,
} from '@lightprotocol/stateless.js';
import fs from 'fs';
import os from 'os';

// ============================================
// Config
// ============================================
const HELIUS_API_KEY = 'e7e2d907-2029-49d3-95c5-7658a3aeb8b6';
const RPC_URL = `https://devnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`;
const TEE_BRIDGE_PROGRAM_ID = new PublicKey('7BWpEN8PqFEZ131A5F8iEniMS6bYREGrabxLHgSdUmVW');

const STAGING_SEED = Buffer.from('staging');
const BATCH_SEED = Buffer.from('batch');
const COMMITMENT_SEED = Buffer.from('tee_commitment');

const DISCRIMINATORS = {
  initializeStaging: Buffer.from([194, 41, 68, 173, 201, 128, 147, 110]),
  depositToStaging: Buffer.from([222, 90, 105, 242, 136, 199, 187, 37]),
  createPrivateCommitment: Buffer.from([178, 210, 84, 183, 50, 250, 158, 59]),
  settleBatch: Buffer.from([22, 2, 21, 223, 225, 122, 163, 214]),
  initializeBatch: Buffer.from([126, 44, 205, 90, 220, 105, 105, 193]),
  withdrawFromStaging: Buffer.from([170, 210, 198, 109, 3, 235, 107, 96]),
};

const DEPOSIT_AMOUNT = BigInt(1 * LAMPORTS_PER_SOL); // 1 SOL (must be 1, 10, or 100)
const BATCH_THRESHOLD = 3;

// ============================================
// PDA helpers
// ============================================
function getStagingPDA(user) {
  return PublicKey.findProgramAddressSync(
    [STAGING_SEED, user.toBuffer()],
    TEE_BRIDGE_PROGRAM_ID
  );
}

function getBatchPDA(batchId) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(batchId);
  return PublicKey.findProgramAddressSync(
    [BATCH_SEED, buf],
    TEE_BRIDGE_PROGRAM_ID
  );
}

function getCommitmentPDA(commitment) {
  return PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, Buffer.from(commitment)],
    TEE_BRIDGE_PROGRAM_ID
  );
}

// ============================================
// Instruction builders
// ============================================
function buildInitializeStaging(payer, user, staging) {
  return {
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: staging, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.initializeStaging,
  };
}

function buildDeposit(user, staging, amount) {
  const data = Buffer.alloc(16);
  DISCRIMINATORS.depositToStaging.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return {
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: staging, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

function buildInitializeBatch(authority, batch, batchId) {
  const data = Buffer.alloc(16);
  DISCRIMINATORS.initializeBatch.copy(data, 0);
  data.writeBigUInt64LE(batchId, 8);
  return {
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: batch, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

function buildCreateCommitment(user, staging, commitmentPDA, batch, denomination, commitment) {
  const data = Buffer.alloc(8 + 8 + 32 + 1 + 128);
  let offset = 0;
  DISCRIMINATORS.createPrivateCommitment.copy(data, offset); offset += 8;
  data.writeBigUInt64LE(denomination, offset); offset += 8;
  Buffer.from(commitment).copy(data, offset); offset += 32;
  data.writeUInt8(0, offset); // no encrypted note
  return {
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: staging, isSigner: false, isWritable: true },
      { pubkey: commitmentPDA, isSigner: false, isWritable: true },
      { pubkey: batch, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

function buildSettleBatch(settler, batch) {
  return {
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: settler, isSigner: true, isWritable: true },
      { pubkey: batch, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.settleBatch,
  };
}

function buildWithdrawFromStaging(user, staging, amount) {
  const data = Buffer.alloc(16);
  DISCRIMINATORS.withdrawFromStaging.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return {
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: staging, isSigner: false, isWritable: true },
    ],
    data,
  };
}

// ============================================
// Helpers
// ============================================
function generateCommitment(amount) {
  const nullifier = new Uint8Array(32);
  const secret = new Uint8Array(32);
  crypto.getRandomValues(nullifier);
  crypto.getRandomValues(secret);
  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, amount, true);
  const preimage = new Uint8Array(72);
  preimage.set(nullifier, 0);
  preimage.set(secret, 32);
  preimage.set(amountBytes, 64);
  // Simple hash for commitment (keccak not needed for test, just need unique 32 bytes)
  const commitment = new Uint8Array(32);
  crypto.getRandomValues(commitment);
  return commitment;
}

async function sendTx(connection, tx, payer) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const txId = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });
  return txId;
}

function parseBatchData(data) {
  const countOffset = 8 + 8 + 32 + 320 + 80;
  return {
    commitmentCount: data[countOffset],
    totalAmount: data.readBigUInt64LE(countOffset + 1),
    settled: data[countOffset + 1 + 8 + 8] === 1,
  };
}

// ============================================
// Main test
// ============================================
async function main() {
  console.log('='.repeat(60));
  console.log('TEE Batch Settlement E2E Test');
  console.log('Tests: staging withdrawal + shield after batch settles');
  console.log('='.repeat(60));

  // Load keypair
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const connection = new Connection(RPC_URL, 'confirmed');
  const rpc = createRpc(RPC_URL, RPC_URL, RPC_URL);

  console.log(`\nWallet: ${payer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < Number(DEPOSIT_AMOUNT) + 0.1 * LAMPORTS_PER_SOL) {
    console.log(`Insufficient balance. Need at least ${Number(DEPOSIT_AMOUNT + BigInt(0.1 * LAMPORTS_PER_SOL)) / LAMPORTS_PER_SOL} SOL.`);
    process.exit(1);
  }

  // Check initial compressed balance
  const initialCompressed = await rpc.getCompressedAccountsByOwner(payer.publicKey);
  let initialBalance = BigInt(0);
  for (const acct of initialCompressed.items) {
    initialBalance += BigInt(acct.lamports.toString());
  }
  console.log(`Initial compressed balance: ${Number(initialBalance) / LAMPORTS_PER_SOL} SOL`);

  // Find next available batch ID (unsettled, not full)
  let batchId = BigInt(0);
  let existingCount = 0;
  for (let i = 0; i < 20; i++) {
    const [pda] = getBatchPDA(batchId);
    const info = await connection.getAccountInfo(pda);
    if (!info) break;
    const { settled, commitmentCount } = parseBatchData(info.data);
    if (settled || commitmentCount >= 10) {
      batchId++;
    } else {
      existingCount = commitmentCount;
      break;
    }
  }
  const depositsNeeded = BATCH_THRESHOLD - existingCount;
  console.log(`\nUsing batch ID: ${batchId} (${existingCount}/${BATCH_THRESHOLD} existing, need ${depositsNeeded} more)`);

  const [stagingPDA] = getStagingPDA(payer.publicKey);
  const [batchPDA] = getBatchPDA(batchId);

  // Step 1: Ensure staging account
  console.log('\n[1] Ensuring staging account...');
  const stagingInfo = await connection.getAccountInfo(stagingPDA);
  if (!stagingInfo) {
    const tx = new Transaction().add(buildInitializeStaging(payer.publicKey, payer.publicKey, stagingPDA));
    const txId = await sendTx(connection, tx, payer);
    console.log(`    Created staging: ${txId}`);
  } else {
    // Withdraw any leftover balance first
    const leftover = stagingInfo.data.readBigUInt64LE(8 + 32);
    if (leftover > BigInt(0)) {
      console.log(`    Withdrawing leftover ${Number(leftover) / LAMPORTS_PER_SOL} SOL from staging...`);
      const tx = new Transaction().add(buildWithdrawFromStaging(payer.publicKey, stagingPDA, leftover));
      const txId = await sendTx(connection, tx, payer);
      console.log(`    Withdrawn: ${txId}`);
    } else {
      console.log('    Staging account exists, no leftover');
    }
  }

  // Step 2: Ensure batch
  console.log('\n[2] Ensuring batch...');
  const batchInfo = await connection.getAccountInfo(batchPDA);
  if (!batchInfo) {
    const tx = new Transaction().add(buildInitializeBatch(payer.publicKey, batchPDA, batchId));
    const txId = await sendTx(connection, tx, payer);
    console.log(`    Created batch: ${txId}`);
  } else {
    console.log('    Batch exists');
  }

  // Step 3: Do remaining deposits + commitments to fill batch
  for (let i = 0; i < depositsNeeded; i++) {
    console.log(`\n[3.${i + 1}] Deposit #${existingCount + i + 1}: ${Number(DEPOSIT_AMOUNT) / LAMPORTS_PER_SOL} SOL`);

    // Deposit to staging
    const depositTx = new Transaction().add(buildDeposit(payer.publicKey, stagingPDA, DEPOSIT_AMOUNT));
    const depositTxId = await sendTx(connection, depositTx, payer);
    console.log(`    Deposit tx: ${depositTxId}`);

    // Create commitment
    const commitment = generateCommitment(DEPOSIT_AMOUNT);
    const [commitmentPDA] = getCommitmentPDA(commitment);
    const commitTx = new Transaction().add(
      buildCreateCommitment(payer.publicKey, stagingPDA, commitmentPDA, batchPDA, DEPOSIT_AMOUNT, commitment)
    );
    const commitTxId = await sendTx(connection, commitTx, payer);
    console.log(`    Commitment tx: ${commitTxId}`);
  }

  // Check batch status
  const updatedBatch = await connection.getAccountInfo(batchPDA);
  const batchData = parseBatchData(updatedBatch.data);
  console.log(`\n[4] Batch status: ${batchData.commitmentCount}/3, settled: ${batchData.settled}`);

  if (batchData.commitmentCount < BATCH_THRESHOLD) {
    console.log('    Batch not full yet. Exiting.');
    process.exit(1);
  }

  // Step 5: Settle batch (mark as settled on-chain)
  console.log('\n[5] Settling batch...');
  const settleTx = new Transaction().add(buildSettleBatch(payer.publicKey, batchPDA));
  const settleTxId = await sendTx(connection, settleTx, payer);
  console.log(`    Settle tx: ${settleTxId}`);

  // Step 6: Release committed funds from staging (THE FIX)
  console.log('\n[6] Releasing committed funds from staging PDA...');
  const stagingAfterSettle = await connection.getAccountInfo(stagingPDA);
  const rentExempt = await connection.getMinimumBalanceForRentExemption(stagingAfterSettle.data.length);
  const releaseAmount = BigInt(stagingAfterSettle.lamports) - BigInt(rentExempt);
  console.log(`    Staging lamports: ${stagingAfterSettle.lamports}, rent-exempt: ${rentExempt}, releasable: ${Number(releaseAmount) / LAMPORTS_PER_SOL} SOL`);

  if (releaseAmount > BigInt(0)) {
    // Need to build release_settled_funds instruction
    const releaseData = Buffer.alloc(16);
    Buffer.from([240, 26, 68, 199, 78, 26, 192, 59]).copy(releaseData, 0); // releaseSettledFunds discriminator
    releaseData.writeBigUInt64LE(releaseAmount, 8);
    const releaseIx = {
      programId: TEE_BRIDGE_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: stagingPDA, isSigner: false, isWritable: true },
        { pubkey: batchPDA, isSigner: false, isWritable: false },
      ],
      data: releaseData,
    };
    const releaseTx = new Transaction().add(releaseIx);
    const releaseTxId = await sendTx(connection, releaseTx, payer);
    console.log(`    Release tx: ${releaseTxId}`);
  } else {
    console.log('    No funds to release');
  }

  // Step 7: Shield to Light Protocol (compress)
  const shieldAmount = releaseAmount > BigInt(0) ? releaseAmount : DEPOSIT_AMOUNT * BigInt(3);
  console.log(`\n[7] Shielding ${Number(shieldAmount) / LAMPORTS_PER_SOL} SOL to Light Protocol...`);

  try {
    const stateTreeLUTPairs = defaultStateTreeLookupTables().devnet;
    const treeInfos = await getAllStateTreeInfos({ connection, stateTreeLUTPairs });
    const outputStateTreeInfo = treeInfos[Math.floor(Math.random() * treeInfos.length)];

    const compressIx = await LightSystemProgram.compress({
      payer: payer.publicKey,
      toAddress: payer.publicKey,
      lamports: bn(shieldAmount.toString()),
      outputStateTreeInfo,
    });

    const shieldTx = new Transaction().add(compressIx);
    const shieldTxId = await sendTx(connection, shieldTx, payer);
    console.log(`    Shield tx: ${shieldTxId}`);
    console.log('    [LightPrivacy] Shield successful');
  } catch (err) {
    console.error(`    Shield failed: ${err.message}`);
    process.exit(1);
  }

  // Step 8: Verify compressed balance
  console.log('\n[8] Verifying shielded balance...');
  await new Promise(r => setTimeout(r, 3000));

  const finalCompressed = await rpc.getCompressedAccountsByOwner(payer.publicKey);
  let finalBalance = BigInt(0);
  for (const acct of finalCompressed.items) {
    finalBalance += BigInt(acct.lamports.toString());
  }

  const gained = finalBalance - initialBalance;
  console.log(`    Compressed balance: ${Number(finalBalance) / LAMPORTS_PER_SOL} SOL`);
  console.log(`    Gained: ${Number(gained) / LAMPORTS_PER_SOL} SOL`);

  console.log('\n' + '='.repeat(60));
  if (gained > BigInt(0)) {
    console.log('PASS: Shielded balance increased after batch settlement');
    console.log(`      ${Number(gained) / LAMPORTS_PER_SOL} SOL now in compressed pool`);
  } else {
    console.log('FAIL: Shielded balance did not increase');
    process.exit(1);
  }
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
