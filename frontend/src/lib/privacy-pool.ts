/**
 * Privacy Pool - On-Chain Mixing Layer
 *
 * Provides true privacy by integrating with the StealthSol on-chain program:
 * 1. Fixed denominations - hides individual amounts
 * 2. On-chain Merkle tree - commitments stored on Solana
 * 3. ZK proofs - proves deposit without revealing which one
 * 4. Stealth addresses - unlinkable withdrawal destinations
 * 5. Nullifiers - prevents double-spending
 *
 * How it works:
 * - User deposits fixed denomination to on-chain pool
 * - Commitment = Poseidon(nullifier, secret) is stored in Merkle tree
 * - User can withdraw with ZK proof + stealth address
 * - Nullifier prevents double-spending
 */

import { PublicKey, Connection, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  getPoolState,
  getPoolConfig,
  isPoolInitialized,
  initializePool,
  privateDeposit,
  isNullifierUsed as isNullifierUsedOnChain,
  DENOMINATION_0_1_SOL,
  DENOMINATION_1_SOL,
  DENOMINATION_10_SOL,
  DENOMINATION_100_SOL,
  type PoolState,
  type Denomination,
} from './program';

// ============================================
// Constants
// ============================================

// Fixed denominations for privacy (in lamports)
// Must match on-chain program denominations
export const POOL_DENOMINATIONS = {
  SMALL: DENOMINATION_0_1_SOL,   // 0.1 SOL
  MEDIUM: DENOMINATION_1_SOL,    // 1 SOL
  LARGE: DENOMINATION_10_SOL,    // 10 SOL
  XLARGE: DENOMINATION_100_SOL,  // 100 SOL
};

// Minimum wait time before withdrawal (in ms)
// Longer wait = more deposits mix = better privacy
export const MIN_WAIT_TIME = 5 * 60 * 1000; // 5 minutes
export const RECOMMENDED_WAIT_TIME = 30 * 60 * 1000; // 30 minutes

// ============================================
// Types
// ============================================

export interface DepositCommitment {
  commitment: string; // hex encoded
  nullifier: string;  // hex encoded (keep secret!)
  secret: string;     // hex encoded (keep secret!)
  denomination: bigint;
  timestamp: number;
  txSignature?: string;
  leafIndex?: number;
}

export interface PoolDeposit {
  commitment: string;
  denomination: bigint;
  timestamp: number;
  leafIndex: number;
}

export interface WithdrawalProof {
  nullifier: string;
  commitment: string;
  denomination: bigint;
}

export interface PrivacyMetrics {
  anonymitySet: number;      // How many deposits in the pool
  waitTime: number;          // How long user waited
  depositsInWindow: number;  // Deposits during wait window
  privacyScore: number;      // 0-100 score
}

// ============================================
// Cryptographic Functions
// ============================================

/**
 * Generate a random 32-byte secret
 */
export function generateSecret(): Uint8Array {
  return randomBytes(32);
}

/**
 * Compute commitment = hash(nullifier || secret)
 * This is what gets published on-chain
 */
export function computeCommitment(nullifier: Uint8Array, secret: Uint8Array): Uint8Array {
  const combined = new Uint8Array(64);
  combined.set(nullifier, 0);
  combined.set(secret, 32);
  return sha256(combined);
}

/**
 * Generate deposit secrets and commitment
 */
export function generateDepositCredentials(): {
  nullifier: Uint8Array;
  secret: Uint8Array;
  commitment: Uint8Array;
} {
  const nullifier = generateSecret();
  const secret = generateSecret();
  const commitment = computeCommitment(nullifier, secret);

  return { nullifier, secret, commitment };
}

/**
 * Verify a commitment matches the given nullifier and secret
 */
export function verifyCommitment(
  commitment: Uint8Array,
  nullifier: Uint8Array,
  secret: Uint8Array
): boolean {
  const computed = computeCommitment(nullifier, secret);
  return commitment.every((byte, i) => byte === computed[i]);
}

// ============================================
// Local Storage (For User's Private Credentials)
// Only nullifier + secret are stored locally
// Commitments are on-chain in the Merkle tree
// ============================================

const DEPOSITS_STORAGE_KEY = 'veil_my_deposits';

/**
 * Get user's own deposits (with secrets)
 * These credentials are needed to withdraw
 */
export function getMyDeposits(): DepositCommitment[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(DEPOSITS_STORAGE_KEY);
  return stored ? JSON.parse(stored, (key, value) => {
    if (key === 'denomination') return BigInt(value);
    return value;
  }) : [];
}

/**
 * Save user's deposit credentials
 * IMPORTANT: These must be backed up - loss means loss of funds!
 */
export function saveMyDeposit(deposit: DepositCommitment): void {
  if (typeof window === 'undefined') return;
  const deposits = getMyDeposits();
  deposits.push({
    ...deposit,
    denomination: deposit.denomination.toString() as unknown as bigint,
  });
  localStorage.setItem(DEPOSITS_STORAGE_KEY, JSON.stringify(deposits));
}

/**
 * Remove a deposit from local storage (after successful withdrawal)
 */
export function removeMyDeposit(nullifier: string): void {
  if (typeof window === 'undefined') return;
  const deposits = getMyDeposits();
  const filtered = deposits.filter(d => d.nullifier !== nullifier);
  localStorage.setItem(DEPOSITS_STORAGE_KEY, JSON.stringify(filtered));
}

// ============================================
// On-Chain Pool Operations
// ============================================

/**
 * Get on-chain pool state for a denomination
 */
export async function getOnChainPoolState(
  connection: Connection,
  denomination: bigint
): Promise<PoolState | null> {
  return getPoolState(connection, denomination);
}

/**
 * Check if pool is initialized for a denomination
 */
export async function checkPoolInitialized(
  connection: Connection,
  denomination: bigint
): Promise<boolean> {
  return isPoolInitialized(connection, denomination);
}

/**
 * Initialize a pool for a denomination (admin only)
 */
export async function initializePoolForDenomination(
  connection: Connection,
  authority: PublicKey,
  denomination: Denomination,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<{ success: boolean; signature?: string; error?: string }> {
  return initializePool(connection, authority, denomination, signTransaction);
}

/**
 * Deposit to on-chain privacy pool
 * Returns deposit credentials that must be saved for withdrawal
 */
export async function depositToOnChainPool(
  connection: Connection,
  depositor: PublicKey,
  denomination: bigint,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<{
  success: boolean;
  deposit?: DepositCommitment;
  txSignature?: string;
  error?: string;
}> {
  try {
    // Generate cryptographic credentials
    const credentials = generateDepositCredentials();
    const commitmentHex = bytesToHex(credentials.commitment);
    const nullifierHex = bytesToHex(credentials.nullifier);
    const secretHex = bytesToHex(credentials.secret);

    console.log(`[PrivacyPool] Depositing ${Number(denomination) / LAMPORTS_PER_SOL} SOL to on-chain pool...`);
    console.log(`[PrivacyPool] Commitment: ${commitmentHex.slice(0, 16)}...`);

    // Call on-chain deposit
    const result = await privateDeposit(
      connection,
      depositor,
      denomination,
      credentials.commitment,
      signTransaction
    );

    // Save credentials locally
    const deposit: DepositCommitment = {
      commitment: commitmentHex,
      nullifier: nullifierHex,
      secret: secretHex,
      denomination,
      timestamp: Date.now(),
      txSignature: result.signature,
      leafIndex: result.leafIndex,
    };
    saveMyDeposit(deposit);

    console.log(`[PrivacyPool] Deposit successful. Leaf index: ${result.leafIndex}`);
    console.log(`[PrivacyPool] IMPORTANT: Back up your nullifier and secret to withdraw!`);

    return {
      success: true,
      deposit,
      txSignature: result.signature,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[PrivacyPool] Deposit failed:', error);
    return { success: false, error };
  }
}

/**
 * Check if nullifier has been used on-chain
 */
export async function isNullifierUsed(
  connection: Connection,
  denomination: bigint,
  nullifierHash: Uint8Array
): Promise<boolean> {
  return isNullifierUsedOnChain(connection, denomination, nullifierHash);
}

// ============================================
// Privacy Metrics (Based on On-Chain State)
// ============================================

/**
 * Calculate privacy metrics based on on-chain pool state
 */
export async function calculatePrivacyMetrics(
  connection: Connection,
  depositTimestamp: number,
  denomination: bigint
): Promise<PrivacyMetrics> {
  const now = Date.now();
  const waitTime = now - depositTimestamp;

  // Get on-chain pool state
  const poolState = await getPoolState(connection, denomination);

  if (!poolState) {
    return {
      anonymitySet: 0,
      waitTime,
      depositsInWindow: 0,
      privacyScore: 0,
    };
  }

  // Anonymity set = number of deposits in the pool
  const anonymitySet = Number(poolState.depositCount);

  // Estimate deposits during wait window (rough approximation)
  // In production, you'd query historical data
  const depositsInWindow = Math.min(anonymitySet, Math.floor(waitTime / (60 * 1000))); // ~1 per minute estimate

  // Calculate privacy score (0-100)
  let privacyScore = 0;

  // Score based on anonymity set size (max 40 points)
  privacyScore += Math.min(40, anonymitySet * 4);

  // Score based on wait time (max 30 points)
  const waitHours = waitTime / (1000 * 60 * 60);
  privacyScore += Math.min(30, waitHours * 5);

  // Score based on deposits during wait (max 30 points)
  privacyScore += Math.min(30, depositsInWindow * 3);

  return {
    anonymitySet,
    waitTime,
    depositsInWindow,
    privacyScore: Math.min(100, Math.round(privacyScore)),
  };
}

/**
 * Get available deposits that can be withdrawn
 * Checks on-chain nullifier status
 */
export async function getWithdrawableDeposits(
  connection: Connection
): Promise<(DepositCommitment & { metrics: PrivacyMetrics })[]> {
  const myDeposits = getMyDeposits();
  const now = Date.now();
  const results: (DepositCommitment & { metrics: PrivacyMetrics })[] = [];

  for (const deposit of myDeposits) {
    // Check minimum wait time
    if ((now - deposit.timestamp) < MIN_WAIT_TIME) {
      continue;
    }

    // Check if nullifier used on-chain
    const nullifierBytes = hexToBytes(deposit.nullifier);
    const denomination = BigInt(deposit.denomination);
    const isUsed = await isNullifierUsed(connection, denomination, nullifierBytes);

    if (isUsed) {
      continue;
    }

    // Calculate privacy metrics
    const metrics = await calculatePrivacyMetrics(connection, deposit.timestamp, denomination);

    results.push({
      ...deposit,
      denomination,
      metrics,
    });
  }

  return results;
}

// ============================================
// Pool Statistics (On-Chain)
// ============================================

export interface PoolStats {
  denomination: bigint;
  totalDeposits: number;
  totalWithdrawals: number;
  totalValue: bigint;
  isActive: boolean;
  merkleRoot: string;
}

/**
 * Get on-chain pool statistics
 */
export async function getPoolStats(
  connection: Connection,
  denomination: bigint
): Promise<PoolStats | null> {
  const poolState = await getPoolState(connection, denomination);

  if (!poolState) {
    return null;
  }

  return {
    denomination: poolState.denomination,
    totalDeposits: Number(poolState.depositCount),
    totalWithdrawals: Number(poolState.withdrawalCount),
    totalValue: poolState.totalDeposited - poolState.totalWithdrawn,
    isActive: poolState.isActive,
    merkleRoot: bytesToHex(poolState.merkleRoot),
  };
}

/**
 * Get stats for all denomination pools
 */
export async function getAllPoolStats(connection: Connection): Promise<PoolStats[]> {
  const stats: PoolStats[] = [];

  for (const [name, denomination] of Object.entries(POOL_DENOMINATIONS)) {
    const poolStats = await getPoolStats(connection, denomination);
    if (poolStats) {
      stats.push(poolStats);
    }
  }

  return stats;
}

// ============================================
// Helper Functions
// ============================================

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Format wait time for display
 */
export function formatWaitTime(ms: number): string {
  const minutes = Math.floor(ms / (1000 * 60));
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

/**
 * Get privacy level description
 */
export function getPrivacyLevel(score: number): {
  level: 'low' | 'medium' | 'high' | 'maximum';
  description: string;
  color: string;
} {
  if (score >= 80) {
    return {
      level: 'maximum',
      description: 'Excellent privacy - withdrawal is highly anonymous',
      color: 'green',
    };
  } else if (score >= 60) {
    return {
      level: 'high',
      description: 'Good privacy - withdrawal is reasonably anonymous',
      color: 'blue',
    };
  } else if (score >= 40) {
    return {
      level: 'medium',
      description: 'Moderate privacy - consider waiting longer',
      color: 'yellow',
    };
  } else {
    return {
      level: 'low',
      description: 'Low privacy - wait for more deposits to mix',
      color: 'red',
    };
  }
}

/**
 * Format denomination for display
 */
export function formatDenomination(denomination: bigint): string {
  const sol = Number(denomination) / LAMPORTS_PER_SOL;
  return `${sol} SOL`;
}

/**
 * Get denomination key from value
 */
export function getDenominationKey(denomination: bigint): string {
  for (const [key, value] of Object.entries(POOL_DENOMINATIONS)) {
    if (value === denomination) {
      return key;
    }
  }
  return 'UNKNOWN';
}
