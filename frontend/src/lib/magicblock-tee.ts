/**
 * MagicBlock TEE Integration for Private Deposits
 *
 * This module provides integration with MagicBlock Private Ephemeral Rollups (PER)
 * for achieving ~95% privacy on deposits to the privacy pool.
 *
 * ## How it works:
 * 1. User creates permission for their account
 * 2. User delegates account to TEE ephemeral rollup
 * 3. Inside TEE: commitment is generated privately
 * 4. Batch settlement: commitments submitted to pool anonymously
 *
 * ## Privacy Benefits:
 * - Hardware-level isolation (Intel TDX)
 * - Even node operators can't see user → commitment mapping
 * - Deposits appear from batch relayer, not individual users
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { keccak_256 } from 'js-sha3';
import {
  TeeBatchClient,
  getTeeBatchClient,
  BATCH_THRESHOLD,
  BATCH_TIMEOUT_MS,
  type BatchStatus as OnChainBatchStatus,
} from './tee-batch-client';
// Dynamic import for real TEE integration (to avoid WASM issues at build time)
type FullPrivateDepositResult = {
  success: boolean;
  phase: string;
  txIds: string[];
  commitment?: Uint8Array;
  nullifier?: Uint8Array;
  secret?: Uint8Array;
  batchCount?: number;
  settled?: boolean;
  error?: string;
};

async function loadTeeModule() {
  try {
    return await import('./magicblock-per');
  } catch (err) {
    console.warn('[TEE] Failed to load MagicBlock PER module:', err);
    return null;
  }
}

// Re-export batch config for compatibility
export const BATCH_CONFIG = {
  MIN_DEPOSITS: BATCH_THRESHOLD,
  MAX_WAIT_SECONDS: BATCH_TIMEOUT_MS / 1000,
};

// PendingDeposit type for compatibility
export interface PendingDeposit {
  id: string;
  amount: bigint;
  commitment: Uint8Array;
  nullifier: Uint8Array;
  secret: Uint8Array;
  status: 'pending' | 'batched' | 'settled';
  createdAt: number;
}

// ============================================
// MagicBlock Program IDs (from official SDK)
// ============================================
export const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
export const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');

// MagicBlock Endpoints
export const MAGICBLOCK_DEVNET_URL = 'https://devnet.magicblock.app';
export const MAGICBLOCK_TEE_URL = 'https://tee.magicblock.app';
export const MAGICBLOCK_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');

// Light Protocol Pool (for batch deposits)
export const LIGHT_POOL_PROGRAM = new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq');

// Session duration
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// ============================================
// PDA Functions (from official SDK)
// ============================================

function delegationRecordPdaFromDelegatedAccount(delegatedAccount: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('delegation'), delegatedAccount.toBuffer()],
    DELEGATION_PROGRAM_ID
  );
  return pda;
}

function delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
  delegatedAccount: PublicKey,
  ownerProgram: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('buffer'), delegatedAccount.toBuffer(), ownerProgram.toBuffer()],
    DELEGATION_PROGRAM_ID
  );
  return pda;
}

function delegationMetadataPdaFromDelegatedAccount(delegatedAccount: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), delegatedAccount.toBuffer()],
    DELEGATION_PROGRAM_ID
  );
  return pda;
}

function permissionPdaFromAccount(account: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('permission'), account.toBuffer()],
    PERMISSION_PROGRAM_ID
  );
  return pda;
}

// ============================================
// Instruction Builders (from official SDK)
// ============================================

interface DelegateAccounts {
  payer: PublicKey;
  delegatedAccount: PublicKey;
  ownerProgram: PublicKey;
  validator?: PublicKey;
}

interface DelegateArgs {
  commitFrequencyMs?: number;
  seeds?: Uint8Array[];
}

function createDelegateInstruction(
  accounts: DelegateAccounts,
  args?: DelegateArgs
): TransactionInstruction {
  const delegateBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
    accounts.delegatedAccount,
    accounts.ownerProgram
  );
  const delegationRecord = delegationRecordPdaFromDelegatedAccount(accounts.delegatedAccount);
  const delegationMetadata = delegationMetadataPdaFromDelegatedAccount(accounts.delegatedAccount);

  const keys = [
    { pubkey: accounts.payer, isWritable: true, isSigner: true },
    { pubkey: accounts.delegatedAccount, isWritable: true, isSigner: true },
    { pubkey: accounts.ownerProgram, isWritable: false, isSigner: false },
    { pubkey: delegateBuffer, isWritable: true, isSigner: false },
    { pubkey: delegationRecord, isWritable: true, isSigner: false },
    { pubkey: delegationMetadata, isWritable: true, isSigner: false },
    { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
  ];

  const instructionData = serializeDelegateInstructionData({
    validator: accounts.validator,
    ...args,
  });

  return new TransactionInstruction({
    programId: DELEGATION_PROGRAM_ID,
    keys,
    data: instructionData,
  });
}

function serializeDelegateInstructionData(args: {
  validator?: PublicKey;
  commitFrequencyMs?: number;
  seeds?: Uint8Array[];
}): Buffer {
  const delegateInstructionDiscriminator = [0, 0, 0, 0, 0, 0, 0, 0];
  const commitFrequencyMs = args?.commitFrequencyMs ?? 0xffffffff;
  const seeds = args?.seeds ?? [];
  const validator = args?.validator;

  const buffer = Buffer.alloc(1024);
  let offset = 0;

  for (let i = 0; i < 8; i++) {
    buffer[offset++] = delegateInstructionDiscriminator[i];
  }

  buffer.writeUInt32LE(commitFrequencyMs, offset);
  offset += 4;

  buffer.writeUInt32LE(seeds.length, offset);
  offset += 4;

  for (const seed of seeds) {
    buffer.writeUInt32LE(seed.length, offset);
    offset += 4;
    buffer.set(seed, offset);
    offset += seed.length;
  }

  if (validator) {
    buffer[offset++] = 1;
    buffer.set(validator.toBuffer(), offset);
    offset += 32;
  } else {
    buffer[offset++] = 0;
  }

  return buffer.subarray(0, offset);
}

interface CreatePermissionAccounts {
  permissionedAccount: PublicKey;
  payer: PublicKey;
}

interface PermissionMember {
  pubkey: PublicKey;
  flags: number;
}

interface CreatePermissionArgs {
  members?: PermissionMember[];
}

function createCreatePermissionInstruction(
  accounts: CreatePermissionAccounts,
  args?: CreatePermissionArgs
): TransactionInstruction {
  const permission = permissionPdaFromAccount(accounts.permissionedAccount);

  const keys = [
    { pubkey: accounts.permissionedAccount, isWritable: false, isSigner: true },
    { pubkey: permission, isWritable: true, isSigner: false },
    { pubkey: accounts.payer, isWritable: true, isSigner: true },
    { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
  ];

  const instructionData = serializeCreatePermissionInstructionData(args);

  return new TransactionInstruction({
    programId: PERMISSION_PROGRAM_ID,
    keys,
    data: instructionData,
  });
}

function serializeCreatePermissionInstructionData(args?: CreatePermissionArgs): Buffer {
  const MAX_BUFFER_SIZE = 2048;
  const discriminator = [0, 0, 0, 0, 0, 0, 0, 0];
  const members = args?.members ?? [];

  const buffer = Buffer.alloc(MAX_BUFFER_SIZE);
  let offset = 0;

  for (let i = 0; i < 8; i++) {
    buffer[offset++] = discriminator[i];
  }

  buffer[offset++] = members.length > 0 ? 1 : 0;

  buffer.writeUInt32LE(members.length, offset);
  offset += 4;

  for (const member of members) {
    buffer[offset++] = member.flags;
    buffer.set(member.pubkey.toBuffer(), offset);
    offset += 32;
  }

  return buffer.subarray(0, offset);
}

// ============================================
// Types
// ============================================

interface AuthToken {
  token: string;
  expiresAt: number;
}

export interface TeeDepositResult {
  success: boolean;
  commitment?: Uint8Array;
  nullifier?: Uint8Array;
  secret?: Uint8Array;
  encryptedNote?: Uint8Array;
  txId?: string;
  batchId?: number;
  settled?: boolean;  // True if batch was settled (funds in Light Protocol)
  error?: string;
}

export interface BatchSettlementResult {
  success: boolean;
  batchId: number;
  commitmentCount: number;
  txId?: string;
  error?: string;
}

export interface TeeStatus {
  available: boolean;
  version?: string;
  validator?: string;
  delegationProgram?: string;
  permissionProgram?: string;
}

// ============================================
// MagicBlock TEE Client
// ============================================

export class MagicBlockTeeClient {
  private connection: Connection;
  private teeConnection: Connection | null = null;
  private authToken: AuthToken | null = null;

  constructor(private mainnetRpcUrl: string = 'https://api.devnet.solana.com') {
    this.connection = new Connection(mainnetRpcUrl, 'confirmed');
  }

  async authenticate(
    wallet: PublicKey,
    _signMessage?: (message: Uint8Array) => Promise<Uint8Array>
  ): Promise<boolean> {
    try {
      // MagicBlock TEE is a standard Solana RPC endpoint
      // Real authentication happens via the delegation program on-chain
      // No wallet signature needed - just establish the connection
      const timestamp = Date.now();

      this.authToken = {
        token: `tee-session-${wallet.toBase58()}-${timestamp}`,
        expiresAt: timestamp + SESSION_DURATION,
      };

      // TEE connection is the standard MagicBlock RPC endpoint
      this.teeConnection = new Connection(MAGICBLOCK_TEE_URL, 'confirmed');

      // Verify TEE endpoint is responsive
      try {
        const slot = await this.teeConnection.getSlot();
        console.log('[TEE] Connected to MagicBlock TEE at slot:', slot);
      } catch (e) {
        console.warn('[TEE] TEE endpoint check failed, using main connection:', e);
        // Fall back to main connection if TEE endpoint is unreachable
        this.teeConnection = this.connection;
      }

      console.log('[TEE] Session established for wallet:', wallet.toBase58().slice(0, 8) + '...');
      return true;
    } catch (error) {
      console.error('[TEE] Session setup failed:', error);
      return false;
    }
  }

  isAuthenticated(): boolean {
    return this.authToken !== null && this.authToken.expiresAt > Date.now();
  }

  getTeeConnection(): Connection | null {
    if (!this.isAuthenticated()) return null;
    return this.teeConnection;
  }

  async createAccountPermission(
    payer: PublicKey,
    account: Keypair,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    try {
      const permissionPda = permissionPdaFromAccount(account.publicKey);
      const existing = await this.connection.getAccountInfo(permissionPda);
      if (existing) {
        console.log('[TEE] Permission already exists');
        return 'already-exists';
      }

      const instruction = createCreatePermissionInstruction(
        { permissionedAccount: account.publicKey, payer },
        { members: [] }
      );

      const transaction = new Transaction().add(instruction);
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payer;
      transaction.partialSign(account);

      const signedTx = await signTransaction(transaction);
      const txId = await this.connection.sendRawTransaction(signedTx.serialize());
      await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

      console.log('[TEE] Permission created:', txId);
      return txId;
    } catch (error) {
      console.error('[TEE] Create permission failed:', error);
      throw error;
    }
  }

  async delegateToTee(
    payer: PublicKey,
    account: Keypair,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    try {
      const delegationRecord = delegationRecordPdaFromDelegatedAccount(account.publicKey);
      const existing = await this.connection.getAccountInfo(delegationRecord);
      if (existing) {
        console.log('[TEE] Account already delegated');
        return 'already-delegated';
      }

      const instruction = createDelegateInstruction(
        {
          payer,
          delegatedAccount: account.publicKey,
          ownerProgram: SystemProgram.programId,
          validator: MAGICBLOCK_VALIDATOR,
        },
        { commitFrequencyMs: 30000, seeds: [] }
      );

      const transaction = new Transaction().add(instruction);
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payer;
      transaction.partialSign(account);

      const signedTx = await signTransaction(transaction);
      const txId = await this.connection.sendRawTransaction(signedTx.serialize());
      await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight });

      console.log('[TEE] Account delegated to TEE:', txId);
      return txId;
    } catch (error) {
      console.error('[TEE] Delegation failed:', error);
      throw error;
    }
  }

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

    const preimage = new Uint8Array(72);
    preimage.set(nullifier, 0);
    preimage.set(secret, 32);
    preimage.set(amountBytes, 64);

    const commitmentHex = keccak_256(preimage);
    const commitment = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      commitment[i] = parseInt(commitmentHex.substr(i * 2, 2), 16);
    }

    const encryptedNote = new Uint8Array(72);
    encryptedNote.set(nullifier, 0);
    encryptedNote.set(secret, 32);
    encryptedNote.set(amountBytes, 64);

    return { commitment, nullifier, secret, encryptedNote };
  }

  async executePrivateDeposit(
    user: PublicKey,
    _userKeypair: Keypair,
    amountLamports: bigint,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>
  ): Promise<TeeDepositResult> {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated with TEE' };
    }

    const rpcUrl = this.connection.rpcEndpoint;

    // REAL TEE integration only (MagicBlock PER with Intel TDX) - NO FALLBACK
    if (!signMessage) {
      return { success: false, error: 'signMessage required for TEE deposit' };
    }

    console.log('[TEE] Attempting REAL MagicBlock PER integration (Intel TDX)...');
    console.log('[TEE] Fallback disabled - TEE required');

    // Dynamically load the TEE module
    const teeModule = await loadTeeModule();

    if (!teeModule) {
      return { success: false, error: 'TEE module failed to load' };
    }

    const teeVerified = await teeModule.verifyTeeIntegrity();

    if (!teeVerified) {
      return { success: false, error: 'TEE endpoint not available at https://tee.magicblock.app' };
    }

    console.log('[TEE] TEE integrity verified! Using hardware-secured deposit flow.');

    const realResult = await teeModule.executeFullPrivateDeposit(
      rpcUrl,
      user,
      amountLamports,
      signTransaction,
      signMessage
    );

    if (!realResult.success) {
      return { success: false, error: realResult.error || 'TEE deposit failed' };
    }

    const privacyScore = teeModule.calculatePrivacyScore({
      usedTee: true,
      teeVerified: true,
      batchSize: realResult.batchCount || 0,
      settled: realResult.settled || false,
    });

    console.log('[TEE] REAL TEE deposit successful!');
    console.log('[TEE] Privacy score:', privacyScore, '/ 100');

    // Update local tracking
    const depositId = realResult.commitment
      ? Buffer.from(realResult.commitment).toString('hex').slice(0, 16)
      : Date.now().toString();
    updateBatchTracking({
      id: depositId,
      amount: amountLamports,
      commitment: realResult.commitment || new Uint8Array(32),
      status: realResult.settled ? 'settled' : 'pending',
      createdAt: Date.now(),
      txId: realResult.txIds[0],
    });

    await recordGlobalDeposit();

    return {
      success: true,
      commitment: realResult.commitment,
      nullifier: realResult.nullifier,
      secret: realResult.secret,
      txId: realResult.txIds[0],
      batchId: realResult.batchCount,
      settled: realResult.settled,
    };
  }

  async fullTeeDeposit(
    user: PublicKey,
    userKeypair: Keypair,
    amountLamports: bigint,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
  ): Promise<TeeDepositResult> {
    try {
      if (!this.isAuthenticated()) {
        console.log('[TEE] Authenticating...');
        const authSuccess = await this.authenticate(user, signMessage);
        if (!authSuccess) {
          return { success: false, error: 'TEE authentication failed' };
        }
      }

      try {
        await this.createAccountPermission(user, userKeypair, signTransaction);
      } catch {
        console.log('[TEE] Permission setup skipped (may already exist)');
      }

      try {
        await this.delegateToTee(user, userKeypair, signTransaction);
      } catch {
        console.log('[TEE] Delegation skipped (may already be delegated)');
      }

      const result = await this.executePrivateDeposit(user, userKeypair, amountLamports, signTransaction, signMessage);

      if (result.success) {
        console.log('[TEE] Full deposit flow completed successfully');
      }

      return result;
    } catch (error) {
      console.error('[TEE] Full deposit flow failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async isDelegated(account: PublicKey): Promise<boolean> {
    try {
      const delegationRecord = delegationRecordPdaFromDelegatedAccount(account);
      const info = await this.connection.getAccountInfo(delegationRecord);
      return info !== null;
    } catch {
      return false;
    }
  }

  async hasPermission(account: PublicKey): Promise<boolean> {
    try {
      const permissionPda = permissionPdaFromAccount(account);
      const info = await this.connection.getAccountInfo(permissionPda);
      return info !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get the balance of the staging account (delegated account balance)
   * This represents funds waiting to be processed by the TEE
   */
  async getStagingBalance(user: PublicKey): Promise<bigint> {
    try {
      // The staging balance is the balance of the delegated account
      // In MagicBlock's model, this is tracked via the delegation buffer
      const delegateBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
        user,
        new PublicKey('StLth111111111111111111111111111111111111111') // Stealth program
      );

      const info = await this.connection.getAccountInfo(delegateBuffer);
      if (info) {
        return BigInt(info.lamports);
      }

      // Fallback: check user's direct balance in TEE connection
      if (this.teeConnection) {
        const balance = await this.teeConnection.getBalance(user);
        return BigInt(balance);
      }

      return BigInt(0);
    } catch {
      return BigInt(0);
    }
  }
}

export function createTeeClient(rpcUrl?: string): MagicBlockTeeClient {
  return new MagicBlockTeeClient(rpcUrl);
}

export async function isTeeAvailable(): Promise<boolean> {
  try {
    const response = await fetch(MAGICBLOCK_TEE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.result && data.result['magicblock-core'] !== undefined;
  } catch {
    return false;
  }
}

export async function getTeeStatus(): Promise<TeeStatus> {
  try {
    const response = await fetch(MAGICBLOCK_TEE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] }),
    });
    if (!response.ok) return { available: false };

    const data = await response.json();
    if (data.result && data.result['magicblock-core']) {
      return {
        available: true,
        version: data.result['magicblock-core'],
        validator: MAGICBLOCK_VALIDATOR.toBase58(),
        delegationProgram: DELEGATION_PROGRAM_ID.toBase58(),
        permissionProgram: PERMISSION_PROGRAM_ID.toBase58(),
      };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

// ============================================
// Batch Status Helpers
// ============================================

export interface BatchStatus {
  pendingCount: number;
  batchThreshold: number;
  estimatedSettleTime: number; // milliseconds
  isReady: boolean;
  justSettled: boolean;        // True for 5 seconds after batch settles
  settledBatches: number;      // Total batches settled
  pendingDeposits: PendingDeposit[];
}

// Cache for global batch count (fetched from API)
let globalBatchCache: {
  count: number;
  timestamp: number;
  estimatedSettleTime: number;
  justSettled: boolean;
  settledBatches: number;
} | null = null;
const BATCH_CACHE_TTL = 5000; // 5 seconds

export async function fetchGlobalBatchCount(rpcUrl?: string): Promise<number> {
  try {
    // Check cache first
    if (globalBatchCache && Date.now() - globalBatchCache.timestamp < BATCH_CACHE_TTL) {
      return globalBatchCache.count;
    }

    // Fetch from shared API endpoint (server-side state, shared across all browsers)
    const response = await fetch('/api/batch');
    if (!response.ok) {
      throw new Error('Failed to fetch batch status');
    }

    const data = await response.json();

    // If on-chain batch exists, use the higher count (on-chain may have more
    // if deposits came from outside the API, e.g. CLI)
    let count = data.pendingCount;
    let settledBatches = data.settledBatches ?? 0;

    if (rpcUrl) {
      try {
        const batchClient = getTeeBatchClient(rpcUrl);
        const onChainStatus = await batchClient.getBatchStatus();
        // Only use on-chain count if the batch account actually exists (count > 0)
        if (onChainStatus.pendingCount > 0) {
          count = Math.max(count, onChainStatus.pendingCount);
          settledBatches = Math.max(settledBatches, Number(onChainStatus.batchId));
        }
      } catch {
        // On-chain fetch failed, API count is fine
      }
    }

    globalBatchCache = {
      count,
      timestamp: Date.now(),
      estimatedSettleTime: data.estimatedSettleTime,
      justSettled: data.justSettled ?? false,
      settledBatches,
    };

    console.log('[BatchStatus] count:', count, '/', BATCH_THRESHOLD, 'settled batches:', settledBatches);
    return count;
  } catch (error) {
    console.error('[BatchStatus] Failed to fetch global batch count:', error);
    return globalBatchCache?.count ?? 0;
  }
}

// Record a deposit to the global batch tracker (privacy-preserving)
// NOTE: No deposit ID or amount is sent - just increments anonymous counter
export async function recordGlobalDeposit(): Promise<void> {
  try {
    const response = await fetch('/api/batch', {
      method: 'POST',
      // No body - just increment the anonymous counter
    });

    if (response.ok) {
      const data = await response.json();
      console.log('[BatchStatus] Batch counter incremented, count:', data.pendingCount, 'justSettled:', data.justSettled);
      // Update cache immediately
      globalBatchCache = {
        count: data.pendingCount,
        timestamp: Date.now(),
        estimatedSettleTime: 0,
        justSettled: data.justSettled ?? false,
        settledBatches: data.batchNumber ?? 0,
      };
    }
  } catch (error) {
    console.error('[BatchStatus] Failed to record deposit:', error);
  }
}

export function getBatchStatus(_rpcUrl?: string): BatchStatus {
  const now = Date.now();
  const batchWindowMs = BATCH_CONFIG.MAX_WAIT_SECONDS * 1000;
  const threshold = BATCH_CONFIG.MIN_DEPOSITS;

  // On-chain count is the source of truth (synced via fetchGlobalBatchCount on page load)
  const onChainCount = globalBatchCache?.count ?? 0;
  const justSettled = globalBatchCache?.justSettled ?? false;
  const settledBatches = globalBatchCache?.settledBatches ?? 0;

  // Also check local tracking for user's own deposits (fallback if on-chain not yet fetched)
  const trackedDeposits = loadTrackedDeposits();
  const recentDeposits = trackedDeposits.filter(d =>
    d.createdAt > now - batchWindowMs
  );
  const pendingLocalCount = recentDeposits.filter(d => d.status === 'pending' || d.status === 'batched').length;

  // Use on-chain count when available, fall back to local
  const pendingCount = onChainCount > 0 ? onChainCount : pendingLocalCount;

  console.log('[BatchStatus] On-chain:', onChainCount, 'Local:', pendingLocalCount, 'Settled:', justSettled);

  // Calculate time to next batch settlement (use API value if available)
  const estimatedSettleTime = globalBatchCache?.estimatedSettleTime ?? batchWindowMs;
  const isReady = justSettled || pendingCount >= threshold;

  // Convert to PendingDeposit format for compatibility
  const pendingDeposits: PendingDeposit[] = recentDeposits.map(d => ({
    id: d.id,
    amount: d.amount,
    commitment: d.commitment,
    nullifier: new Uint8Array(32),
    secret: new Uint8Array(32),
    status: d.status,
    createdAt: d.createdAt,
  }));

  return {
    pendingCount,
    batchThreshold: threshold,
    estimatedSettleTime: isReady ? 0 : estimatedSettleTime,
    isReady,
    justSettled,
    settledBatches,
    pendingDeposits,
  };
}

export function formatBatchWaitTime(ms: number): string {
  if (ms <= 0) return 'Ready now';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `~${minutes}m`;
}

// ============================================
// Global Batch Tracking (persisted in localStorage)
// ============================================

interface TrackedDeposit {
  id: string;
  amount: bigint;
  commitment: Uint8Array;
  status: 'pending' | 'batched' | 'settled';
  createdAt: number;
  txId?: string;
}

const BATCH_STORAGE_KEY = 'nocturne_batch_deposits';

function loadTrackedDeposits(): TrackedDeposit[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(BATCH_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    // Convert amount back to bigint and commitment to Uint8Array
    return parsed.map((d: any) => ({
      ...d,
      amount: BigInt(d.amount),
      commitment: new Uint8Array(d.commitment),
    }));
  } catch {
    return [];
  }
}

function saveTrackedDeposits(deposits: TrackedDeposit[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Convert bigint and Uint8Array for JSON
    const serializable = deposits.map(d => ({
      ...d,
      amount: d.amount.toString(),
      commitment: Array.from(d.commitment),
    }));
    localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // Ignore storage errors
  }
}

export function updateBatchTracking(deposit: TrackedDeposit): void {
  console.log('[BatchTracking] Saving deposit:', deposit.id, deposit.status);
  const deposits = loadTrackedDeposits();

  // Add or update deposit
  const existingIndex = deposits.findIndex(d => d.id === deposit.id);
  if (existingIndex >= 0) {
    deposits[existingIndex] = deposit;
  } else {
    deposits.push(deposit);
  }

  // Keep only last 50 deposits
  const trimmed = deposits.slice(-50);
  saveTrackedDeposits(trimmed);
  console.log('[BatchTracking] Total deposits now:', trimmed.length);
}

export function getTrackedDeposits(): TrackedDeposit[] {
  return loadTrackedDeposits();
}

export function getRecentBatchStats(): {
  totalDeposits: number;
  settledDeposits: number;
  pendingDeposits: number;
  last24hDeposits: number;
} {
  const deposits = loadTrackedDeposits();
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  return {
    totalDeposits: deposits.length,
    settledDeposits: deposits.filter(d => d.status === 'settled').length,
    pendingDeposits: deposits.filter(d => d.status === 'pending').length,
    last24hDeposits: deposits.filter(d => d.createdAt > oneDayAgo).length,
  };
}
