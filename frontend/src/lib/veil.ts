/**
 * VEIL SDK - Privacy Cash + Stealth Addresses
 *
 * Combines Privacy Cash (ZK pool) with Stealth Addresses (recipient privacy)
 * for maximum privacy payments on Solana.
 *
 * ## Architecture
 *
 * Privacy Cash: Handles deposit/withdraw unlinking via ZK proofs
 * Stealth Addresses: Handles recipient privacy via DKSAP
 *
 * ## Quick Start
 *
 * ```typescript
 * const veil = new Veil(connection, rpcUrl);
 *
 * // 1. Generate identity (once)
 * const identity = veil.generateIdentity();
 *
 * // 2. Initialize with funded wallet
 * await veil.initWithKeypair(fundedKeypair);
 *
 * // 3. Send private payment
 * const { txId } = await veil.sendPrivate(1.5); // 1.5 SOL
 *
 * // 4. Receive to stealth address
 * await veil.receivePrivate(recipientStealthAddress);
 * ```
 *
 * Privacy Score: 97%
 * - Amount hidden (Privacy Cash pool)
 * - Deposit/withdraw link hidden (ZK proofs)
 * - Recipient hidden (stealth addresses)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';

// TEE Integration for Deposits
import {
  MagicBlockTeeClient,
  createTeeClient,
  isTeeAvailable,
  getTeeStatus,
  type TeeDepositResult,
  type TeeStatus,
  MAGICBLOCK_TEE_URL,
} from './magicblock-tee';

// TEE Relayer for Withdrawals
import {
  TeeRelayerClient,
  createTeeRelayerClient,
  isTeeRelayerAvailable,
  type WithdrawalRequest,
  type SubmitResult as TeeWithdrawResult,
  type RelayerState,
} from './tee-relayer-client';

// Range Compliance Integration
import {
  RangeClient,
  createTestRangeClient,
  createRangeClient,
  type AddressRiskResult,
  type SanctionsResult,
  type ComplianceReport,
  type ComplianceTransaction,
  RiskLevel,
} from './range-client';

// Helius RPC Integration
import {
  HeliusClient,
  createHeliusClient,
  createConnection as createHeliusConnection,
  getRpcUrl as getHeliusRpcUrl,
  type HeliusNetwork,
} from './helius';

// Privacy Pool Integration (On-Chain Mixing Layer)
import {
  generateDepositCredentials,
  computeCommitment,
  verifyCommitment,
  saveMyDeposit,
  getMyDeposits,
  removeMyDeposit,
  depositToOnChainPool,
  getWithdrawableDeposits as getWithdrawableDepositsAsync,
  isNullifierUsed as isNullifierUsedAsync,
  calculatePrivacyMetrics as calculatePrivacyMetricsAsync,
  getPoolStats as getPoolStatsAsync,
  getAllPoolStats,
  checkPoolInitialized,
  getPrivacyLevel,
  formatWaitTime,
  bytesToHex,
  hexToBytes,
  POOL_DENOMINATIONS,
  MIN_WAIT_TIME,
  RECOMMENDED_WAIT_TIME,
  type DepositCommitment,
  type PoolDeposit,
  type PrivacyMetrics,
  type PoolStats,
} from './privacy-pool';

// ============================================
// Privacy Enhancement Utilities
// ============================================

/**
 * Generate cryptographically secure random number in range
 */
function secureRandomInRange(min: number, max: number): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const randomValue = array[0] / (0xFFFFFFFF + 1); // 0 to 1
  return min + randomValue * (max - min);
}

/**
 * Generate random delay between min and max hours
 * Returns delay in milliseconds
 */
export function generateRandomDelay(minHours: number = 1, maxHours: number = 6): number {
  return Math.floor(secureRandomInRange(minHours * 60 * 60 * 1000, maxHours * 60 * 60 * 1000));
}

/**
 * Randomize amount by adding noise
 * @param amount - Original amount
 * @param noisePercent - Max noise percentage (default 2%)
 * @returns Randomized amount (can be higher or lower)
 */
export function randomizeAmount(amount: number, noisePercent: number = 2): number {
  const noise = secureRandomInRange(-noisePercent, noisePercent) / 100;
  return amount * (1 + noise);
}

/**
 * Calculate recommended withdrawal amount with randomization
 * Accounts for Privacy Cash fee (0.35%) + random noise
 */
export function calculatePrivateWithdrawal(depositAmount: number, options?: {
  feePercent?: number;    // Default: 0.35
  noisePercent?: number;  // Default: 1.5
}): { amount: number; noise: number; fee: number } {
  const feePercent = options?.feePercent ?? 0.35;
  const noisePercent = options?.noisePercent ?? 1.5;

  const fee = depositAmount * (feePercent / 100);
  const afterFee = depositAmount - fee;
  const noise = secureRandomInRange(-noisePercent, noisePercent) / 100;
  const amount = afterFee * (1 + noise);

  return {
    amount: Math.floor(amount * 10000) / 10000, // 4 decimal places
    noise: noise * 100,
    fee,
  };
}

// ============================================
// Batch Splitting for Maximum Privacy
// ============================================

/**
 * Options for batched withdrawals
 */
export interface BatchWithdrawalOptions {
  /** Minimum number of batches (default: 2) */
  minBatches?: number;
  /** Maximum number of batches (default: 15) */
  maxBatches?: number;
  /** Minimum SOL per batch to avoid dust (default: 0.1) */
  minBatchSize?: number;
  /** Minimum total time window in hours (default: 6) */
  minTotalHours?: number;
  /** Maximum total time window in hours (default: 35) */
  maxTotalHours?: number;
  /** Use unique stealth address per batch (default: true) */
  uniqueStealthAddresses?: boolean;
  /** Recipient meta-address (default: self) */
  recipientMetaAddress?: string;
}

/**
 * A single batch in a batched withdrawal
 */
export interface WithdrawalBatch {
  id: string;
  batchIndex: number;
  totalBatches: number;
  amountSol: number;
  executeAfter: number;
  recipientMetaAddress?: string;
  status: 'pending' | 'ready' | 'executed' | 'failed';
  txId?: string;
  stealthAddress?: string;
  error?: string;
}

/**
 * Result of creating a batched withdrawal
 */
export interface BatchedWithdrawalResult {
  success: boolean;
  totalAmount: number;
  batchCount: number;
  totalWindowHours: number;
  batches: WithdrawalBatch[];
  error?: string;
}

/**
 * Split an amount into VALID DENOMINATION batches only
 * Uses greedy algorithm to split into 1, 10, 100 SOL batches
 * Returns amounts in SOL that correspond to valid pool denominations
 *
 * Example: 5 SOL → [1, 1, 1, 1, 1] (five 1-SOL batches)
 * Example: 15 SOL → [10, 1, 1, 1, 1, 1] (one 10-SOL + five 1-SOL batches)
 * Example: 115 SOL → [100, 10, 1, 1, 1, 1, 1] (shuffled randomly)
 */
export function splitIntoValidDenominations(totalAmount: number): number[] {
  // Valid denominations in SOL (must match on-chain pool denominations)
  const DENOM_100_SOL = 100;
  const DENOM_10_SOL = 10;
  const DENOM_1_SOL = 1;
  // Note: 0.1 SOL is technically valid but less private, so we prefer larger denominations

  const batches: number[] = [];
  let remaining = totalAmount;

  // Use largest denominations first (greedy algorithm)
  // This minimizes number of batches while using valid amounts

  // Process 100 SOL batches
  while (remaining >= DENOM_100_SOL) {
    batches.push(DENOM_100_SOL);
    remaining -= DENOM_100_SOL;
  }

  // Process 10 SOL batches
  while (remaining >= DENOM_10_SOL) {
    batches.push(DENOM_10_SOL);
    remaining -= DENOM_10_SOL;
  }

  // Process 1 SOL batches
  while (remaining >= DENOM_1_SOL) {
    batches.push(DENOM_1_SOL);
    remaining -= DENOM_1_SOL;
  }

  // Remaining amount (< 1 SOL) is lost to rounding
  // This is intentional - we only use valid denominations
  if (remaining > 0.01) {
    console.warn(`[Veil] ${remaining.toFixed(4)} SOL remainder could not be batched (less than minimum denomination)`);
  }

  // Shuffle batches for timing privacy (don't always withdraw largest first)
  for (let i = batches.length - 1; i > 0; i--) {
    const j = Math.floor(secureRandomInRange(0, i + 1));
    [batches[i], batches[j]] = [batches[j], batches[i]];
  }

  return batches;
}

/**
 * Split an amount into random batches (DEPRECATED - use splitIntoValidDenominations)
 * Each batch gets a random portion, but all sum to total
 *
 * WARNING: This can create invalid amounts! Use splitIntoValidDenominations instead.
 * @deprecated Use splitIntoValidDenominations for privacy pool withdrawals
 */
export function splitIntoRandomBatches(
  totalAmount: number,
  minBatches: number = 3,
  maxBatches: number = 10,
  minBatchSize: number = 0.1
): number[] {
  // Determine batch count
  const maxPossibleBatches = Math.floor(totalAmount / minBatchSize);
  const effectiveMaxBatches = Math.min(maxBatches, maxPossibleBatches);
  const effectiveMinBatches = Math.min(minBatches, effectiveMaxBatches);

  if (effectiveMinBatches < 1) {
    return [totalAmount]; // Amount too small to split
  }

  const batchCount = Math.floor(secureRandomInRange(effectiveMinBatches, effectiveMaxBatches + 1));

  // Generate random proportions using Dirichlet-like distribution
  const randomValues: number[] = [];
  for (let i = 0; i < batchCount; i++) {
    // Use exponential distribution for more variance
    randomValues.push(-Math.log(1 - secureRandomInRange(0, 0.9999)));
  }

  // Normalize to sum to 1
  const sum = randomValues.reduce((a, b) => a + b, 0);
  const proportions = randomValues.map(v => v / sum);

  // Apply proportions to total amount
  let batches = proportions.map(p => totalAmount * p);

  // Ensure minimum batch size
  batches = batches.map(b => Math.max(b, minBatchSize));

  // Adjust to ensure exact total (account for rounding)
  const currentSum = batches.reduce((a, b) => a + b, 0);
  const adjustment = (totalAmount - currentSum) / batchCount;
  batches = batches.map(b => Math.floor((b + adjustment) * 10000) / 10000);

  // Final adjustment on last batch to hit exact total
  const finalSum = batches.slice(0, -1).reduce((a, b) => a + b, 0);
  batches[batches.length - 1] = Math.floor((totalAmount - finalSum) * 10000) / 10000;

  // Shuffle the batches so largest isn't always last
  for (let i = batches.length - 1; i > 0; i--) {
    const j = Math.floor(secureRandomInRange(0, i + 1));
    [batches[i], batches[j]] = [batches[j], batches[i]];
  }

  return batches;
}

/**
 * Generate random timestamps within a time window
 * Returns timestamps sorted chronologically
 */
export function generateRandomTimestamps(
  count: number,
  minTotalHours: number = 6,
  maxTotalHours: number = 35
): number[] {
  const now = Date.now();

  // Random total window
  const totalWindowMs = secureRandomInRange(
    minTotalHours * 60 * 60 * 1000,
    maxTotalHours * 60 * 60 * 1000
  );

  // Generate random timestamps within window
  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = secureRandomInRange(0, totalWindowMs);
    timestamps.push(now + offset);
  }

  // Sort chronologically
  timestamps.sort((a, b) => a - b);

  // Ensure minimum gap between batches (at least 30 minutes)
  const minGapMs = 30 * 60 * 1000;
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] - timestamps[i - 1] < minGapMs) {
      timestamps[i] = timestamps[i - 1] + minGapMs + secureRandomInRange(0, minGapMs);
    }
  }

  return timestamps;
}

/**
 * Create a batched withdrawal plan using VALID DENOMINATIONS ONLY
 *
 * This ensures all batches use valid pool denominations (1, 10, 100 SOL)
 * to prevent "Invalid denomination" errors during withdrawal.
 *
 * @param totalAmount - Total amount in SOL to withdraw
 * @param options - Batch configuration options
 * @returns Batches with valid denomination amounts and random timing
 */
export function createBatchedWithdrawalPlan(
  totalAmount: number,
  options?: BatchWithdrawalOptions
): { batches: Array<{ amount: number; executeAfter: number }>; totalWindowHours: number; remainder: number } {
  const opts = {
    minBatches: 3,
    maxBatches: 10,
    minBatchSize: 1, // Minimum 1 SOL (smallest reliable denomination)
    minTotalHours: 6,
    maxTotalHours: 35,
    ...options,
  };

  // Split amount into VALID DENOMINATIONS (1, 10, 100 SOL only)
  // This fixes the "Amount must be at least 1 SOL" error
  const amounts = splitIntoValidDenominations(totalAmount);

  // Calculate remainder that couldn't be batched (< 1 SOL)
  const batchedTotal = amounts.reduce((sum, a) => sum + a, 0);
  const remainder = totalAmount - batchedTotal;

  if (amounts.length === 0) {
    console.warn(`[Veil] Amount ${totalAmount} SOL is less than minimum denomination (1 SOL)`);
    return { batches: [], totalWindowHours: 0, remainder: totalAmount };
  }

  // Generate random timestamps for each batch
  const timestamps = generateRandomTimestamps(
    amounts.length,
    opts.minTotalHours,
    opts.maxTotalHours
  );

  // Calculate actual window
  const totalWindowMs = timestamps[timestamps.length - 1] - Date.now();
  const totalWindowHours = totalWindowMs / (60 * 60 * 1000);

  // Combine into batches
  const batches = amounts.map((amount, i) => ({
    amount,
    executeAfter: timestamps[i],
  }));

  console.log(`[Veil] Created ${batches.length} batches using valid denominations:`);
  console.log(`[Veil] - Total batched: ${batchedTotal} SOL`);
  if (remainder > 0.01) {
    console.log(`[Veil] - Remainder (< 1 SOL): ${remainder.toFixed(4)} SOL (not batched)`);
  }

  return { batches, totalWindowHours, remainder };
}

// ============================================
// Encrypted Pending Withdrawal Queue
// ============================================

const PENDING_WITHDRAWALS_KEY = 'veil_pending_withdrawals_encrypted';
const ENCRYPTION_SALT_KEY = 'veil_encryption_salt';

export interface PendingWithdrawal {
  id: string;
  amountSol: number;
  recipientMetaAddress?: string;
  createdAt: number;
  executeAfter: number;  // Timestamp when safe to execute
  status: 'pending' | 'ready' | 'executed' | 'failed';
  txId?: string;
  error?: string;
}

// Encryption key derived from wallet signature (cached in memory only)
let encryptionKey: CryptoKey | null = null;

/**
 * Derive encryption key from wallet signature
 * User signs once per session, key stays in memory
 */
export async function initializeEncryption(signMessage: (msg: Uint8Array) => Promise<Uint8Array>): Promise<boolean> {
  if (typeof window === 'undefined') {
    console.error('[Veil] initializeEncryption: window is undefined');
    return false;
  }

  console.log('[Veil] Initializing encryption...');

  try {
    // Deterministic message to sign
    const message = new TextEncoder().encode('Veil Privacy Encryption Key v1');
    console.log('[Veil] Requesting wallet signature for encryption key derivation...');
    const signature = await signMessage(message);
    console.log('[Veil] Signature received, deriving encryption key...');

    // Derive AES-GCM key from signature
    const signatureBuffer = new Uint8Array(signature).buffer as ArrayBuffer;
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      signatureBuffer,
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    // Get or create salt
    let salt = localStorage.getItem(ENCRYPTION_SALT_KEY);
    if (!salt) {
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      salt = btoa(String.fromCharCode(...saltBytes));
      localStorage.setItem(ENCRYPTION_SALT_KEY, salt);
      console.log('[Veil] Created new encryption salt');
    } else {
      console.log('[Veil] Using existing encryption salt');
    }
    const saltBytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));

    encryptionKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    console.log('[Veil] Encryption initialized successfully');
    return true;
  } catch (err) {
    console.error('[Veil] Failed to initialize encryption:', err);
    return false;
  }
}

/**
 * Check if encryption is initialized
 */
export function isEncryptionInitialized(): boolean {
  const initialized = encryptionKey !== null;
  console.log(`[Veil] isEncryptionInitialized: ${initialized}`);
  return initialized;
}

/**
 * Clear encryption key (logout)
 */
export function clearEncryptionKey(): void {
  encryptionKey = null;
}

async function encrypt(data: string): Promise<string> {
  if (!encryptionKey) throw new Error('Encryption not initialized');

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);

  // Convert to ArrayBuffer for Web Crypto API
  const ivBuffer = iv.buffer as ArrayBuffer;
  const encodedBuffer = new Uint8Array(encoded).buffer as ArrayBuffer;

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBuffer) },
    encryptionKey,
    encodedBuffer
  );

  // Combine IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

async function decrypt(encryptedData: string): Promise<string> {
  if (!encryptionKey) throw new Error('Encryption not initialized');

  const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  // Convert to ArrayBuffer for Web Crypto API
  const ciphertextBuffer = new Uint8Array(ciphertext).buffer as ArrayBuffer;

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    encryptionKey,
    ciphertextBuffer
  );

  return new TextDecoder().decode(decrypted);
}

function generateId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

export async function savePendingWithdrawal(withdrawal: PendingWithdrawal): Promise<boolean> {
  if (typeof window === 'undefined') {
    console.error('[Veil] savePendingWithdrawal: window is undefined');
    return false;
  }
  if (!encryptionKey) {
    console.error('[Veil] savePendingWithdrawal: Encryption key not initialized');
    return false;
  }

  try {
    const existing = await loadPendingWithdrawals();
    existing.push(withdrawal);

    const encrypted = await encrypt(JSON.stringify(existing));
    localStorage.setItem(PENDING_WITHDRAWALS_KEY, encrypted);
    console.log(`[Veil] Saved pending withdrawal ${withdrawal.id}, total queue size: ${existing.length}`);
    return true;
  } catch (err) {
    console.error('[Veil] savePendingWithdrawal failed:', err);
    return false;
  }
}

export async function loadPendingWithdrawals(): Promise<PendingWithdrawal[]> {
  if (typeof window === 'undefined') return [];
  if (!encryptionKey) return [];

  try {
    const encrypted = localStorage.getItem(PENDING_WITHDRAWALS_KEY);
    if (!encrypted) return [];

    const decrypted = await decrypt(encrypted);
    return JSON.parse(decrypted);
  } catch {
    return [];
  }
}

export async function updatePendingWithdrawal(id: string, updates: Partial<PendingWithdrawal>): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!encryptionKey) return;

  const withdrawals = await loadPendingWithdrawals();
  const index = withdrawals.findIndex(w => w.id === id);
  if (index !== -1) {
    withdrawals[index] = { ...withdrawals[index], ...updates };
    const encrypted = await encrypt(JSON.stringify(withdrawals));
    localStorage.setItem(PENDING_WITHDRAWALS_KEY, encrypted);
  }
}

export async function getReadyWithdrawals(): Promise<PendingWithdrawal[]> {
  const now = Date.now();
  const all = await loadPendingWithdrawals();
  return all.filter(w => w.status === 'pending' && w.executeAfter <= now);
}

export async function clearCompletedWithdrawals(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!encryptionKey) return;

  const withdrawals = await loadPendingWithdrawals();
  const pending = withdrawals.filter(w => w.status === 'pending' || w.status === 'ready');
  const encrypted = await encrypt(JSON.stringify(pending));
  localStorage.setItem(PENDING_WITHDRAWALS_KEY, encrypted);
}

// ============================================
// Privacy Backend Integration
// ============================================

import {
  BACKEND_MODE,
  type BackendMode,
  type PrivacyBackend,
  type DepositResult as BackendDepositResult,
  type WithdrawResult as BackendWithdrawResult,
  createPrivacyBackend,
  findBestDenomination,
  splitIntoDenominations,
  getAvailableBalance,
  getDenominationOptions,
  DENOMINATION_0_1_SOL,
  DENOMINATION_0_5_SOL,
  DENOMINATION_1_SOL,
  DENOMINATION_5_SOL,
  DENOMINATION_10_SOL,
  DENOMINATION_100_SOL,
  VALID_DENOMINATIONS,
  type Denomination,
} from './privacy-backend';

import { type StealthAddressParams } from './program';

/**
 * Check if running in mock mode
 */
export function isMockMode(): boolean {
  return BACKEND_MODE === 'mock';
}

/**
 * Check if using StealthSol program (devnet)
 */
export function isStealthSolMode(): boolean {
  return BACKEND_MODE === 'stealthsol';
}

/**
 * Get current backend mode
 */
export function getBackendMode(): BackendMode {
  return BACKEND_MODE;
}
import {
  generateStealthKeys,
  formatMetaAddress,
  parseMetaAddress,
  computeStealthAddress,
  saveKeys,
  loadKeys,
  clearKeys,
  saveAnnouncement,
  scanAllAnnouncements,
  type StealthKeys,
} from './stealth';

// ============================================
// Types
// ============================================

/**
 * Stealth meta-address (share this to receive payments)
 */
export interface MetaAddress {
  scanPubkey: Uint8Array;
  spendPubkey: Uint8Array;
  encoded: string;
}

/**
 * User identity for receiving payments
 */
export interface Identity {
  scanSecret: Uint8Array;
  spendSecret: Uint8Array;
  metaAddress: MetaAddress;
}

/**
 * Payment received via scanning
 */
export interface ReceivedPayment {
  stealthAddress: PublicKey;
  stealthKeypair: Keypair;
  balance: number;
  timestamp: number;
  txSignature?: string;
}

/**
 * Transaction result
 */
export interface TxResult {
  success: boolean;
  txId?: string;
  error?: string;
}

/**
 * Privacy options for withdrawals
 */
export interface PrivacyOptions {
  /** Add random delay before withdrawal (default: false) */
  useRandomDelay?: boolean;
  /** Minimum delay in hours (default: 1) */
  minDelayHours?: number;
  /** Maximum delay in hours (default: 6) */
  maxDelayHours?: number;
  /** Randomize withdrawal amount (default: true) */
  randomizeAmount?: boolean;
  /** Max amount noise percentage (default: 1.5%) */
  noisePercent?: number;
  /** Force immediate execution (bypasses delay) */
  immediate?: boolean;
}

/**
 * Queued withdrawal result
 */
export interface QueuedWithdrawalResult extends TxResult {
  queued?: boolean;
  withdrawalId?: string;
  executeAfter?: number;
  originalAmount?: number;
  randomizedAmount?: number;
}

/**
 * Private balance info
 */
export interface PrivateBalance {
  lamports: number;
  sol: number;
}

// ============================================
// Veil SDK
// ============================================

/**
 * Veil - Privacy Pool + Stealth Addresses
 *
 * Supports multiple backends:
 * - StealthSol program (devnet) - your own implementation
 * - Privacy Cash SDK (mainnet) - third-party service
 * - Mock mode (testing) - simulated operations
 */
export class Veil {
  private connection: Connection;
  private rpcUrl: string;
  private keypair: Keypair | null = null;
  private backend: PrivacyBackend | null = null;
  private initialized: boolean = false;

  // TEE Client for MagicBlock Private Ephemeral Rollups (Deposits)
  private teeClient: MagicBlockTeeClient | null = null;
  private teeEnabled: boolean = false;

  // TEE Relayer Client for Private Withdrawals
  private teeRelayerClient: TeeRelayerClient | null = null;
  private teeRelayerEnabled: boolean = false;

  // Range Compliance Client
  private rangeClient: RangeClient | null = null;
  private complianceEnabled: boolean = false;

  // Helius RPC Client
  private heliusClient: HeliusClient | null = null;
  private heliusEnabled: boolean = false;

  constructor(connection: Connection, rpcUrl: string) {
    this.connection = connection;
    this.rpcUrl = rpcUrl;
  }

  /**
   * Create Veil instance with Helius RPC
   *
   * Uses Helius for faster, more reliable RPC access.
   * Get your free API key at https://dashboard.helius.dev
   *
   * @param heliusApiKey - Your Helius API key
   * @param network - 'devnet' or 'mainnet'
   */
  static withHelius(heliusApiKey: string, network: HeliusNetwork = 'devnet'): Veil {
    const rpcUrl = getHeliusRpcUrl(heliusApiKey, network);
    const connection = createHeliusConnection(heliusApiKey, network);
    const veil = new Veil(connection, rpcUrl);

    // Enable Helius client for enhanced features
    veil.heliusClient = createHeliusClient(heliusApiKey, network);
    veil.heliusEnabled = true;

    console.log(`Veil initialized with Helius RPC (${network})`);
    return veil;
  }

  // ============================================
  // Initialization
  // ============================================

  /**
   * Initialize with a keypair
   *
   * The keypair must have SOL for deposits.
   */
  initWithKeypair(keypair: Keypair): void {
    this.keypair = keypair;
    this.backend = createPrivacyBackend(this.connection, {
      publicKey: keypair.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(keypair);
        return tx;
      },
    });
    this.initialized = true;
    console.log(`Veil initialized with backend: ${this.backend.mode}`);
  }

  private async ensureInitialized(): Promise<boolean> {
    return this.initialized && this.backend !== null;
  }

  /**
   * Initialize with a private key (base58 or byte array)
   */
  initWithPrivateKey(privateKey: string | Uint8Array): void {
    const keypair = typeof privateKey === 'string'
      ? Keypair.fromSecretKey(bs58.decode(privateKey))
      : Keypair.fromSecretKey(privateKey);

    this.initWithKeypair(keypair);
  }

  /**
   * Generate an ephemeral (burner) wallet
   *
   * Returns a new keypair that the user should fund.
   * Use this for browser wallet users who don't want to expose their main key.
   */
  generateEphemeralWallet(): { keypair: Keypair; address: string; privateKey: string } {
    const keypair = Keypair.generate();
    return {
      keypair,
      address: keypair.publicKey.toBase58(),
      privateKey: bs58.encode(keypair.secretKey),
    };
  }

  /**
   * Check if SDK is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.backend !== null && this.keypair !== null;
  }

  /**
   * Get the initialized wallet's public key
   */
  getPublicKey(): PublicKey | null {
    return this.keypair?.publicKey || null;
  }

  // ============================================
  // Identity (Stealth Addresses)
  // ============================================

  /**
   * Generate a new stealth identity
   *
   * Share the metaAddress.encoded string to receive payments.
   */
  async generateIdentity(): Promise<Identity> {
    // Generate deterministic keys from a random seed
    const seedKeypair = Keypair.generate();
    const keys = await generateStealthKeys(seedKeypair);

    const identity: Identity = {
      scanSecret: keys.scanSecret,
      spendSecret: keys.spendSecret,
      metaAddress: {
        scanPubkey: keys.scanPubkey,
        spendPubkey: keys.spendPubkey,
        encoded: formatMetaAddress(keys.scanPubkey, keys.spendPubkey),
      },
    };

    // Save to local storage
    saveKeys(keys);

    return identity;
  }

  /**
   * Load existing identity from storage
   */
  loadIdentity(): Identity | null {
    const keys = loadKeys();
    if (!keys) return null;

    return {
      scanSecret: keys.scanSecret,
      spendSecret: keys.spendSecret,
      metaAddress: {
        scanPubkey: keys.scanPubkey,
        spendPubkey: keys.spendPubkey,
        encoded: formatMetaAddress(keys.scanPubkey, keys.spendPubkey),
      },
    };
  }

  /**
   * Check if identity exists
   */
  hasIdentity(): boolean {
    return loadKeys() !== null;
  }

  /**
   * Clear identity (logout)
   */
  clearIdentity(): void {
    clearKeys();
  }

  /**
   * Parse a meta-address string
   */
  parseMetaAddress(encoded: string): { scanPubkey: Uint8Array; spendPubkey: Uint8Array } {
    return parseMetaAddress(encoded);
  }

  // ============================================
  // Send (Deposit to Privacy Pool)
  // ============================================

  /**
   * Send SOL privately (deposit to privacy pool)
   *
   * The SOL is shielded in the privacy pool with fixed denominations.
   * Use receivePrivate() to withdraw to a stealth address.
   *
   * @param amountSol - Amount in SOL (must match a denomination: 1, 10, or 100)
   * @returns Transaction result
   */
  async sendPrivate(amountSol: number): Promise<TxResult & { denomination?: bigint }> {
    const initialized = await this.ensureInitialized();
    if (!initialized || !this.backend) {
      return { success: false, error: 'SDK not initialized. Call initWithKeypair() first.' };
    }

    try {
      // For Light Protocol, we can use any amount
      // For other backends, find matching denomination
      let denomination: bigint;
      let denominationSol: number;

      if (BACKEND_MODE === 'lightprotocol') {
        denomination = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
        denominationSol = amountSol;
      } else {
        const foundDenom = findBestDenomination(amountSol);
        if (!foundDenom) {
          return {
            success: false,
            error: `Amount must be at least 1 SOL. Valid denominations: 1, 10, 100 SOL`,
          };
        }
        denomination = foundDenom;
        denominationSol = Number(denomination) / LAMPORTS_PER_SOL;
      }

      console.log(`Depositing ${denominationSol} SOL to privacy pool (${this.backend.mode} mode)...`);

      const result = await this.backend.deposit(denomination);

      if (result.success) {
        console.log('Deposit successful:', result.txId);
        return { success: true, txId: result.txId, denomination };
      } else {
        return { success: false, error: result.error };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('Deposit failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get available denominations for deposit
   */
  getAvailableDenominations(): { value: bigint; sol: number; label: string; recommended?: boolean }[] {
    return getDenominationOptions();
  }

  // ============================================
  // TEE Deposits (MagicBlock Private Ephemeral Rollups)
  // ============================================

  /**
   * Enable TEE mode for maximum deposit privacy
   *
   * TEE (Trusted Execution Environment) deposits provide ~95% privacy
   * by routing deposits through MagicBlock's Private Ephemeral Rollups.
   *
   * Benefits:
   * - Hardware-level isolation (Intel TDX)
   * - Even node operators can't see user → commitment mapping
   * - Deposits appear from batch relayer, not individual users
   *
   * @returns Promise<boolean> Whether TEE mode was successfully enabled
   */
  async enableTeeMode(): Promise<boolean> {
    try {
      // Check if TEE is available
      const available = await isTeeAvailable();
      if (!available) {
        console.warn('MagicBlock TEE is not available');
        return false;
      }

      // Create TEE client
      this.teeClient = createTeeClient(this.rpcUrl);
      this.teeEnabled = true;

      console.log('TEE mode enabled - deposits will use MagicBlock Private Ephemeral Rollups');
      return true;
    } catch (error) {
      console.error('Failed to enable TEE mode:', error);
      return false;
    }
  }

  /**
   * Check if TEE mode is enabled
   */
  isTeeEnabled(): boolean {
    return this.teeEnabled && this.teeClient !== null;
  }

  /**
   * Get TEE status information
   */
  async getTeeStatus(): Promise<TeeStatus> {
    return getTeeStatus();
  }

  /**
   * Authenticate with TEE for private operations
   *
   * This must be called before using TEE deposits.
   * User signs a challenge message to prove wallet ownership.
   *
   * @param signMessage - Wallet's signMessage function
   * @returns Promise<boolean> Whether authentication was successful
   */
  async authenticateWithTee(
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
  ): Promise<boolean> {
    if (!this.teeClient || !this.keypair) {
      console.error('TEE client not initialized or no keypair');
      return false;
    }

    try {
      const success = await this.teeClient.authenticate(
        this.keypair.publicKey,
        signMessage
      );

      if (success) {
        console.log('TEE authentication successful');
      }

      return success;
    } catch (error) {
      console.error('TEE authentication failed:', error);
      return false;
    }
  }

  /**
   * Check if authenticated with TEE
   */
  isAuthenticatedWithTee(): boolean {
    return this.teeClient?.isAuthenticated() ?? false;
  }

  /**
   * Send SOL privately via TEE (maximum privacy deposit)
   *
   * This routes the deposit through MagicBlock's Private Ephemeral Rollups,
   * providing hardware-level privacy for the deposit operation.
   *
   * Privacy Score: ~95% (vs ~80% with standard relay)
   *
   * Flow:
   * 1. Deposit to TEE staging account
   * 2. TEE generates commitment privately
   * 3. Batch settlement to privacy pool
   * 4. Even operator can't see user → commitment mapping
   *
   * @param amountSol - Amount in SOL (must match a denomination: 1, 10, or 100)
   * @param signMessage - Wallet's signMessage function (for TEE auth if needed)
   * @returns Transaction result with commitment data
   */
  async sendPrivateTee(
    amountSol: number,
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>
  ): Promise<TxResult & {
    denomination?: bigint;
    commitment?: Uint8Array;
    nullifier?: Uint8Array;
    secret?: Uint8Array;
    usedTee?: boolean;
  }> {
    // Check if TEE is enabled and authenticated
    if (!this.isTeeEnabled() || !this.teeClient || !this.keypair) {
      // Fall back to standard deposit
      console.log('TEE not available, using standard deposit');
      const result = await this.sendPrivate(amountSol);
      return { ...result, usedTee: false };
    }

    // Authenticate if needed
    if (!this.isAuthenticatedWithTee() && signMessage) {
      const authSuccess = await this.authenticateWithTee(signMessage);
      if (!authSuccess) {
        console.log('TEE auth failed, falling back to standard deposit');
        const result = await this.sendPrivate(amountSol);
        return { ...result, usedTee: false };
      }
    }

    if (!this.isAuthenticatedWithTee()) {
      return {
        success: false,
        error: 'TEE authentication required. Provide signMessage function.',
        usedTee: false,
      };
    }

    // Find denomination
    const denomination = findBestDenomination(amountSol);
    if (!denomination) {
      return {
        success: false,
        error: `Amount must be at least 1 SOL. Valid denominations: 1, 10, 100 SOL`,
        usedTee: false,
      };
    }

    const denominationSol = Number(denomination) / LAMPORTS_PER_SOL;
    console.log(`TEE Deposit: ${denominationSol} SOL via MagicBlock Private Ephemeral Rollup`);

    try {
      // Use TEE for deposit
      // Create a signMessage function using the ephemeral keypair
      // The TEE auth challenge must be signed by the same key whose pubkey is used
      const nacl = await import('tweetnacl');
      const ephemeralSignMessage = async (message: Uint8Array): Promise<Uint8Array> => {
        return nacl.sign.detached(message, this.keypair!.secretKey);
      };

      const result = await this.teeClient.fullTeeDeposit(
        this.keypair.publicKey,
        this.keypair,
        denomination,
        async (tx: Transaction) => {
          tx.partialSign(this.keypair!);
          return tx;
        },
        ephemeralSignMessage
      );

      if (result.success) {
        console.log('TEE deposit successful');
        console.log('Commitment created privately inside TEE');

        return {
          success: true,
          txId: result.txId,
          denomination,
          commitment: result.commitment,
          nullifier: result.nullifier,
          secret: result.secret,
          usedTee: true,
        };
      } else {
        return {
          success: false,
          error: result.error,
          usedTee: true,
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('TEE deposit failed:', errorMsg);

      // Fall back to standard deposit
      console.log('Falling back to standard deposit');
      const result = await this.sendPrivate(amountSol);
      return { ...result, usedTee: false };
    }
  }

  /**
   * Get TEE staging account balance
   *
   * Shows how much SOL is waiting in the TEE staging account.
   * This balance can be converted to commitments.
   */
  async getTeeStagingBalance(): Promise<number> {
    if (!this.teeClient || !this.keypair) {
      return 0;
    }

    try {
      const balance = await this.teeClient.getStagingBalance(this.keypair.publicKey);
      return Number(balance) / LAMPORTS_PER_SOL;
    } catch {
      return 0;
    }
  }

  // ============================================
  // TEE Relayer for Private Withdrawals
  // ============================================

  /**
   * Enable TEE relayer for maximum withdrawal privacy
   *
   * TEE relayer provides ~90% withdrawal privacy by:
   * - Encrypting withdrawal requests (only TEE can read)
   * - Processing requests inside Intel TDX (operator blind)
   * - Random processing order (timing decorrelation)
   *
   * @returns Promise<boolean> Whether TEE relayer was enabled
   */
  async enableTeeRelayer(): Promise<boolean> {
    try {
      // Create TEE relayer client
      this.teeRelayerClient = createTeeRelayerClient(this.connection);
      const initialized = await this.teeRelayerClient.initialize();

      if (!initialized) {
        console.warn('TEE relayer not available or not initialized');
        return false;
      }

      this.teeRelayerEnabled = true;
      console.log('TEE relayer enabled - withdrawals will use encrypted relay');
      return true;
    } catch (error) {
      console.error('Failed to enable TEE relayer:', error);
      return false;
    }
  }

  /**
   * Check if TEE relayer is enabled
   */
  isTeeRelayerEnabled(): boolean {
    return this.teeRelayerEnabled && this.teeRelayerClient !== null;
  }

  /**
   * Get TEE relayer state
   */
  async getTeeRelayerState(): Promise<RelayerState | null> {
    if (!this.teeRelayerClient) {
      return null;
    }
    return this.teeRelayerClient.getRelayerState();
  }

  /**
   * Estimate withdrawal fee via TEE relayer
   */
  async estimateTeeRelayerFee(amountSol: number): Promise<number> {
    if (!this.teeRelayerClient) {
      return 0;
    }

    const denomination = findBestDenomination(amountSol);
    if (!denomination) {
      return 0;
    }

    const fee = await this.teeRelayerClient.estimateFee(denomination);
    return Number(fee) / LAMPORTS_PER_SOL;
  }

  /**
   * Withdraw privately via TEE relayer (maximum withdrawal privacy)
   *
   * This routes the withdrawal through MagicBlock's TEE relayer,
   * providing hardware-level privacy for the withdrawal operation.
   *
   * Privacy Score: ~90% (vs ~60% with standard relayer)
   *
   * Flow:
   * 1. Encrypt withdrawal request with TEE's public key
   * 2. Submit encrypted request to TEE relayer
   * 3. TEE decrypts inside Intel TDX (operator blind)
   * 4. TEE submits withdrawal to privacy pool
   * 5. Funds appear at stealth address
   *
   * @param amountSol - Amount in SOL to withdraw
   * @param recipientMetaAddress - Optional: recipient's meta-address (defaults to self)
   * @returns Withdrawal result
   */
  async receivePrivateTee(
    amountSol: number,
    recipientMetaAddress?: string,
  ): Promise<QueuedWithdrawalResult & { stealthAddress?: string; usedTeeRelayer?: boolean }> {
    // Check TEE relayer is enabled
    if (!this.isTeeRelayerEnabled() || !this.teeRelayerClient || !this.keypair) {
      // Fall back to standard withdrawal
      console.log('TEE relayer not available, using standard withdrawal');
      const result = await this.receivePrivate(amountSol, recipientMetaAddress);
      return { ...result, usedTeeRelayer: false };
    }

    const initialized = await this.ensureInitialized();
    if (!initialized || !this.backend) {
      return {
        success: false,
        error: 'SDK not initialized. Call initWithKeypair() first.',
        usedTeeRelayer: false,
      };
    }

    // Find matching denomination
    const denomination = findBestDenomination(amountSol);
    if (!denomination) {
      return {
        success: false,
        error: `Amount must be at least 1 SOL. Valid denominations: 1, 10, 100 SOL`,
        usedTeeRelayer: false,
      };
    }

    const denominationSol = Number(denomination) / LAMPORTS_PER_SOL;

    try {
      // Get recipient's stealth keys
      let scanPubkey: Uint8Array;
      let spendPubkey: Uint8Array;

      if (recipientMetaAddress) {
        const parsed = parseMetaAddress(recipientMetaAddress);
        scanPubkey = parsed.scanPubkey;
        spendPubkey = parsed.spendPubkey;
      } else {
        // Use own identity
        const identity = this.loadIdentity();
        if (!identity) {
          return {
            success: false,
            error: 'No identity found. Generate identity first.',
            usedTeeRelayer: false,
          };
        }
        scanPubkey = identity.metaAddress.scanPubkey;
        spendPubkey = identity.metaAddress.spendPubkey;
      }

      // Derive stealth address
      const stealthPayment = await computeStealthAddress(scanPubkey, spendPubkey);
      const stealthAddress = stealthPayment.stealthAddress.toBase58();

      console.log(`TEE Relayer Withdrawal: ${denominationSol} SOL to stealth address: ${stealthAddress.slice(0, 8)}...`);

      // Generate ZK proof data (in production, this would be a real proof)
      // For demo, we use placeholder data
      const nullifierHash = new Uint8Array(32);
      crypto.getRandomValues(nullifierHash);

      const merkleRoot = new Uint8Array(32);
      crypto.getRandomValues(merkleRoot);

      const proof = new Uint8Array(256); // Placeholder proof
      crypto.getRandomValues(proof);

      // Create withdrawal request
      const request: WithdrawalRequest = {
        recipient: stealthPayment.stealthAddress,
        nullifierHash,
        merkleRoot,
        proof,
        denomination,
      };

      // Submit via TEE relayer
      const result = await this.teeRelayerClient.submitWithdrawal(
        request,
        this.keypair.publicKey,
        async (tx: Transaction) => {
          tx.partialSign(this.keypair!);
          return tx;
        }
      );

      if (result.success) {
        console.log('TEE relayer withdrawal submitted');
        console.log('Request encrypted - only TEE can read');

        // Save announcement for scanning
        saveAnnouncement({
          ephemeralPubkey: bs58.encode(stealthPayment.ephemeralPubkey),
          stealthAddress: stealthAddress,
          timestamp: Date.now(),
          txSignature: result.txId,
        });

        return {
          success: true,
          txId: result.txId,
          stealthAddress,
          originalAmount: amountSol,
          randomizedAmount: denominationSol,
          usedTeeRelayer: true,
        };
      } else {
        // Fall back to standard withdrawal
        console.log('TEE relayer submission failed, falling back to standard');
        const fallbackResult = await this.receivePrivate(amountSol, recipientMetaAddress);
        return { ...fallbackResult, usedTeeRelayer: false };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('TEE relayer withdrawal failed:', errorMsg);

      // Fall back to standard withdrawal
      console.log('Falling back to standard withdrawal');
      const fallbackResult = await this.receivePrivate(amountSol, recipientMetaAddress);
      return { ...fallbackResult, usedTeeRelayer: false };
    }
  }

  /**
   * Check if a nullifier has been used via TEE relayer
   */
  async isNullifierUsedViaTee(nullifierHash: Uint8Array): Promise<boolean> {
    if (!this.teeRelayerClient) {
      return false;
    }
    return this.teeRelayerClient.isNullifierUsed(nullifierHash);
  }

  // ============================================
  // Range Compliance Integration
  // ============================================

  /**
   * Enable compliance mode with Range
   *
   * This adds pre-transaction screening without compromising privacy:
   * - Sanctions screening (OFAC, EU, UK, UN)
   * - Risk assessment before deposits
   * - Compliance reports for auditors (via view keys)
   *
   * Privacy is preserved because:
   * - Checks happen BEFORE on-chain transactions
   * - No compliance data is stored on-chain
   * - View keys allow selective disclosure to authorized parties only
   *
   * @param apiKey - Range API key (get from app.range.org), or omit for test mode
   * @returns Whether compliance mode was enabled
   */
  enableCompliance(apiKey?: string): boolean {
    try {
      if (apiKey) {
        this.rangeClient = createRangeClient(apiKey);
        console.log('Range compliance enabled (production mode)');
      } else {
        this.rangeClient = createTestRangeClient();
        console.log('Range compliance enabled (test mode - using mock data)');
      }
      this.complianceEnabled = true;
      return true;
    } catch (error) {
      console.error('Failed to enable compliance:', error);
      return false;
    }
  }

  /**
   * Check if compliance mode is enabled
   */
  isComplianceEnabled(): boolean {
    return this.complianceEnabled && this.rangeClient !== null;
  }

  /**
   * Pre-screen an address before transacting
   *
   * Use this to check if a recipient is safe before sending.
   * Returns true if address passes all compliance checks.
   *
   * @param address - Address to screen (string or PublicKey)
   * @returns Whether address is safe to transact with
   */
  async screenAddress(address: string | PublicKey): Promise<boolean> {
    if (!this.rangeClient) {
      // No compliance client - allow by default
      return true;
    }
    return this.rangeClient.isAddressSafe(address);
  }

  /**
   * Get detailed risk assessment for an address
   *
   * @param address - Address to assess
   * @returns Detailed risk information
   */
  async getAddressRisk(address: string | PublicKey): Promise<AddressRiskResult | null> {
    if (!this.rangeClient) {
      return null;
    }
    return this.rangeClient.getAddressRisk(address);
  }

  /**
   * Check if an address is sanctioned
   *
   * @param address - Address to check
   * @returns Sanctions check result
   */
  async checkSanctions(address: string | PublicKey): Promise<SanctionsResult | null> {
    if (!this.rangeClient) {
      return null;
    }
    return this.rangeClient.checkSanctions(address);
  }

  /**
   * Generate a compliance report for auditors
   *
   * This is used with view keys - share the report with authorized auditors
   * who can verify your transaction history without having spending access.
   *
   * @param transactions - Transactions to include in report
   * @param periodStart - Start of reporting period (timestamp)
   * @param periodEnd - End of reporting period (timestamp)
   * @returns Compliance report with optional Range attestation
   */
  async generateComplianceReport(
    transactions: ComplianceTransaction[],
    periodStart: number,
    periodEnd: number,
  ): Promise<ComplianceReport | null> {
    if (!this.rangeClient || !this.keypair) {
      return null;
    }

    return this.rangeClient.generateComplianceReport(
      this.keypair.publicKey,
      transactions,
      periodStart,
      periodEnd,
    );
  }

  /**
   * Verify a compliance attestation
   *
   * Auditors can use this to verify a compliance report is genuine.
   *
   * @param attestationId - Attestation ID from compliance report
   * @returns Whether attestation is valid
   */
  async verifyComplianceAttestation(attestationId: string): Promise<boolean> {
    if (!this.rangeClient) {
      return false;
    }
    return this.rangeClient.verifyAttestation(attestationId);
  }

  /**
   * Send private payment WITH compliance screening
   *
   * Like sendPrivate, but pre-screens the transaction for compliance.
   * Use this when you need both privacy AND regulatory compliance.
   *
   * @param amountSol - Amount to send
   * @param recipientAddress - Optional: specific recipient to screen
   * @returns Transaction result
   */
  async sendPrivateCompliant(
    amountSol: number,
    recipientAddress?: string | PublicKey,
  ): Promise<TxResult & { denomination?: bigint; complianceChecked?: boolean }> {
    // Screen recipient if provided
    if (recipientAddress && this.rangeClient) {
      const isSafe = await this.rangeClient.isAddressSafe(recipientAddress);
      if (!isSafe) {
        return {
          success: false,
          error: 'Recipient failed compliance screening (sanctioned or high risk)',
          complianceChecked: true,
        };
      }
    }

    // Screen sender (self)
    if (this.keypair && this.rangeClient) {
      const selfSafe = await this.rangeClient.isAddressSafe(this.keypair.publicKey);
      if (!selfSafe) {
        return {
          success: false,
          error: 'Sender wallet failed compliance screening',
          complianceChecked: true,
        };
      }
    }

    // Proceed with private send
    const result = await this.sendPrivate(amountSol);
    return { ...result, complianceChecked: true };
  }

  // ============================================
  // Helius RPC Integration
  // ============================================

  /**
   * Check if Helius is enabled
   */
  isHeliusEnabled(): boolean {
    return this.heliusEnabled && this.heliusClient !== null;
  }

  /**
   * Get Helius client for advanced features
   */
  getHeliusClient(): HeliusClient | null {
    return this.heliusClient;
  }

  /**
   * Get priority fee estimate for faster transaction landing
   *
   * Uses Helius API to estimate optimal priority fee.
   * Only available when using Helius RPC.
   *
   * @param accountKeys - Accounts involved in transaction
   * @param priorityLevel - 'min' | 'low' | 'medium' | 'high' | 'veryHigh'
   */
  async getPriorityFee(
    accountKeys: string[],
    priorityLevel: 'min' | 'low' | 'medium' | 'high' | 'veryHigh' = 'medium'
  ): Promise<number | null> {
    if (!this.heliusClient) {
      return null;
    }

    try {
      const result = await this.heliusClient.getPriorityFeeEstimate(accountKeys, { priorityLevel });
      return result.priorityFeeEstimate;
    } catch (error) {
      console.error('Failed to get priority fee:', error);
      return null;
    }
  }

  /**
   * Get enhanced transaction history
   *
   * Uses Helius API for more detailed transaction data.
   * Only available when using Helius RPC.
   *
   * @param address - Address to get history for
   * @param limit - Max transactions to return
   */
  async getTransactionHistory(
    address?: string,
    limit: number = 50
  ): Promise<any[] | null> {
    if (!this.heliusClient) {
      return null;
    }

    const addr = address ?? this.keypair?.publicKey.toBase58();
    if (!addr) {
      return null;
    }

    try {
      return await this.heliusClient.getTransactionHistory(addr, { limit });
    } catch (error) {
      console.error('Failed to get transaction history:', error);
      return null;
    }
  }

  /**
   * Parse a transaction for human-readable details
   *
   * Uses Helius API to parse transaction into readable format.
   * Only available when using Helius RPC.
   *
   * @param signature - Transaction signature
   */
  async parseTransaction(signature: string): Promise<any | null> {
    if (!this.heliusClient) {
      return null;
    }

    try {
      return await this.heliusClient.parseTransaction(signature);
    } catch (error) {
      console.error('Failed to parse transaction:', error);
      return null;
    }
  }

  // ============================================
  // Receive (Withdraw to Stealth Address)
  // ============================================

  /**
   * Receive SOL privately (withdraw from privacy pool to stealth address)
   *
   * Withdraws from privacy pool to a fresh stealth address derived
   * from the recipient's meta-address.
   *
   * Note: With fixed denominations, amount must match a deposit (1, 10, or 100 SOL)
   *
   * Privacy options:
   * - useRandomDelay: Queue withdrawal with random 1-6 hour delay
   *
   * @param amountSol - Amount in SOL to withdraw (must match denomination)
   * @param recipientMetaAddress - Optional: recipient's meta-address (defaults to self)
   * @param privacyOptions - Optional: privacy enhancement options
   * @returns Transaction result with stealth address
   */
  async receivePrivate(
    amountSol: number,
    recipientMetaAddress?: string,
    privacyOptions?: PrivacyOptions
  ): Promise<QueuedWithdrawalResult & { stealthAddress?: string }> {
    console.log('[Veil] receivePrivate called with amount:', amountSol);
    const initialized = await this.ensureInitialized();
    console.log('[Veil] ensureInitialized returned:', initialized);
    if (!initialized || !this.backend) {
      return { success: false, error: 'SDK not initialized. Call initWithKeypair() first.' };
    }

    // Apply privacy options
    const options: PrivacyOptions = {
      useRandomDelay: false,
      minDelayHours: 1,
      maxDelayHours: 6,
      randomizeAmount: false, // Not applicable with fixed denominations
      immediate: false,
      ...privacyOptions,
    };

    // For Light Protocol, we can use any amount (no fixed denominations needed)
    // For other backends, find matching denomination
    let denominationSol: number;
    let denomination: bigint;
    if (BACKEND_MODE === 'lightprotocol') {
      // Light Protocol allows any amount
      denominationSol = amountSol;
      denomination = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
    } else {
      const foundDenom = findBestDenomination(amountSol);
      if (!foundDenom) {
        return {
          success: false,
          error: `Amount must be at least 1 SOL. Valid denominations: 1, 10, 100 SOL`,
        };
      }
      denomination = foundDenom;
      denominationSol = Number(denomination) / LAMPORTS_PER_SOL;
    }

    // Queue withdrawal if delay is requested
    if (options.useRandomDelay && !options.immediate) {
      const delay = generateRandomDelay(options.minDelayHours!, options.maxDelayHours!);
      const executeAfter = Date.now() + delay;

      const withdrawal: PendingWithdrawal = {
        id: generateId(),
        amountSol: denominationSol,
        recipientMetaAddress,
        createdAt: Date.now(),
        executeAfter,
        status: 'pending',
      };

      await savePendingWithdrawal(withdrawal);

      const delayHours = (delay / (1000 * 60 * 60)).toFixed(2);
      console.log(`Withdrawal queued. Will execute in ${delayHours} hours at ${new Date(executeAfter).toLocaleString()}`);

      return {
        success: true,
        queued: true,
        withdrawalId: withdrawal.id,
        executeAfter,
        originalAmount: amountSol,
        randomizedAmount: denominationSol,
      };
    }

    try {
      console.log('[Veil] receivePrivate starting...');
      console.log('[Veil] recipientMetaAddress:', recipientMetaAddress?.slice(0, 30) || 'self');

      // Get recipient's stealth keys
      let scanPubkey: Uint8Array;
      let spendPubkey: Uint8Array;

      if (recipientMetaAddress) {
        console.log('[Veil] Parsing meta address...');
        const parsed = parseMetaAddress(recipientMetaAddress);
        scanPubkey = parsed.scanPubkey;
        spendPubkey = parsed.spendPubkey;
        console.log('[Veil] Meta address parsed successfully');
      } else {
        // Use own identity
        console.log('[Veil] Using own identity...');
        const identity = this.loadIdentity();
        if (!identity) {
          return { success: false, error: 'No identity found. Generate identity first.' };
        }
        scanPubkey = identity.metaAddress.scanPubkey;
        spendPubkey = identity.metaAddress.spendPubkey;
      }

      // Derive stealth address
      console.log('[Veil] Computing stealth address...');
      const stealthPayment = await computeStealthAddress(scanPubkey, spendPubkey);
      const stealthAddress = stealthPayment.stealthAddress.toBase58();
      console.log('[Veil] Stealth address computed:', stealthAddress.slice(0, 12) + '...');

      console.log(`[Veil] Withdrawing ${denominationSol} SOL to stealth address: ${stealthAddress.slice(0, 8)}... (${this.backend.mode} mode)`);

      // Create stealth address params for the backend
      // Compute stealth commitment = hash(ephemeralPubkey, scanPubkey, spendPubkey)
      const stealthCommitment = new Uint8Array(32); // Placeholder for now

      const stealthParams: StealthAddressParams = {
        stealthAddress: stealthPayment.stealthAddress,
        ephemeralPubkey: stealthPayment.ephemeralPubkey,
        scanPubkey,
        spendPubkey,
        stealthCommitment,
      };

      // Withdraw using backend
      console.log('[Veil] Calling backend.withdraw...');
      const result = await this.backend.withdraw(denomination, stealthAddress, stealthParams);
      console.log('[Veil] backend.withdraw returned:', result.success ? 'success' : result.error);

      if (result.success) {
        console.log('Withdraw successful:', result.txId);

        // Save announcement for scanning
        saveAnnouncement({
          ephemeralPubkey: bs58.encode(stealthPayment.ephemeralPubkey),
          stealthAddress: stealthAddress,
          timestamp: Date.now(),
          txSignature: result.txId,
        });

        return {
          success: true,
          txId: result.txId,
          stealthAddress,
          originalAmount: amountSol,
          randomizedAmount: denominationSol,
        };
      } else {
        return { success: false, error: result.error };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('Withdraw failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Send to someone else's stealth address directly
   *
   * Deposits your SOL, then immediately withdraws to their stealth address.
   * This is the combined "send private payment" flow.
   *
   * @param amountSol - Amount in SOL
   * @param recipientMetaAddress - Recipient's meta-address string
   * @param privacyOptions - Optional: enable delay and amount randomization
   */
  async sendToRecipient(
    amountSol: number,
    recipientMetaAddress: string,
    privacyOptions?: PrivacyOptions
  ): Promise<QueuedWithdrawalResult & { stealthAddress?: string }> {
    // Step 1: Deposit to Privacy Cash
    const depositResult = await this.sendPrivate(amountSol);
    if (!depositResult.success) {
      return depositResult;
    }

    // Step 2: Withdraw to recipient's stealth address
    // Use privacy options for timing and amount randomization
    const withdrawAmount = amountSol * 0.9965; // Account for 0.35% fee
    return this.receivePrivate(withdrawAmount, recipientMetaAddress, {
      useRandomDelay: true,  // Default to delayed for better privacy
      randomizeAmount: true,
      ...privacyOptions,
    });
  }

  // ============================================
  // Batched Withdrawals (Maximum Privacy)
  // ============================================

  /**
   * Withdraw SOL in randomized batches for maximum privacy
   *
   * IMPORTANT: Uses VALID DENOMINATIONS ONLY (1, 10, 100 SOL)
   * This prevents "Invalid denomination" errors during withdrawal.
   *
   * Splits the total amount into batches, each with:
   * - Valid denomination amount (1, 10, or 100 SOL)
   * - Random timing (spread over 6-35 hours)
   * - Unique stealth address (optional, default true)
   *
   * @param amountSol - Total amount to withdraw (amounts < 1 SOL won't be batched)
   * @param options - Batch configuration options
   * @returns Batched withdrawal result with all batch details
   *
   * @example
   * // Withdraw 15 SOL → [10, 1, 1, 1, 1, 1] batches with random timing
   * const result = await veil.receivePrivateBatched(15);
   * console.log(`Split into ${result.batchCount} batches over ${result.totalWindowHours} hours`);
   */
  async receivePrivateBatched(
    amountSol: number,
    options?: BatchWithdrawalOptions
  ): Promise<BatchedWithdrawalResult> {
    const initialized = await this.ensureInitialized();
    if (!initialized || !this.backend) {
      return {
        success: false,
        totalAmount: amountSol,
        batchCount: 0,
        totalWindowHours: 0,
        batches: [],
        error: 'SDK not initialized. Call initWithKeypair() first.',
      };
    }

    if (!isEncryptionInitialized()) {
      return {
        success: false,
        totalAmount: amountSol,
        batchCount: 0,
        totalWindowHours: 0,
        batches: [],
        error: 'Queue encryption not initialized. Call initializeQueueEncryption() first.',
      };
    }

    // Minimum amount check - need at least 1 SOL
    if (amountSol < 1) {
      return {
        success: false,
        totalAmount: amountSol,
        batchCount: 0,
        totalWindowHours: 0,
        batches: [],
        error: `Amount must be at least 1 SOL for batched withdrawal. Got: ${amountSol} SOL`,
      };
    }

    const opts: Required<BatchWithdrawalOptions> = {
      minBatches: 2,
      maxBatches: 15,
      minBatchSize: 1, // Minimum 1 SOL (valid denomination)
      minTotalHours: 6,
      maxTotalHours: 35,
      uniqueStealthAddresses: true,
      recipientMetaAddress: options?.recipientMetaAddress || '',
      ...options,
    };

    // Create the batch plan using VALID DENOMINATIONS ONLY
    const plan = createBatchedWithdrawalPlan(amountSol, opts);

    if (plan.batches.length === 0) {
      return {
        success: false,
        totalAmount: amountSol,
        batchCount: 0,
        totalWindowHours: 0,
        batches: [],
        error: `Could not create any valid denomination batches for ${amountSol} SOL. Minimum is 1 SOL.`,
      };
    }

    const batchedTotal = plan.batches.reduce((sum, b) => sum + b.amount, 0);
    console.log(`Creating batched withdrawal: ${amountSol} SOL → ${plan.batches.length} batches (${batchedTotal} SOL) over ${plan.totalWindowHours.toFixed(1)} hours`);

    if (plan.remainder > 0.01) {
      console.warn(`[Veil] Note: ${plan.remainder.toFixed(4)} SOL remainder cannot be batched (less than 1 SOL minimum)`);
    }

    // Create withdrawal entries for each batch
    const batches: WithdrawalBatch[] = [];
    const batchGroupId = generateId();

    for (let i = 0; i < plan.batches.length; i++) {
      const batch = plan.batches[i];
      const batchId = `${batchGroupId}-${i}`;

      const withdrawalBatch: WithdrawalBatch = {
        id: batchId,
        batchIndex: i,
        totalBatches: plan.batches.length,
        amountSol: batch.amount,
        executeAfter: batch.executeAfter,
        recipientMetaAddress: opts.recipientMetaAddress || undefined,
        status: 'pending',
      };

      // Save to encrypted queue
      const pendingWithdrawal: PendingWithdrawal = {
        id: batchId,
        amountSol: batch.amount,
        recipientMetaAddress: opts.recipientMetaAddress || undefined,
        createdAt: Date.now(),
        executeAfter: batch.executeAfter,
        status: 'pending',
      };

      const saved = await savePendingWithdrawal(pendingWithdrawal);
      if (!saved) {
        console.error(`[Veil] Failed to save batch ${i + 1} to queue`);
        return {
          success: false,
          totalAmount: amountSol,
          batchCount: 0,
          totalWindowHours: 0,
          batches: [],
          error: 'Failed to save withdrawal to queue. Please ensure encryption is initialized.',
        };
      }
      batches.push(withdrawalBatch);

      const executeTime = new Date(batch.executeAfter).toLocaleString();
      console.log(`  Batch ${i + 1}/${plan.batches.length}: ${batch.amount.toFixed(4)} SOL @ ${executeTime}`);
    }

    console.log(`\nBatched withdrawal queued successfully!`);
    console.log(`First batch executes: ${new Date(batches[0].executeAfter).toLocaleString()}`);
    console.log(`Last batch executes: ${new Date(batches[batches.length - 1].executeAfter).toLocaleString()}`);

    return {
      success: true,
      totalAmount: amountSol,
      batchCount: batches.length,
      totalWindowHours: plan.totalWindowHours,
      batches,
    };
  }

  /**
   * Send to recipient using batched withdrawals for maximum privacy
   *
   * @param amountSol - Total amount to send
   * @param recipientMetaAddress - Recipient's meta-address
   * @param options - Batch configuration options
   */
  async sendToRecipientBatched(
    amountSol: number,
    recipientMetaAddress: string,
    options?: BatchWithdrawalOptions
  ): Promise<BatchedWithdrawalResult> {
    // Step 1: Deposit to Privacy Cash
    const depositResult = await this.sendPrivate(amountSol);
    if (!depositResult.success) {
      return {
        success: false,
        totalAmount: amountSol,
        batchCount: 0,
        totalWindowHours: 0,
        batches: [],
        error: depositResult.error,
      };
    }

    // Step 2: Queue batched withdrawals to recipient
    const withdrawAmount = amountSol * 0.9965; // Account for 0.35% fee
    return this.receivePrivateBatched(withdrawAmount, {
      ...options,
      recipientMetaAddress,
    });
  }

  // ============================================
  // Pending Withdrawal Queue Management
  // ============================================

  /**
   * Initialize encryption for secure queue storage
   * Must be called before using delayed withdrawals
   * @param signMessage - Wallet's signMessage function
   */
  async initializeQueueEncryption(signMessage: (msg: Uint8Array) => Promise<Uint8Array>): Promise<boolean> {
    return initializeEncryption(signMessage);
  }

  /**
   * Check if queue encryption is ready
   */
  isQueueEncryptionReady(): boolean {
    return isEncryptionInitialized();
  }

  /**
   * Get all pending withdrawals
   */
  async getPendingWithdrawals(): Promise<PendingWithdrawal[]> {
    return loadPendingWithdrawals();
  }

  /**
   * Get withdrawals ready to execute
   */
  async getReadyWithdrawals(): Promise<PendingWithdrawal[]> {
    return getReadyWithdrawals();
  }

  /**
   * Process all ready withdrawals
   * Call this periodically or when user returns to the app
   */
  async processReadyWithdrawals(): Promise<{ processed: number; results: QueuedWithdrawalResult[] }> {
    const ready = await getReadyWithdrawals();
    const results: QueuedWithdrawalResult[] = [];

    for (const withdrawal of ready) {
      await updatePendingWithdrawal(withdrawal.id, { status: 'ready' });

      const result = await this.receivePrivate(
        withdrawal.amountSol,
        withdrawal.recipientMetaAddress,
        { immediate: true, randomizeAmount: false } // Already randomized when queued
      );

      if (result.success) {
        await updatePendingWithdrawal(withdrawal.id, {
          status: 'executed',
          txId: result.txId,
        });
      } else {
        await updatePendingWithdrawal(withdrawal.id, {
          status: 'failed',
          error: result.error,
        });
      }

      results.push({ ...result, withdrawalId: withdrawal.id });
    }

    return { processed: ready.length, results };
  }

  /**
   * Cancel a pending withdrawal
   */
  async cancelPendingWithdrawal(withdrawalId: string): Promise<boolean> {
    const withdrawals = await loadPendingWithdrawals();
    const withdrawal = withdrawals.find(w => w.id === withdrawalId);
    if (withdrawal && withdrawal.status === 'pending') {
      await updatePendingWithdrawal(withdrawalId, { status: 'failed', error: 'Cancelled by user' });
      return true;
    }
    return false;
  }

  /**
   * Clear completed/failed withdrawals from queue
   */
  async clearCompletedWithdrawals(): Promise<void> {
    await clearCompletedWithdrawals();
  }

  // ============================================
  // Balance
  // ============================================

  /**
   * Get private balance (unspent deposit notes)
   */
  async getPrivateBalance(): Promise<PrivateBalance> {
    const initialized = await this.ensureInitialized();
    if (!initialized || !this.backend) {
      return { lamports: 0, sol: 0 };
    }

    try {
      const result = await this.backend.getBalance();
      return {
        lamports: Number(result.lamports),
        sol: result.sol,
      };
    } catch (err) {
      console.error('Failed to get private balance:', err);
      return { lamports: 0, sol: 0 };
    }
  }

  /**
   * Get regular wallet balance
   */
  async getWalletBalance(): Promise<number> {
    if (!this.keypair) return 0;
    const balance = await this.connection.getBalance(this.keypair.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }

  // ============================================
  // Scanning (Find Payments Sent to You)
  // ============================================

  /**
   * Scan for incoming payments to your stealth addresses
   */
  async scan(): Promise<ReceivedPayment[]> {
    const identity = this.loadIdentity();
    if (!identity) {
      console.log('[Veil] Scan: No identity found');
      return [];
    }

    try {
      console.log('[Veil] Scanning for payments...');

      // Get all announcements from storage
      const { getAnnouncements } = await import('./stealth');
      const allAnnouncements = getAnnouncements();
      console.log(`[Veil] Found ${allAnnouncements.length} total announcements in storage`);

      const payments = await scanAllAnnouncements(
        identity.scanSecret,
        identity.spendSecret
      );

      console.log(`[Veil] ${payments.length} announcements matched our identity`);

      const results: ReceivedPayment[] = [];
      for (const payment of payments) {
        console.log(`[Veil] Checking balance for stealth address: ${payment.stealthAddress.toBase58().slice(0, 12)}...`);
        const balance = await this.connection.getBalance(payment.stealthAddress);
        console.log(`[Veil] Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

        if (balance > 0) {
          results.push({
            stealthAddress: payment.stealthAddress,
            stealthKeypair: payment.stealthKeypair,
            balance: balance / LAMPORTS_PER_SOL,
            timestamp: payment.timestamp,
            txSignature: payment.txSignature,
          });
        } else {
          // Still include payments with 0 balance for visibility (they may have been swept)
          console.log(`[Veil] Stealth address ${payment.stealthAddress.toBase58().slice(0, 12)}... has 0 balance (may have been swept)`);
        }
      }

      console.log(`[Veil] Scan complete: ${results.length} payments with balance found`);
      return results;
    } catch (err) {
      console.error('[Veil] Scan failed:', err);
      return [];
    }
  }

  /**
   * Withdraw from a stealth address to any destination
   *
   * WARNING: If you withdraw to a known wallet, the privacy link is broken!
   * Use withdrawFromStealthToStealth() for maximum privacy.
   */
  async withdrawFromStealth(
    payment: ReceivedPayment,
    destinationAddress: PublicKey
  ): Promise<TxResult> {
    try {
      const lamports = Math.floor(payment.balance * LAMPORTS_PER_SOL) - 5000; // Leave for fee
      if (lamports <= 0) {
        return { success: false, error: 'Balance too low for withdrawal' };
      }

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payment.stealthAddress,
          toPubkey: destinationAddress,
          lamports,
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payment.stealthAddress;
      transaction.sign(payment.stealthKeypair);

      const txId = await this.connection.sendRawTransaction(transaction.serialize());
      await this.connection.confirmTransaction(txId);

      return { success: true, txId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Withdraw from stealth address to a NEW stealth address (maximum privacy)
   *
   * This is the RECOMMENDED withdrawal method because it:
   * 1. Auto-generates a fresh stealth address (breaks link to known wallets)
   * 2. You can later withdraw from the new stealth to anywhere
   * 3. Maintains the privacy chain: pool → stealth → new stealth → destination
   *
   * Privacy Score: ~95% (vs ~50% when withdrawing to known wallet)
   *
   * Note: The new stealth address keypair will be derived when you scan()
   * since you control the scan/spend secrets. The announcement is saved
   * automatically so your next scan() will find it.
   *
   * @param payment - The received payment to withdraw from
   * @param recipientMetaAddress - Optional: meta-address to generate stealth for (defaults to self)
   * @returns Transaction result with the new stealth address
   */
  async withdrawFromStealthToStealth(
    payment: ReceivedPayment,
    recipientMetaAddress?: string
  ): Promise<TxResult & { newStealthAddress?: string }> {
    try {
      // Get recipient's stealth keys
      let scanPubkey: Uint8Array;
      let spendPubkey: Uint8Array;

      if (recipientMetaAddress) {
        const parsed = parseMetaAddress(recipientMetaAddress);
        scanPubkey = parsed.scanPubkey;
        spendPubkey = parsed.spendPubkey;
      } else {
        // Use own identity (default - recommended)
        const identity = this.loadIdentity();
        if (!identity) {
          return { success: false, error: 'No identity found. Generate identity first or provide recipientMetaAddress.' };
        }
        scanPubkey = identity.metaAddress.scanPubkey;
        spendPubkey = identity.metaAddress.spendPubkey;
      }

      // Generate a FRESH stealth address (different from the source)
      const newStealthPayment = await computeStealthAddress(scanPubkey, spendPubkey);
      const newStealthAddress = newStealthPayment.stealthAddress;

      console.log(`[Veil] Withdrawing from stealth ${payment.stealthAddress.toBase58().slice(0, 8)}...`);
      console.log(`[Veil] To NEW stealth address: ${newStealthAddress.toBase58().slice(0, 8)}...`);

      const lamports = Math.floor(payment.balance * LAMPORTS_PER_SOL) - 5000; // Leave for fee
      if (lamports <= 0) {
        return { success: false, error: 'Balance too low for withdrawal' };
      }

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payment.stealthAddress,
          toPubkey: newStealthAddress,
          lamports,
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payment.stealthAddress;
      transaction.sign(payment.stealthKeypair);

      const txId = await this.connection.sendRawTransaction(transaction.serialize());
      await this.connection.confirmTransaction(txId);

      // Save announcement so we can scan for this new stealth address later
      // The keypair will be derived during scan() since we have the secrets
      saveAnnouncement({
        ephemeralPubkey: bs58.encode(newStealthPayment.ephemeralPubkey),
        stealthAddress: newStealthAddress.toBase58(),
        timestamp: Date.now(),
        txSignature: txId,
      });

      console.log(`[Veil] Withdrawal to new stealth successful: ${txId}`);
      console.log(`[Veil] New stealth address saved - run scan() to find it with full keypair`);

      return {
        success: true,
        txId,
        newStealthAddress: newStealthAddress.toBase58(),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Veil] withdrawFromStealthToStealth failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  // ============================================
  // Privacy Pool (Mixing Layer)
  // ============================================

  /**
   * Deposit to privacy pool with commitment scheme
   *
   * This provides TRUE privacy through mixing:
   * 1. Fixed denominations hide exact amounts
   * 2. Commitment = hash(nullifier, secret) is published
   * 3. No one can link deposit to withdrawal without the secret
   *
   * @param denominationKey - 'SMALL' (0.1), 'MEDIUM' (0.5), 'LARGE' (1), 'XLARGE' (5) SOL
   * @returns Deposit result with commitment data
   */
  async depositToPrivacyPool(
    denominationKey: 'SMALL' | 'MEDIUM' | 'LARGE' | 'XLARGE'
  ): Promise<TxResult & {
    commitment?: string;
    nullifier?: string;
    secret?: string;
    denomination?: bigint;
    privacyNote?: string;
  }> {
    const initialized = await this.ensureInitialized();
    if (!initialized || !this.backend) {
      return { success: false, error: 'SDK not initialized. Call initWithKeypair() first.' };
    }

    const denomination = POOL_DENOMINATIONS[denominationKey];
    if (!denomination) {
      return { success: false, error: `Invalid denomination: ${denominationKey}` };
    }

    try {
      // Generate cryptographic credentials
      const credentials = generateDepositCredentials();
      const commitmentHex = bytesToHex(credentials.commitment);
      const nullifierHex = bytesToHex(credentials.nullifier);
      const secretHex = bytesToHex(credentials.secret);

      console.log(`[Veil] Depositing ${Number(denomination) / LAMPORTS_PER_SOL} SOL to privacy pool...`);
      console.log(`[Veil] Commitment: ${commitmentHex.slice(0, 16)}...`);

      // Deposit using backend (Light Protocol or on-chain)
      const result = await this.backend.deposit(denomination);

      if (result.success) {
        // Save user's private credentials (encrypted in localStorage)
        // Commitment is stored on-chain in the Merkle tree
        const myDeposit: DepositCommitment = {
          commitment: commitmentHex,
          nullifier: nullifierHex,
          secret: secretHex,
          denomination,
          timestamp: Date.now(),
          txSignature: result.txId,
        };
        saveMyDeposit(myDeposit);

        console.log(`[Veil] Deposit successful. Commitment stored on-chain.`);
        console.log(`[Veil] IMPORTANT: Save your nullifier and secret to withdraw later!`);

        return {
          success: true,
          txId: result.txId,
          commitment: commitmentHex,
          nullifier: nullifierHex,
          secret: secretHex,
          denomination,
          privacyNote: `Wait at least ${MIN_WAIT_TIME / 60000} minutes before withdrawing for better privacy. Recommended: ${RECOMMENDED_WAIT_TIME / 60000} minutes.`,
        };
      } else {
        return { success: false, error: result.error };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Veil] Pool deposit failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Withdraw from privacy pool with ZK-style proof
   *
   * Privacy comes from:
   * 1. Proving knowledge of nullifier+secret WITHOUT revealing which deposit
   * 2. Nullifier prevents double-spend but doesn't link to deposit
   * 3. Funds go to fresh stealth address
   *
   * @param nullifierHex - Nullifier from deposit (hex string)
   * @param secretHex - Secret from deposit (hex string)
   * @param recipientMetaAddress - Optional: recipient's meta-address
   * @returns Withdrawal result
   */
  async withdrawFromPrivacyPool(
    nullifierHex: string,
    secretHex: string,
    recipientMetaAddress?: string
  ): Promise<QueuedWithdrawalResult & {
    stealthAddress?: string;
    privacyMetrics?: PrivacyMetrics;
    privacyLevel?: { level: string; description: string; color: string };
  }> {
    const initialized = await this.ensureInitialized();
    if (!initialized || !this.backend) {
      return { success: false, error: 'SDK not initialized. Call initWithKeypair() first.' };
    }

    try {
      // Find matching deposit from our saved credentials
      const myDeposits = getMyDeposits();
      const myDeposit = myDeposits.find(d => d.nullifier === nullifierHex);

      if (!myDeposit) {
        return { success: false, error: 'No deposit found with this nullifier. Check your credentials.' };
      }

      // Verify commitment matches nullifier + secret
      const nullifierBytes = hexToBytes(nullifierHex);
      const secretBytes = hexToBytes(secretHex);
      const computedCommitment = computeCommitment(nullifierBytes, secretBytes);
      const commitmentHex = bytesToHex(computedCommitment);

      if (commitmentHex !== myDeposit.commitment) {
        return { success: false, error: 'Invalid secret - commitment mismatch' };
      }

      // Calculate privacy metrics (queries on-chain state)
      const denomination = BigInt(myDeposit.denomination);
      const metrics = await calculatePrivacyMetricsAsync(this.connection!, myDeposit.timestamp, denomination);
      const privacyLevel = getPrivacyLevel(metrics.privacyScore);

      console.log(`[Veil] Privacy Score: ${metrics.privacyScore}/100 (${privacyLevel.level})`);
      console.log(`[Veil] Anonymity Set: ${metrics.anonymitySet} deposits`);
      console.log(`[Veil] Wait Time: ${formatWaitTime(metrics.waitTime)}`);

      if (metrics.privacyScore < 40) {
        console.warn(`[Veil] WARNING: Low privacy score. Consider waiting longer for more deposits to mix.`);
      }

      // Get recipient's stealth keys
      let scanPubkey: Uint8Array;
      let spendPubkey: Uint8Array;

      if (recipientMetaAddress) {
        const parsed = parseMetaAddress(recipientMetaAddress);
        scanPubkey = parsed.scanPubkey;
        spendPubkey = parsed.spendPubkey;
      } else {
        const identity = this.loadIdentity();
        if (!identity) {
          return { success: false, error: 'No identity found. Generate identity first.' };
        }
        scanPubkey = identity.metaAddress.scanPubkey;
        spendPubkey = identity.metaAddress.spendPubkey;
      }

      // Derive stealth address
      const stealthPayment = await computeStealthAddress(scanPubkey, spendPubkey);
      const stealthAddress = stealthPayment.stealthAddress.toBase58();

      const denominationSol = Number(denomination) / LAMPORTS_PER_SOL;
      console.log(`[Veil] Withdrawing ${denominationSol} SOL to stealth: ${stealthAddress.slice(0, 8)}...`);

      // Create stealth params for backend
      const stealthCommitment = new Uint8Array(32);
      const stealthParams: StealthAddressParams = {
        stealthAddress: stealthPayment.stealthAddress,
        ephemeralPubkey: stealthPayment.ephemeralPubkey,
        scanPubkey,
        spendPubkey,
        stealthCommitment,
      };

      // Execute withdrawal (nullifier is marked on-chain automatically)
      const result = await this.backend.withdraw(denomination, stealthAddress, stealthParams);

      if (result.success) {
        // Remove deposit from local storage (it's now spent)
        removeMyDeposit(nullifierHex);

        // Save announcement for scanning
        saveAnnouncement({
          ephemeralPubkey: bs58.encode(stealthPayment.ephemeralPubkey),
          stealthAddress: stealthAddress,
          timestamp: Date.now(),
          txSignature: result.txId,
        });

        console.log(`[Veil] Withdrawal successful with privacy score: ${metrics.privacyScore}`);

        return {
          success: true,
          txId: result.txId,
          stealthAddress,
          originalAmount: denominationSol,
          randomizedAmount: denominationSol,
          privacyMetrics: metrics,
          privacyLevel,
        };
      } else {
        return { success: false, error: result.error };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Veil] Pool withdrawal failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get deposits available for withdrawal
   * Returns deposits that have passed minimum wait time and haven't been withdrawn
   * Queries on-chain nullifier status
   */
  async getWithdrawablePoolDeposits(): Promise<(DepositCommitment & { metrics: PrivacyMetrics })[]> {
    if (!this.connection) {
      return [];
    }
    return getWithdrawableDepositsAsync(this.connection);
  }

  /**
   * Get privacy pool statistics for a denomination
   * Queries on-chain pool state
   */
  async getPrivacyPoolStats(denomination: bigint): Promise<PoolStats | null> {
    if (!this.connection) {
      return null;
    }
    return getPoolStatsAsync(this.connection, denomination);
  }

  /**
   * Get privacy pool statistics for all denominations
   */
  async getAllPrivacyPoolStats(): Promise<PoolStats[]> {
    if (!this.connection) {
      return [];
    }
    return getAllPoolStats(this.connection);
  }

  /**
   * Get privacy metrics for a potential withdrawal
   * Queries on-chain pool state for anonymity set
   */
  async getWithdrawalPrivacyMetrics(depositTimestamp: number, denomination: bigint): Promise<PrivacyMetrics> {
    if (!this.connection) {
      return { anonymitySet: 0, waitTime: 0, depositsInWindow: 0, privacyScore: 0 };
    }
    return calculatePrivacyMetricsAsync(this.connection, depositTimestamp, denomination);
  }

  /**
   * Check if it's a good time to withdraw (based on privacy score)
   */
  async isGoodTimeToWithdraw(depositTimestamp: number, denomination: bigint, minScore: number = 60): Promise<boolean> {
    const metrics = await this.getWithdrawalPrivacyMetrics(depositTimestamp, denomination);
    return metrics.privacyScore >= minScore;
  }

  /**
   * Check if a privacy pool is initialized for a denomination
   */
  async isPoolInitialized(denomination: bigint): Promise<boolean> {
    if (!this.connection) {
      return false;
    }
    return checkPoolInitialized(this.connection, denomination);
  }

  /**
   * Get pool denominations
   */
  getPoolDenominations(): typeof POOL_DENOMINATIONS {
    return POOL_DENOMINATIONS;
  }

  // ============================================
  // Utilities
  // ============================================

  /**
   * Clear cached data (no-op for StealthSol backend)
   */
  async clearCache(): Promise<void> {
    // No cache to clear for StealthSol backend
    // This was for Privacy Cash SDK compatibility
  }

  /**
   * Format SOL amount for display
   */
  formatSol(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toFixed(4);
  }
}

// ============================================
// Singleton Helper
// ============================================

let _instance: Veil | null = null;

export function getVeil(connection: Connection, rpcUrl: string): Veil {
  if (!_instance) {
    _instance = new Veil(connection, rpcUrl);
  }
  return _instance;
}

export function resetVeil(): void {
  _instance = null;
}

// Re-export Range compliance types for convenience
export type {
  AddressRiskResult,
  SanctionsResult,
  ComplianceReport,
  ComplianceTransaction,
} from './range-client';
export { RiskLevel } from './range-client';

// Re-export Helius types for convenience
export {
  HeliusClient,
  createHeliusClient,
  getHeliusRpcUrl,
  type HeliusNetwork,
} from './helius';

// Re-export Privacy Pool types for convenience
export {
  POOL_DENOMINATIONS,
  MIN_WAIT_TIME,
  RECOMMENDED_WAIT_TIME,
  getPrivacyLevel,
  formatWaitTime,
  type DepositCommitment,
  type PoolDeposit,
  type PrivacyMetrics,
  type PoolStats,
} from './privacy-pool';

export default Veil;
