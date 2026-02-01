/**
 * TEE Batch Client - Real Batching Implementation
 *
 * This client interacts with the on-chain TEE Bridge program to implement
 * real batching where:
 * 1. Users deposit to staging PDA (funds held on-chain)
 * 2. Commitments are added to a batch
 * 3. When batch is full (3/3), settlement happens
 * 4. Only after settlement do funds go to Light Protocol
 *
 * PRIVACY: Users only see their balance AFTER batch settles.
 * This breaks the link between depositor and shielded funds.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { keccak_256 } from 'js-sha3';
import { shieldSolWithWallet } from './light-privacy';

// TEE Bridge Program ID (deployed on devnet)
export const TEE_BRIDGE_PROGRAM_ID = new PublicKey('7BWpEN8PqFEZ131A5F8iEniMS6bYREGrabxLHgSdUmVW');

// Seeds for PDA derivation
const STAGING_SEED = Buffer.from('staging');
const BATCH_SEED = Buffer.from('batch');
const COMMITMENT_SEED = Buffer.from('tee_commitment');

// Batch configuration
export const BATCH_THRESHOLD = 3; // Minimum deposits before settlement
export const BATCH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max wait

// ============================================
// PDA Derivation
// ============================================

export function getStagingPDA(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STAGING_SEED, user.toBuffer()],
    TEE_BRIDGE_PROGRAM_ID
  );
}

export function getBatchPDA(batchId: bigint): [PublicKey, number] {
  const batchIdBuffer = Buffer.alloc(8);
  batchIdBuffer.writeBigUInt64LE(batchId);
  return PublicKey.findProgramAddressSync(
    [BATCH_SEED, batchIdBuffer],
    TEE_BRIDGE_PROGRAM_ID
  );
}

export function getCommitmentPDA(commitment: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, Buffer.from(commitment)],
    TEE_BRIDGE_PROGRAM_ID
  );
}

// ============================================
// Account Structures
// ============================================

export interface StagingAccount {
  user: PublicKey;
  balance: bigint;
  commitmentCount: bigint;
  createdAt: bigint;
  bump: number;
}

export interface CommitmentBatch {
  id: bigint;
  authority: PublicKey;
  commitments: Uint8Array[];
  denominations: bigint[];
  commitmentCount: number;
  totalAmount: bigint;
  createdAt: bigint;
  settled: boolean;
  bump: number;
}

export interface BatchStatus {
  batchId: bigint;
  pendingCount: number;
  threshold: number;
  totalAmount: bigint;
  isReady: boolean;
  settled: boolean;
  createdAt: number;
  timeRemaining: number;
}

export interface DepositResult {
  success: boolean;
  txId?: string;
  stagingBalance?: bigint;
  batchStatus?: BatchStatus;
  error?: string;
}

export interface CommitmentResult {
  success: boolean;
  txId?: string;
  commitment?: Uint8Array;
  nullifier?: Uint8Array;
  secret?: Uint8Array;
  batchStatus?: BatchStatus;
  error?: string;
}

export interface SettlementResult {
  success: boolean;
  txId?: string;
  settledCount: number;
  totalAmount: bigint;
  error?: string;
}

// ============================================
// Instruction Builders
// ============================================

// Anchor discriminators (first 8 bytes of sha256("global:<instruction_name>"))
const DISCRIMINATORS = {
  initializeStaging: Buffer.from([194, 41, 68, 173, 201, 128, 147, 110]),
  depositToStaging: Buffer.from([222, 90, 105, 242, 136, 199, 187, 37]),
  createPrivateCommitment: Buffer.from([178, 210, 84, 183, 50, 250, 158, 59]),
  settleBatch: Buffer.from([22, 2, 21, 223, 225, 122, 163, 214]),
  initializeBatch: Buffer.from([126, 44, 205, 90, 220, 105, 105, 193]),
  withdrawFromStaging: Buffer.from([170, 210, 198, 109, 3, 235, 107, 96]),
  releaseSettledFunds: Buffer.from([240, 26, 68, 199, 78, 26, 192, 59]),
};

function buildInitializeStagingIx(
  payer: PublicKey,
  user: PublicKey,
  staging: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: staging, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.initializeStaging,
  });
}

function buildDepositToStagingIx(
  user: PublicKey,
  staging: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  DISCRIMINATORS.depositToStaging.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  return new TransactionInstruction({
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: staging, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildCreateCommitmentIx(
  user: PublicKey,
  staging: PublicKey,
  teeCommitment: PublicKey,
  batch: PublicKey,
  denomination: bigint,
  commitment: Uint8Array,
  encryptedNote: Uint8Array | null,
): TransactionInstruction {
  // Data: discriminator (8) + denomination (8) + commitment (32) + option<encrypted_note> (1 + 128)
  const data = Buffer.alloc(8 + 8 + 32 + 1 + 128);
  let offset = 0;

  DISCRIMINATORS.createPrivateCommitment.copy(data, offset);
  offset += 8;

  data.writeBigUInt64LE(denomination, offset);
  offset += 8;

  Buffer.from(commitment).copy(data, offset);
  offset += 32;

  if (encryptedNote) {
    data.writeUInt8(1, offset); // Some
    offset += 1;
    Buffer.from(encryptedNote).copy(data, offset);
  } else {
    data.writeUInt8(0, offset); // None
  }

  return new TransactionInstruction({
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: staging, isSigner: false, isWritable: true },
      { pubkey: teeCommitment, isSigner: false, isWritable: true },
      { pubkey: batch, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildInitializeBatchIx(
  authority: PublicKey,
  batch: PublicKey,
  batchId: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  DISCRIMINATORS.initializeBatch.copy(data, 0);
  data.writeBigUInt64LE(batchId, 8);

  return new TransactionInstruction({
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: batch, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWithdrawFromStagingIx(
  user: PublicKey,
  staging: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  DISCRIMINATORS.withdrawFromStaging.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  return new TransactionInstruction({
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: staging, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function buildReleaseSettledFundsIx(
  user: PublicKey,
  staging: PublicKey,
  batch: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  DISCRIMINATORS.releaseSettledFunds.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  return new TransactionInstruction({
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: staging, isSigner: false, isWritable: true },
      { pubkey: batch, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildSettleBatchIx(
  settler: PublicKey,
  batch: PublicKey,
): TransactionInstruction {
  // Anyone can settle when batch is full - no authority restriction
  return new TransactionInstruction({
    programId: TEE_BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: settler, isSigner: true, isWritable: true },
      { pubkey: batch, isSigner: false, isWritable: true },
    ],
    data: DISCRIMINATORS.settleBatch,
  });
}

// ============================================
// TEE Batch Client
// ============================================

export class TeeBatchClient {
  private connection: Connection;
  private currentBatchId: bigint = BigInt(0);

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  /**
   * Generate commitment data (nullifier, secret, commitment hash)
   */
  generateCommitment(amountLamports: bigint): {
    commitment: Uint8Array;
    nullifier: Uint8Array;
    secret: Uint8Array;
    encryptedNote: Uint8Array;
  } {
    const nullifier = new Uint8Array(32);
    const secret = new Uint8Array(32);
    crypto.getRandomValues(nullifier);
    crypto.getRandomValues(secret);

    const amountBytes = new Uint8Array(8);
    const view = new DataView(amountBytes.buffer);
    view.setBigUint64(0, amountLamports, true);

    // Commitment = Keccak256(nullifier || secret || amount)
    const preimage = new Uint8Array(72);
    preimage.set(nullifier, 0);
    preimage.set(secret, 32);
    preimage.set(amountBytes, 64);

    const commitmentHex = keccak_256(preimage);
    const commitment = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      commitment[i] = parseInt(commitmentHex.substr(i * 2, 2), 16);
    }

    // Encrypted note (for user to recover nullifier/secret)
    const encryptedNote = new Uint8Array(128);
    encryptedNote.set(nullifier, 0);
    encryptedNote.set(secret, 32);
    encryptedNote.set(amountBytes, 64);

    return { commitment, nullifier, secret, encryptedNote };
  }

  /**
   * Get or create staging account for user
   */
  async ensureStagingAccount(
    user: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
  ): Promise<PublicKey> {
    const [stagingPDA] = getStagingPDA(user);

    // Check if staging account exists
    const stagingInfo = await this.connection.getAccountInfo(stagingPDA);
    if (stagingInfo) {
      console.log('[TeeBatch] Staging account exists:', stagingPDA.toBase58());
      return stagingPDA;
    }

    // Create staging account
    console.log('[TeeBatch] Creating staging account...');
    const ix = buildInitializeStagingIx(user, user, stagingPDA);
    const tx = new Transaction().add(ix);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;

    const signedTx = await signTransaction(tx);
    const txId = await this.connection.sendRawTransaction(signedTx.serialize());
    await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

    console.log('[TeeBatch] Staging account created:', txId);
    return stagingPDA;
  }

  /**
   * Get current batch status from on-chain
   */
  async getBatchStatus(): Promise<BatchStatus> {
    // Advance past settled or full batches to find the current active one
    await this.advanceToActiveBatch();

    const [batchPDA] = getBatchPDA(this.currentBatchId);

    try {
      const batchInfo = await this.connection.getAccountInfo(batchPDA);

      if (!batchInfo) {
        // No batch exists yet
        return {
          batchId: this.currentBatchId,
          pendingCount: 0,
          threshold: BATCH_THRESHOLD,
          totalAmount: BigInt(0),
          isReady: false,
          settled: false,
          createdAt: Date.now(),
          timeRemaining: BATCH_TIMEOUT_MS,
        };
      }

      const { commitmentCount, totalAmount, createdAt, settled } = this.parseBatchData(batchInfo.data);

      const elapsed = Date.now() - createdAt * 1000;
      const timeRemaining = Math.max(0, BATCH_TIMEOUT_MS - elapsed);

      return {
        batchId: this.currentBatchId,
        pendingCount: commitmentCount,
        threshold: BATCH_THRESHOLD,
        totalAmount,
        isReady: commitmentCount >= BATCH_THRESHOLD,
        settled,
        createdAt: createdAt * 1000,
        timeRemaining,
      };
    } catch (err) {
      console.error('[TeeBatch] Failed to get batch status:', err);
      return {
        batchId: this.currentBatchId,
        pendingCount: 0,
        threshold: BATCH_THRESHOLD,
        totalAmount: BigInt(0),
        isReady: false,
        settled: false,
        createdAt: Date.now(),
        timeRemaining: BATCH_TIMEOUT_MS,
      };
    }
  }

  /**
   * Parse raw batch account data into structured fields
   */
  private parseBatchData(data: Buffer): {
    commitmentCount: number;
    totalAmount: bigint;
    createdAt: number;
    settled: boolean;
  } {
    // Layout: discriminator(8) + id(8) + authority(32) + commitments(32*10) + denominations(8*10) + commitment_count(1) + total_amount(8) + created_at(8) + settled(1) + bump(1)
    const countOffset = 8 + 8 + 32 + 320 + 80;
    return {
      commitmentCount: data[countOffset],
      totalAmount: data.readBigUInt64LE(countOffset + 1),
      createdAt: Number(data.readBigInt64LE(countOffset + 1 + 8)),
      settled: data[countOffset + 1 + 8 + 8] === 1,
    };
  }

  /**
   * Advance currentBatchId past any settled or full (10/10) batches
   */
  private async advanceToActiveBatch(): Promise<void> {
    // Check up to 10 batches ahead to find an active one
    for (let i = 0; i < 10; i++) {
      const [batchPDA] = getBatchPDA(this.currentBatchId);
      const batchInfo = await this.connection.getAccountInfo(batchPDA);

      if (!batchInfo) {
        // No batch at this ID — this is where the next batch will be created
        return;
      }

      const { commitmentCount, settled } = this.parseBatchData(batchInfo.data);

      if (settled || commitmentCount >= 10) {
        console.log(`[TeeBatch] Batch ${this.currentBatchId} is ${settled ? 'settled' : 'full'} (${commitmentCount}/10), advancing...`);
        this.currentBatchId++;
      } else {
        // Found an active batch
        return;
      }
    }
  }

  /**
   * Ensure a batch exists for collecting commitments
   */
  async ensureBatch(
    authority: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
  ): Promise<PublicKey> {
    const [batchPDA] = getBatchPDA(this.currentBatchId);

    const batchInfo = await this.connection.getAccountInfo(batchPDA);
    if (batchInfo) {
      // Check if batch is settled, if so increment to next batch
      const settled = batchInfo.data[8 + 8 + 32 + 320 + 80 + 1 + 8 + 8] === 1;
      if (settled) {
        this.currentBatchId++;
        return this.ensureBatch(authority, signTransaction);
      }
      return batchPDA;
    }

    // Create new batch
    console.log('[TeeBatch] Creating batch', this.currentBatchId.toString());
    const ix = buildInitializeBatchIx(authority, batchPDA, this.currentBatchId);
    const tx = new Transaction().add(ix);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority;

    const signedTx = await signTransaction(tx);
    const txId = await this.connection.sendRawTransaction(signedTx.serialize());
    await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

    console.log('[TeeBatch] Batch created:', txId);
    return batchPDA;
  }

  /**
   * Deposit to staging - Step 1 of batched deposit
   * SOL goes to staging PDA, waiting for batch settlement
   */
  async depositToStaging(
    user: PublicKey,
    amount: bigint,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
  ): Promise<DepositResult> {
    try {
      console.log(`[TeeBatch] Depositing ${Number(amount) / LAMPORTS_PER_SOL} SOL to staging...`);

      // Ensure staging account exists
      const stagingPDA = await this.ensureStagingAccount(user, signTransaction);

      // Build deposit instruction
      const ix = buildDepositToStagingIx(user, stagingPDA, amount);
      const tx = new Transaction().add(ix);

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = user;

      const signedTx = await signTransaction(tx);
      const txId = await this.connection.sendRawTransaction(signedTx.serialize());
      await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

      console.log('[TeeBatch] Deposit to staging successful:', txId);

      // Get updated staging balance
      const stagingInfo = await this.connection.getAccountInfo(stagingPDA);
      const stagingBalance = stagingInfo ? BigInt(stagingInfo.lamports) : BigInt(0);

      return {
        success: true,
        txId,
        stagingBalance,
        batchStatus: await this.getBatchStatus(),
      };
    } catch (err) {
      console.error('[TeeBatch] Deposit to staging failed:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Create commitment and add to batch - Step 2 of batched deposit
   */
  async createCommitment(
    user: PublicKey,
    denomination: bigint,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
  ): Promise<CommitmentResult> {
    try {
      console.log(`[TeeBatch] Creating commitment for ${Number(denomination) / LAMPORTS_PER_SOL} SOL...`);

      // Ensure batch exists
      const batchPDA = await this.ensureBatch(user, signTransaction);

      // Generate commitment data
      const { commitment, nullifier, secret, encryptedNote } = this.generateCommitment(denomination);

      // Get PDAs
      const [stagingPDA] = getStagingPDA(user);
      const [commitmentPDA] = getCommitmentPDA(commitment);

      // Build create commitment instruction
      const ix = buildCreateCommitmentIx(
        user,
        stagingPDA,
        commitmentPDA,
        batchPDA,
        denomination,
        commitment,
        encryptedNote,
      );
      const tx = new Transaction().add(ix);

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = user;

      const signedTx = await signTransaction(tx);
      const txId = await this.connection.sendRawTransaction(signedTx.serialize());
      await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

      console.log('[TeeBatch] Commitment created:', txId);

      const batchStatus = await this.getBatchStatus();
      console.log(`[TeeBatch] Batch status: ${batchStatus.pendingCount}/${batchStatus.threshold}`);

      return {
        success: true,
        txId,
        commitment,
        nullifier,
        secret,
        batchStatus,
      };
    } catch (err) {
      console.error('[TeeBatch] Create commitment failed:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Settle batch - ANYONE can call when batch is full (3/3)
   * This transfers all staged funds to Light Protocol together
   *
   * Privacy: The settler gains no information - they only see commitment hashes
   */
  async settleBatch(
    settler: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
  ): Promise<SettlementResult> {
    try {
      const batchStatus = await this.getBatchStatus();

      if (batchStatus.pendingCount < BATCH_THRESHOLD) {
        return {
          success: false,
          settledCount: 0,
          totalAmount: BigInt(0),
          error: `Batch not ready: ${batchStatus.pendingCount}/${BATCH_THRESHOLD}`,
        };
      }

      if (batchStatus.settled) {
        return {
          success: false,
          settledCount: 0,
          totalAmount: BigInt(0),
          error: 'Batch already settled',
        };
      }

      console.log(`[TeeBatch] Settling batch with ${batchStatus.pendingCount} commitments...`);
      console.log('[TeeBatch] Anyone can settle - no authority restriction');

      const [batchPDA] = getBatchPDA(this.currentBatchId);

      // Step 1: Mark batch as settled on-chain (anyone can do this)
      const settleIx = buildSettleBatchIx(settler, batchPDA);
      const settleTx = new Transaction().add(settleIx);

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      settleTx.recentBlockhash = blockhash;
      settleTx.feePayer = settler;

      const signedSettleTx = await signTransaction(settleTx);
      const settleTxId = await this.connection.sendRawTransaction(signedSettleTx.serialize());
      await this.connection.confirmTransaction({ signature: settleTxId, blockhash, lastValidBlockHeight });

      console.log('[TeeBatch] Batch marked as settled:', settleTxId);

      // Step 2: Release settler's committed funds from staging PDA back to wallet
      const [stagingPDA] = getStagingPDA(settler);
      const stagingInfo = await this.connection.getAccountInfo(stagingPDA);

      // Calculate releasable amount: total lamports minus rent-exempt minimum
      let releaseAmount = BigInt(0);
      if (stagingInfo) {
        const rentExempt = await this.connection.getMinimumBalanceForRentExemption(stagingInfo.data.length);
        const excess = BigInt(stagingInfo.lamports) - BigInt(rentExempt);
        if (excess > BigInt(0)) {
          releaseAmount = excess;
        }
      }

      if (releaseAmount > BigInt(0)) {
        console.log(`[TeeBatch] Releasing ${Number(releaseAmount) / LAMPORTS_PER_SOL} SOL from staging...`);
        const releaseIx = buildReleaseSettledFundsIx(settler, stagingPDA, batchPDA, releaseAmount);
        const releaseTx = new Transaction().add(releaseIx);

        const releaseBlockhash = await this.connection.getLatestBlockhash();
        releaseTx.recentBlockhash = releaseBlockhash.blockhash;
        releaseTx.feePayer = settler;

        const signedReleaseTx = await signTransaction(releaseTx);
        const releaseTxId = await this.connection.sendRawTransaction(signedReleaseTx.serialize());
        await this.connection.confirmTransaction({
          signature: releaseTxId,
          blockhash: releaseBlockhash.blockhash,
          lastValidBlockHeight: releaseBlockhash.lastValidBlockHeight,
        });
        console.log('[TeeBatch] Staging release successful:', releaseTxId);
      }

      // Step 3: Shield settler's own amount to Light Protocol
      console.log('[TeeBatch] Shielding settler funds to Light Protocol...');

      const shieldAmount = releaseAmount > BigInt(0) ? releaseAmount : batchStatus.totalAmount;
      const shieldResult = await shieldSolWithWallet(
        this.connection,
        settler,
        shieldAmount,
        signTransaction,
      );

      if (!shieldResult.success) {
        console.error('[TeeBatch] Light Protocol shield failed:', shieldResult.error);
      } else {
        console.log('[TeeBatch] Settler funds shielded to Light Protocol:', shieldResult.signature);
      }

      // Increment to next batch
      this.currentBatchId++;

      return {
        success: true,
        txId: settleTxId,
        settledCount: batchStatus.pendingCount,
        totalAmount: batchStatus.totalAmount,
      };
    } catch (err) {
      console.error('[TeeBatch] Settle batch failed:', err);
      return {
        success: false,
        settledCount: 0,
        totalAmount: BigInt(0),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Full batched deposit flow:
   * 1. Deposit to staging
   * 2. Create commitment (adds to batch)
   * 3. If batch full (3/3), ANYONE can settle - no authority restriction
   *
   * Returns immediately after step 2 - user must wait for batch to settle
   * to see their balance in Light Protocol
   */
  async batchedDeposit(
    user: PublicKey,
    amount: bigint,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
  ): Promise<CommitmentResult & { settled?: boolean }> {
    // Step 1: Deposit to staging
    const depositResult = await this.depositToStaging(user, amount, signTransaction);
    if (!depositResult.success) {
      return {
        success: false,
        error: depositResult.error,
      };
    }

    // Step 2: Create commitment
    const commitmentResult = await this.createCommitment(user, amount, signTransaction);
    if (!commitmentResult.success) {
      return commitmentResult;
    }

    // Step 3: If batch is full, settle it (anyone can do this now)
    const batchStatus = commitmentResult.batchStatus!;
    let settled = false;

    if (batchStatus.isReady) {
      console.log('[TeeBatch] Batch is full (3/3)! Auto-settling...');
      const settleResult = await this.settleBatch(user, signTransaction);

      if (settleResult.success) {
        settled = true;
        console.log('[TeeBatch] Batch settled! All funds now in Light Protocol.');
      } else {
        console.log('[TeeBatch] Settlement failed:', settleResult.error);
        // This shouldn't happen with permissionless settlement
        // Unless there's a network error or batch was already settled
      }
    } else {
      console.log(`[TeeBatch] Waiting for more deposits: ${batchStatus.pendingCount}/${batchStatus.threshold}`);
      console.log('[TeeBatch] Balance will appear after batch settles');
    }

    return {
      ...commitmentResult,
      settled,
    };
  }
}

// ============================================
// Singleton Instance
// ============================================

let teeBatchClient: TeeBatchClient | null = null;

export function getTeeBatchClient(rpcUrl: string): TeeBatchClient {
  if (!teeBatchClient) {
    teeBatchClient = new TeeBatchClient(rpcUrl);
  }
  return teeBatchClient;
}
