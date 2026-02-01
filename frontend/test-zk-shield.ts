/**
 * End-to-end test for ZK Shield (ShadowWire)
 * Run with: npx ts-node test-zk-shield.ts
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import {
  buildPrivateDepositInstruction,
  getPoolConfig,
  DENOMINATION_1_SOL,
} from './src/lib/program';
import { createPrivateNote, generateNullifierHash, bytesToField } from './src/lib/zk-crypto';
import bs58 from 'bs58';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';

async function testZkShield() {
  console.log('=== ZK Shield End-to-End Test ===\n');

  // 1. Setup connection
  const connection = new Connection(RPC_URL, 'confirmed');
  console.log('1. Connected to:', RPC_URL);

  // 2. Create or load test wallet
  const testWallet = Keypair.generate();
  console.log('2. Test wallet:', testWallet.publicKey.toBase58());

  // 3. Request airdrop (devnet only)
  console.log('3. Requesting airdrop of 2 SOL...');
  try {
    const airdropSig = await connection.requestAirdrop(testWallet.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig, 'confirmed');
    console.log('   Airdrop confirmed:', airdropSig.slice(0, 20) + '...');
  } catch (err) {
    console.log('   Airdrop failed (may already have funds):', err);
  }

  // Check balance
  const balance = await connection.getBalance(testWallet.publicKey);
  console.log('   Balance:', balance / LAMPORTS_PER_SOL, 'SOL');

  if (balance < LAMPORTS_PER_SOL) {
    console.log('\n❌ Insufficient balance for test. Need at least 1 SOL.');
    return;
  }

  // 4. Create ZK commitment
  console.log('\n4. Creating ZK commitment...');
  const denomination = DENOMINATION_1_SOL;
  const { note: zkNote, commitment } = createPrivateNote(denomination);
  console.log('   Commitment:', commitment.toString(16).slice(0, 20) + '...');
  console.log('   Nullifier:', zkNote.nullifier.toString().slice(0, 20) + '...');

  // Convert commitment to bytes
  const commitmentBytes = new Uint8Array(32);
  const commitmentHex = commitment.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) {
    commitmentBytes[i] = parseInt(commitmentHex.slice(i * 2, i * 2 + 2), 16);
  }

  // 5. Get pool config
  console.log('\n5. Fetching pool config...');
  const config = await getPoolConfig(connection, denomination);
  if (!config) {
    console.log('❌ Pool config not found. Pool may not be initialized.');
    return;
  }
  console.log('   Fee recipient:', config.feeRecipient.toBase58().slice(0, 20) + '...');
  console.log('   Fee (bps):', config.feeBps);

  // 6. Build deposit instruction
  console.log('\n6. Building deposit instruction...');
  const depositInstruction = buildPrivateDepositInstruction({
    depositor: testWallet.publicKey,
    denomination,
    commitment: commitmentBytes,
    feeRecipient: config.feeRecipient,
  });

  // 7. Request compute budget (1.4M CUs)
  console.log('7. Requesting 1.4M compute units...');
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });

  // 8. Build and send transaction
  console.log('\n8. Building transaction...');
  const transaction = new Transaction()
    .add(computeBudgetIx)
    .add(depositInstruction);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = testWallet.publicKey;
  transaction.sign(testWallet);

  console.log('9. Sending transaction...');
  try {
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    console.log('   TX Signature:', signature);

    console.log('10. Confirming transaction...');
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    if (confirmation.value.err) {
      console.log('\n❌ Transaction failed:', confirmation.value.err);

      // Get transaction logs
      const txInfo = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (txInfo?.meta?.logMessages) {
        console.log('\nTransaction logs:');
        txInfo.meta.logMessages.forEach(log => console.log('  ', log));
      }
    } else {
      console.log('\n✅ ZK Shield SUCCESS!');
      console.log('   Transaction:', `https://explorer.solana.com/tx/${signature}?cluster=devnet`);

      // Generate note code for receiving
      const nullifierHash = generateNullifierHash(
        zkNote.nullifier,
        BigInt(0), // leaf index would come from on-chain
        bytesToField(zkNote.secret)
      );

      const noteData = {
        c: commitment.toString(),
        n: zkNote.nullifier.toString(),
        h: nullifierHash.toString(),
        s: bs58.encode(zkNote.secret),
        d: 1, // 1 SOL
        i: 0, // leaf index
      };
      const noteCode = 'swn:' + Buffer.from(JSON.stringify(noteData)).toString('base64');

      console.log('\n   Private Note Code (save this!):');
      console.log('   ', noteCode.slice(0, 60) + '...');
    }
  } catch (err: any) {
    console.log('\n❌ Transaction error:', err.message);

    if (err.logs) {
      console.log('\nTransaction logs:');
      err.logs.forEach((log: string) => console.log('  ', log));
    }
  }

  // Final balance
  const finalBalance = await connection.getBalance(testWallet.publicKey);
  console.log('\n   Final balance:', finalBalance / LAMPORTS_PER_SOL, 'SOL');
}

testZkShield().catch(console.error);
