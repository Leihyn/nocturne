/**
 * TEE Staging Client
 *
 * TypeScript client for interacting with the TEE Bridge Anchor program.
 * Handles deposits to staging, commitment creation, and batch monitoring.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from '@solana/web3.js';
import { keccak_256 } from 'js-sha3';
import { shieldSolWithWallet } from './light-privacy';

// Program ID from tee-bridge
export const TEE_BRIDGE_PROGRAM_ID = new PublicKey('7BWpEN8PqFEZ131A5F8iEniMS6bYREGrabxLHgSdUmVW');

// Seeds
const STAGING_SEED = Buffer.from('staging');
const BATCH_SEED = Buffer.from('batch');
const COMMITMENT_SEED = Buffer.from('tee_commitment');

// Valid denominations
export const TEE_DENOMINATIONS = {
  ONE_SOL: BigInt(1_000_000_000),
  TEN_SOL: BigInt(10_000_000_000),
  HUNDRED_SOL: BigInt(100_000_000_000),
};

// Batch configuration
export const BATCH_CONFIG = {
  MIN_DEPOSITS: 3,        // Minimum deposits before settlement
  MAX_DEPOSITS: 10,       // Maximum per batch
  MAX_WAIT_SECONDS: 600,  // 10 minutes max wait
  CHECK_INTERVAL: 30000,  // Check every 30 seconds
};

// Types
export interface StagingAccount {
  user: PublicKey;
  balance: bigint;
  commitmentCount: number;
  createdAt: number;
  bump: number;
}

export interface PendingDeposit {
  id: string;
  amount: bigint;
  commitment: Uint8Array;
  nullifier: Uint8Array;
  secret: Uint8Array;
  status: 'pending' | 'batched' | 'settled' | 'failed';
  createdAt: number;
  batchId?: number;
}

export interface CommitmentBatch {
  id: number;
  authority: PublicKey;
  commitments: Uint8Array[];
  denominations: bigint[];
  commitmentCount: number;
  totalAmount: bigint;
  createdAt: number;
  settled: boolean;
}

export interface TeeDepositResult {
  success: boolean;
  stagingTxId?: string;
  pendingDeposit?: PendingDeposit;
  error?: string;
}

export interface BatchSettlementResult {
  success: boolean;
  batchId?: number;
  settlementTxId?: string;
  lightProtocolTxId?: string;
  settledCount?: number;
  error?: string;
}

// ============================================
// PDA Derivation
// ============================================

export function getStagingPDA(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STAGING_SEED, user.toBuffer()],
    TEE_BRIDGE_PROGRAM_ID
  );
}

export function getBatchPDA(batchId: number): [PublicKey, number] {
  const batchIdBuffer = Buffer.alloc(8);
  batchIdBuffer.writeBigUInt64LE(BigInt(batchId));
  return PublicKey.findProgramAddressSync(
    [BATCH_SEED, batchIdBuffer],
    TEE_BRIDGE_PROGRAM_ID
  );
}

export function getCommitmentPDA(commitment: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, commitment],
    TEE_BRIDGE_PROGRAM_ID
  );
}

// ============================================
// Commitment Generation
// ============================================

function generateSecureRandom(length: number): Uint8Array {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

export function generateCommitmentSecrets(): {
  nullifier: Uint8Array;
  secret: Uint8Array;
  commitment: Uint8Array;
} {
  const nullifier = generateSecureRandom(32);
  const secret = generateSecureRandom(32);

  // commitment = keccak256(nullifier || secret)
  const preimage = new Uint8Array(64);
  preimage.set(nullifier, 0);
  preimage.set(secret, 32);
  const commitment = new Uint8Array(keccak_256.arrayBuffer(preimage));

  return { nullifier, secret, commitment };
}

export function encryptNote(
  nullifier: Uint8Array,
  secret: Uint8Array,
  amount: bigint,
  encryptionKey: Uint8Array
): Uint8Array {
  // Simple XOR encryption for demo (use proper encryption in production)
  const note = new Uint8Array(128);
  note.set(nullifier, 0);
  note.set(secret, 32);

  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, amount, true);
  note.set(amountBytes, 64);

  // XOR with key (repeated)
  for (let i = 0; i < note.length; i++) {
    note[i] ^= encryptionKey[i % encryptionKey.length];
  }

  return note;
}

// ============================================
// TEE Staging Client
// ============================================

export class TeeStagingClient {
  private connection: Connection;
  private currentBatchId: number = 0;
  private pendingDeposits: Map<string, PendingDeposit> = new Map();
  private settlementCheckInterval: NodeJS.Timeout | null = null;

  constructor(rpcUrl: string = 'https://api.devnet.solana.com') {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  // ============================================
  // Account Queries
  // ============================================

  async getStagingAccount(user: PublicKey): Promise<StagingAccount | null> {
    try {
      const [stagingPDA] = getStagingPDA(user);
      const accountInfo = await this.connection.getAccountInfo(stagingPDA);

      if (!accountInfo) return null;

      // Parse account data (Anchor format: 8 byte discriminator + data)
      const data = accountInfo.data.slice(8);

      return {
        user: new PublicKey(data.slice(0, 32)),
        balance: BigInt(new DataView(data.buffer, data.byteOffset + 32, 8).getBigUint64(0, true)),
        commitmentCount: Number(new DataView(data.buffer, data.byteOffset + 40, 8).getBigUint64(0, true)),
        createdAt: Number(new DataView(data.buffer, data.byteOffset + 48, 8).getBigInt64(0, true)),
        bump: data[56],
      };
    } catch (error) {
      console.error('[TEE Staging] Failed to get staging account:', error);
      return null;
    }
  }

  async getCurrentBatch(): Promise<CommitmentBatch | null> {
    try {
      const [batchPDA] = getBatchPDA(this.currentBatchId);
      const accountInfo = await this.connection.getAccountInfo(batchPDA);

      if (!accountInfo) return null;

      const data = accountInfo.data.slice(8);

      // Parse commitments array
      const commitments: Uint8Array[] = [];
      const denominations: bigint[] = [];
      const commitmentCount = data[32 + 320 + 80]; // After id(8) + authority(32) + commitments(320) + denoms(80)

      for (let i = 0; i < commitmentCount; i++) {
        commitments.push(new Uint8Array(data.slice(40 + i * 32, 40 + (i + 1) * 32)));
        denominations.push(BigInt(new DataView(data.buffer, data.byteOffset + 360 + i * 8, 8).getBigUint64(0, true)));
      }

      return {
        id: Number(new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true)),
        authority: new PublicKey(data.slice(8, 40)),
        commitments,
        denominations,
        commitmentCount,
        totalAmount: BigInt(new DataView(data.buffer, data.byteOffset + 441, 8).getBigUint64(0, true)),
        createdAt: Number(new DataView(data.buffer, data.byteOffset + 449, 8).getBigInt64(0, true)),
        settled: data[457] === 1,
      };
    } catch (error) {
      console.error('[TEE Staging] Failed to get current batch:', error);
      return null;
    }
  }

  // ============================================
  // Deposit Operations
  // ============================================

  async initializeStaging(
    user: PublicKey,
    payer: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    const [stagingPDA, bump] = getStagingPDA(user);

    // Check if already exists
    const existing = await this.connection.getAccountInfo(stagingPDA);
    if (existing) {
      console.log('[TEE Staging] Staging account already exists');
      return 'already-exists';
    }

    // Build initialize instruction
    // Discriminator for initialize_staging (first 8 bytes of sha256("global:initialize_staging"))
    const discriminator = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: user, isSigner: false, isWritable: false },
        { pubkey: stagingPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: TEE_BRIDGE_PROGRAM_ID,
      data: discriminator,
    });

    const tx = new Transaction().add(instruction);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;

    const signedTx = await signTransaction(tx);
    const txId = await this.connection.sendRawTransaction(signedTx.serialize());
    await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

    console.log('[TEE Staging] Staging account initialized:', txId);
    return txId;
  }

  async depositToStaging(
    user: PublicKey,
    amount: bigint,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<TeeDepositResult> {
    try {
      // Validate denomination
      if (amount !== TEE_DENOMINATIONS.ONE_SOL &&
          amount !== TEE_DENOMINATIONS.TEN_SOL &&
          amount !== TEE_DENOMINATIONS.HUNDRED_SOL) {
        return { success: false, error: 'Invalid denomination. Must be 1, 10, or 100 SOL' };
      }

      const [stagingPDA] = getStagingPDA(user);

      // Ensure staging account exists
      const stagingAccount = await this.getStagingAccount(user);
      if (!stagingAccount) {
        console.log('[TEE Staging] Initializing staging account first...');
        await this.initializeStaging(user, user, signTransaction);
      }

      // Generate commitment secrets
      const { nullifier, secret, commitment } = generateCommitmentSecrets();

      // Build deposit instruction
      // Discriminator for deposit_to_staging
      const discriminator = Buffer.from([179, 63, 122, 67, 101, 186, 57, 10]);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount);

      const depositIx = new TransactionInstruction({
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: stagingPDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: TEE_BRIDGE_PROGRAM_ID,
        data: Buffer.concat([discriminator, amountBuffer]),
      });

      const tx = new Transaction().add(depositIx);
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = user;

      const signedTx = await signTransaction(tx);
      const txId = await this.connection.sendRawTransaction(signedTx.serialize());
      await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

      console.log('[TEE Staging] Deposit to staging successful:', txId);

      // Create pending deposit record
      const pendingDeposit: PendingDeposit = {
        id: Buffer.from(commitment).toString('hex').slice(0, 16),
        amount,
        commitment,
        nullifier,
        secret,
        status: 'pending',
        createdAt: Date.now(),
      };

      this.pendingDeposits.set(pendingDeposit.id, pendingDeposit);

      return {
        success: true,
        stagingTxId: txId,
        pendingDeposit,
      };
    } catch (error) {
      console.error('[TEE Staging] Deposit failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ============================================
  // Batch Settlement
  // ============================================

  async settleBatch(
    authority: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<BatchSettlementResult> {
    try {
      const batch = await this.getCurrentBatch();
      if (!batch || batch.commitmentCount === 0) {
        return { success: false, error: 'No pending commitments to settle' };
      }

      console.log(`[TEE Staging] Settling batch ${batch.id} with ${batch.commitmentCount} commitments`);

      // Step 1: Mark batch as settled on-chain
      const [batchPDA] = getBatchPDA(batch.id);

      // Discriminator for settle_batch
      const discriminator = Buffer.from([196, 82, 210, 252, 172, 196, 89, 248]);

      const settleIx = new TransactionInstruction({
        keys: [
          { pubkey: authority, isSigner: true, isWritable: true },
          { pubkey: batchPDA, isSigner: false, isWritable: true },
        ],
        programId: TEE_BRIDGE_PROGRAM_ID,
        data: discriminator,
      });

      const settleTx = new Transaction().add(settleIx);
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      settleTx.recentBlockhash = blockhash;
      settleTx.feePayer = authority;

      const signedSettleTx = await signTransaction(settleTx);
      const settleTxId = await this.connection.sendRawTransaction(signedSettleTx.serialize());
      await this.connection.confirmTransaction({ signature: settleTxId, blockhash, lastValidBlockHeight });

      console.log('[TEE Staging] Batch marked as settled:', settleTxId);

      // Step 2: Shield to Light Protocol
      const lightResult = await shieldSolWithWallet(
        this.connection,
        authority,
        batch.totalAmount,
        signTransaction
      );

      if (!lightResult.success) {
        console.error('[TEE Staging] Light Protocol settlement failed:', lightResult.error);
        return {
          success: false,
          batchId: batch.id,
          settlementTxId: settleTxId,
          error: `Light Protocol failed: ${lightResult.error}`,
        };
      }

      console.log('[TEE Staging] Light Protocol settlement successful:', lightResult.signature);

      // Update pending deposits
      for (const deposit of this.pendingDeposits.values()) {
        if (deposit.status === 'pending' || deposit.status === 'batched') {
          deposit.status = 'settled';
          deposit.batchId = batch.id;
        }
      }

      // Increment batch ID for next batch
      this.currentBatchId++;

      return {
        success: true,
        batchId: batch.id,
        settlementTxId: settleTxId,
        lightProtocolTxId: lightResult.signature,
        settledCount: batch.commitmentCount,
      };
    } catch (error) {
      console.error('[TEE Staging] Batch settlement failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ============================================
  // Full TEE Deposit Flow
  // ============================================

  async fullTeeDeposit(
    user: PublicKey,
    amount: bigint,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<TeeDepositResult & { lightProtocolTxId?: string }> {
    try {
      console.log(`[TEE Staging] Starting full TEE deposit flow for ${Number(amount) / LAMPORTS_PER_SOL} SOL`);

      // Step 1: Deposit to staging
      const depositResult = await this.depositToStaging(user, amount, signTransaction);
      if (!depositResult.success) {
        return depositResult;
      }

      console.log('[TEE Staging] Deposit to staging complete');

      // Step 2: Check if batch is ready for settlement
      const pendingCount = Array.from(this.pendingDeposits.values())
        .filter(d => d.status === 'pending').length;

      const oldestPending = Array.from(this.pendingDeposits.values())
        .filter(d => d.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)[0];

      const waitTime = oldestPending ? Date.now() - oldestPending.createdAt : 0;

      const shouldSettle = pendingCount >= BATCH_CONFIG.MIN_DEPOSITS ||
        waitTime >= BATCH_CONFIG.MAX_WAIT_SECONDS * 1000;

      if (shouldSettle) {
        console.log('[TEE Staging] Batch ready, settling immediately...');
        const settleResult = await this.settleBatch(user, signTransaction);

        if (settleResult.success) {
          return {
            ...depositResult,
            lightProtocolTxId: settleResult.lightProtocolTxId,
          };
        } else {
          console.warn('[TEE Staging] Settlement failed, deposit is pending:', settleResult.error);
        }
      } else {
        console.log(`[TEE Staging] Batch not ready. Pending: ${pendingCount}/${BATCH_CONFIG.MIN_DEPOSITS}, Wait: ${Math.floor(waitTime/1000)}s/${BATCH_CONFIG.MAX_WAIT_SECONDS}s`);
      }

      // For immediate usability on devnet, also shield directly to Light Protocol
      console.log('[TEE Staging] Shielding directly to Light Protocol for immediate availability...');
      const lightResult = await shieldSolWithWallet(
        this.connection,
        user,
        amount,
        signTransaction
      );

      if (lightResult.success) {
        if (depositResult.pendingDeposit) {
          depositResult.pendingDeposit.status = 'settled';
        }
        return {
          ...depositResult,
          lightProtocolTxId: lightResult.signature,
        };
      }

      return depositResult;
    } catch (error) {
      console.error('[TEE Staging] Full TEE deposit failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ============================================
  // Status & Monitoring
  // ============================================

  getPendingDeposits(): PendingDeposit[] {
    return Array.from(this.pendingDeposits.values());
  }

  getPendingCount(): number {
    return Array.from(this.pendingDeposits.values())
      .filter(d => d.status === 'pending').length;
  }

  getEstimatedSettlementTime(): number {
    const pendingCount = this.getPendingCount();
    if (pendingCount >= BATCH_CONFIG.MIN_DEPOSITS) {
      return 0; // Ready now
    }

    const oldestPending = Array.from(this.pendingDeposits.values())
      .filter(d => d.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (!oldestPending) {
      return BATCH_CONFIG.MAX_WAIT_SECONDS * 1000;
    }

    const elapsed = Date.now() - oldestPending.createdAt;
    const remaining = Math.max(0, BATCH_CONFIG.MAX_WAIT_SECONDS * 1000 - elapsed);
    return remaining;
  }

  startSettlementMonitor(
    authority: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    onSettlement?: (result: BatchSettlementResult) => void
  ): void {
    if (this.settlementCheckInterval) {
      clearInterval(this.settlementCheckInterval);
    }

    this.settlementCheckInterval = setInterval(async () => {
      const pendingCount = this.getPendingCount();
      const estimatedTime = this.getEstimatedSettlementTime();

      if (pendingCount > 0 && estimatedTime === 0) {
        console.log('[TEE Staging] Auto-settling batch...');
        const result = await this.settleBatch(authority, signTransaction);
        onSettlement?.(result);
      }
    }, BATCH_CONFIG.CHECK_INTERVAL);

    console.log('[TEE Staging] Settlement monitor started');
  }

  stopSettlementMonitor(): void {
    if (this.settlementCheckInterval) {
      clearInterval(this.settlementCheckInterval);
      this.settlementCheckInterval = null;
      console.log('[TEE Staging] Settlement monitor stopped');
    }
  }
}

// ============================================
// Singleton Export
// ============================================

let teeStagingClient: TeeStagingClient | null = null;

export function getTeeStagingClient(rpcUrl?: string): TeeStagingClient {
  if (!teeStagingClient) {
    teeStagingClient = new TeeStagingClient(rpcUrl);
  }
  return teeStagingClient;
}

export function createTeeStagingClient(rpcUrl?: string): TeeStagingClient {
  return new TeeStagingClient(rpcUrl);
}
