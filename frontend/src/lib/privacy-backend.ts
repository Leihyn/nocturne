/**
 * Privacy Backend Abstraction
 *
 * Provides a unified interface for privacy operations that can use:
 * - Light Protocol (recommended) - ZK compression, no compute limit issues
 * - StealthSol program (devnet) - your own implementation
 * - Privacy Cash SDK (mainnet) - third-party service
 *
 * Withdrawals are routed through a relayer to prevent linking
 * the user's wallet to the withdrawal transaction.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  shieldSolWithWallet,
  unshieldSolWithWallet,
  getCompressedSolBalance,
  initLightRpc,
  hasHeliusApiKey,
} from './light-privacy';
import {
  PROGRAM_ID,
  VALID_DENOMINATIONS,
  DENOMINATION_0_1_SOL,
  DENOMINATION_0_5_SOL,
  DENOMINATION_1_SOL,
  DENOMINATION_5_SOL,
  DENOMINATION_10_SOL,
  DENOMINATION_100_SOL,
  privateDeposit,
  privateWithdraw,
  getPoolState,
  getFilledSubtrees,
  isNullifierUsed,
  getMerklePath,
  initializePool,
  isPoolInitialized,
  type StealthAddressParams,
  type Denomination,
} from './program';
import {
  computePoseidonHash,
  generateDepositSecrets,
  randomFieldElement,
  bigintToBytes32,
  initializeGroth16Prover,
  isGroth16ProverReady,
  generateWithdrawProof,
  type WithdrawInputs,
} from './groth16-prover';

// ============================================
// Relayer Configuration
// ============================================

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || 'http://localhost:3001';

interface RelayerInfo {
  address: string;
  balance: number;
  feePercent: number;
  minFeeSol: number;
  program: string;
}

interface RelayerWithdrawRequest {
  proof: number[];
  merkleRoot: number[];
  nullifierHash: number[];
  stealthAddress: string;
  ephemeralPubkey: number[];
  scanPubkey: number[];
  spendPubkey: number[];
  stealthCommitment: number[];
  denomination: string;
}

interface RelayerResponse {
  success: boolean;
  signature?: string;
  error?: string;
  fee?: number;
}

/**
 * Get relayer info (address, balance, fees)
 */
export async function getRelayerInfo(): Promise<RelayerInfo | null> {
  try {
    const response = await fetch(`${RELAYER_URL}/info`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error('Failed to reach relayer:', err);
    return null;
  }
}

/**
 * Submit withdrawal through relayer
 * The relayer pays gas and takes a fee from the withdrawal amount
 */
async function submitToRelayer(request: RelayerWithdrawRequest): Promise<RelayerResponse> {
  const response = await fetch(`${RELAYER_URL}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.text();
    return { success: false, error };
  }

  return await response.json();
}

// ============================================
// Configuration
// ============================================

export type BackendMode = 'stealthsol' | 'lightprotocol' | 'privacycash' | 'mock';

// Detect which backend to use
function detectBackendMode(): BackendMode {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || '';
  const forceMock = process.env.NEXT_PUBLIC_MOCK_PRIVACY_CASH === 'true';
  const forceLightProtocol = process.env.NEXT_PUBLIC_USE_LIGHT_PROTOCOL === 'true';
  const heliusApiKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY;

  if (forceMock) return 'mock';

  // Use Light Protocol if explicitly enabled or if Helius API key is available
  if (forceLightProtocol || heliusApiKey) {
    console.log('[Privacy] Using Light Protocol for ZK compression');
    return 'lightprotocol';
  }

  // Use StealthSol program on devnet (default for this project)
  if (rpcUrl.includes('devnet')) return 'stealthsol';

  // Use Privacy Cash on mainnet (if configured)
  if (rpcUrl.includes('mainnet') && process.env.NEXT_PUBLIC_PROGRAM_ID) {
    return 'privacycash';
  }

  // Default to StealthSol
  return 'stealthsol';
}

export const BACKEND_MODE = detectBackendMode();

console.log(`Privacy Backend Mode: ${BACKEND_MODE}`);

// ============================================
// Client-Side Merkle Tree
// ============================================

// Reduced to 8 to fit Solana compute budget (256 deposits per pool)
const MERKLE_DEPTH = 8;
const ZERO_VALUE = BigInt(0);

// Pre-computed zero hashes for empty subtrees
let zeroHashes: bigint[] | null = null;

async function getZeroHashes(): Promise<bigint[]> {
  if (zeroHashes) return zeroHashes;

  zeroHashes = [ZERO_VALUE];
  for (let i = 1; i <= MERKLE_DEPTH; i++) {
    const prevHash = zeroHashes[i - 1];
    zeroHashes.push(await computePoseidonHash([prevHash, prevHash]));
  }
  return zeroHashes;
}

/**
 * Compute merkle path elements from filled_subtrees at deposit time.
 *
 * When a leaf is inserted at index N, the filled_subtrees represents the
 * leftmost filled subtree at each level. The path sibling at level L is:
 * - zeros[L] if bit L of N is 0 (we're a left child, sibling doesn't exist yet)
 * - filled_subtrees[L] if bit L of N is 1 (we're a right child, sibling is filled)
 *
 * This is called immediately after deposit when our leaf is the rightmost,
 * so filled_subtrees gives us exactly the siblings we need.
 */
async function computeMerklePathFromSubtrees(leafIndex: number, filledSubtrees: Uint8Array[]): Promise<Uint8Array[]> {
  const pathElements: Uint8Array[] = [];
  let index = leafIndex;

  // Get Poseidon zero hashes for empty siblings
  const zeros = await getZeroHashes();

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const isRightChild = (index & 1) === 1;

    if (isRightChild) {
      // Right child: sibling is the filled subtree (left sibling exists)
      pathElements.push(filledSubtrees[level]);
    } else {
      // Left child: sibling is the Poseidon zero hash at this level
      // (right sibling doesn't exist yet, so it's the empty subtree hash)
      const zeroHashBytes = new Uint8Array(bigintToBytes32(zeros[level]));
      pathElements.push(zeroHashBytes);
    }

    index = Math.floor(index / 2);
  }

  return pathElements;
}

// Store all commitments by denomination for Merkle tree construction
const commitmentsByDenom: Map<string, bigint[]> = new Map();

function getCommitmentsKey(denomination: bigint): string {
  return `merkle_commitments_${denomination.toString()}`;
}

export function saveCommitment(denomination: bigint, commitment: Uint8Array, leafIndex: number): void {
  const key = getCommitmentsKey(denomination);
  const commitmentBigInt = BigInt('0x' + Buffer.from(commitment).toString('hex'));

  // Load existing
  let commitments = commitmentsByDenom.get(denomination.toString()) || [];

  // Also load from localStorage
  if (typeof window !== 'undefined') {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || '[]');
      commitments = stored.map((c: string) => BigInt(c));
    } catch {}
  }

  // Add at correct index
  while (commitments.length <= leafIndex) {
    commitments.push(ZERO_VALUE);
  }
  commitments[leafIndex] = commitmentBigInt;

  // Save to memory and localStorage
  commitmentsByDenom.set(denomination.toString(), commitments);
  if (typeof window !== 'undefined') {
    localStorage.setItem(key, JSON.stringify(commitments.map(c => c.toString())));
  }
}

export function loadCommitments(denomination: bigint): bigint[] {
  const key = getCommitmentsKey(denomination);

  // Try memory first
  const cached = commitmentsByDenom.get(denomination.toString());
  if (cached) return cached;

  // Load from localStorage
  if (typeof window !== 'undefined') {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || '[]');
      const loaded: bigint[] = stored.map((c: string) => BigInt(c));
      commitmentsByDenom.set(denomination.toString(), loaded);
      return loaded;
    } catch {}
  }

  return [];
}

/**
 * Build Merkle tree and compute root + path for a specific leaf
 *
 * OPTIMIZED: Only computes hashes along the path (20 hashes) instead of
 * rebuilding the entire tree (which would be 2^20 = 1M+ hashes).
 */
export async function computeMerkleProof(
  denomination: bigint,
  leafIndex: number
): Promise<{ root: bigint; pathElements: bigint[]; pathIndices: number[] }> {
  const commitments = loadCommitments(denomination);
  const zeros = await getZeroHashes();

  console.log(`[MerkleTree] Computing proof for leaf ${leafIndex}, total commitments: ${commitments.length}`);

  // For efficiency, we only compute hashes along the path from leaf to root
  // We need to track the "filled subtrees" for each level
  const filledSubtrees: bigint[] = new Array(MERKLE_DEPTH).fill(ZERO_VALUE);

  // Insert all commitments and track subtrees
  let currentRoot = zeros[MERKLE_DEPTH - 1];

  for (let i = 0; i < commitments.length; i++) {
    let currentHash = commitments[i];
    let currentIndex = i;

    for (let level = 0; level < MERKLE_DEPTH; level++) {
      if (currentIndex % 2 === 0) {
        // We're on the left, sibling is zero (or filled subtree if exists)
        filledSubtrees[level] = currentHash;
        currentHash = await computePoseidonHash([currentHash, zeros[level]]);
      } else {
        // We're on the right, sibling is filled subtree
        currentHash = await computePoseidonHash([filledSubtrees[level], currentHash]);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
    currentRoot = currentHash;
  }

  // Now compute the proof path for the specific leaf
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  // Re-insert leaves up to and including our target to get correct path
  // Reset subtrees
  const subtrees: bigint[] = new Array(MERKLE_DEPTH).fill(ZERO_VALUE);

  for (let i = 0; i <= leafIndex && i < commitments.length; i++) {
    let currentIndex = i;
    for (let level = 0; level < MERKLE_DEPTH; level++) {
      if (currentIndex % 2 === 0) {
        subtrees[level] = i < commitments.length ?
          (level === 0 ? commitments[i] : subtrees[level]) : zeros[level];
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
  }

  // Build the path
  let index = leafIndex;
  let currentHash = commitments[leafIndex];

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const isRight = index % 2 === 1;
    pathIndices.push(isRight ? 1 : 0);

    // Get sibling
    let sibling: bigint;
    if (isRight) {
      // Sibling is on the left - use filled subtree
      sibling = subtrees[level];
    } else {
      // Sibling is on the right - check if it exists
      const siblingLeafIndex = leafIndex + Math.pow(2, level);
      if (siblingLeafIndex < commitments.length) {
        // Need to compute sibling's hash at this level
        sibling = level === 0 ? commitments[siblingLeafIndex] : zeros[level];
      } else {
        sibling = zeros[level];
      }
    }
    pathElements.push(sibling);

    // Compute hash for next level
    if (isRight) {
      currentHash = await computePoseidonHash([sibling, currentHash]);
    } else {
      currentHash = await computePoseidonHash([currentHash, sibling]);
    }

    index = Math.floor(index / 2);
  }

  console.log(`[MerkleTree] Computed root: ${currentHash.toString(16).slice(0, 16)}...`);

  return { root: currentHash, pathElements, pathIndices };
}

// ============================================
// Deposit Note (stored locally, encrypted)
// ============================================

export interface DepositNote {
  nullifier: bigint;
  secret: bigint;
  commitment: Uint8Array;
  denomination: bigint;
  leafIndex: number;
  timestamp: number;
  txSignature?: string;
  // Merkle data captured at deposit time (required for withdrawal proof)
  merkleRoot?: Uint8Array;
  merklePath?: Uint8Array[];  // The 20 sibling hashes along the path
}

// In-memory store for deposit notes (should be encrypted in localStorage)
const depositNotes: Map<string, DepositNote> = new Map();

/**
 * Generate a new deposit note
 *
 * The circuit expects: commitment = Poseidon(nullifier, secret, amount, recipient)
 * Since stealth address isn't known at deposit time, we use recipient=0 as placeholder.
 * This binds the amount but allows flexible recipient at withdrawal.
 */
export async function generateDepositNote(denomination: bigint): Promise<{
  note: DepositNote;
  commitment: Uint8Array;
}> {
  const { nullifier, secret } = generateDepositSecrets();

  // Commitment = Poseidon(nullifier, secret, amount, recipient)
  // Using recipient=0 as placeholder (actual recipient determined at withdrawal)
  const PLACEHOLDER_RECIPIENT = BigInt(0);
  const commitmentBigInt = await computePoseidonHash([
    nullifier,
    secret,
    denomination,
    PLACEHOLDER_RECIPIENT
  ]);
  const commitment = new Uint8Array(bigintToBytes32(commitmentBigInt));

  const note: DepositNote = {
    nullifier,
    secret,
    commitment,
    denomination,
    leafIndex: -1, // Set after deposit
    timestamp: Date.now(),
  };

  return { note, commitment };
}

/**
 * Save deposit note (should be encrypted)
 */
export function saveDepositNote(note: DepositNote): void {
  const key = Buffer.from(note.commitment).toString('hex');
  depositNotes.set(key, note);

  // Also save to localStorage (encrypted in production)
  if (typeof window !== 'undefined') {
    const notes = JSON.parse(localStorage.getItem('veil_deposit_notes') || '[]');
    notes.push({
      ...note,
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      commitment: Buffer.from(note.commitment).toString('hex'),
      denomination: note.denomination.toString(),
      // Serialize merkle data if present
      merkleRoot: note.merkleRoot ? Buffer.from(note.merkleRoot).toString('hex') : undefined,
      merklePath: note.merklePath ? note.merklePath.map(p => Buffer.from(p).toString('hex')) : undefined,
    });
    localStorage.setItem('veil_deposit_notes', JSON.stringify(notes));
  }
}

/**
 * Load deposit notes from storage
 */
export function loadDepositNotes(): DepositNote[] {
  if (typeof window === 'undefined') return [];

  try {
    const notes = JSON.parse(localStorage.getItem('veil_deposit_notes') || '[]');
    return notes.map((n: any) => ({
      nullifier: BigInt(n.nullifier),
      secret: BigInt(n.secret),
      commitment: new Uint8Array(Buffer.from(n.commitment, 'hex')),
      denomination: BigInt(n.denomination),
      leafIndex: n.leafIndex,
      timestamp: n.timestamp,
      txSignature: n.txSignature,
      // Deserialize merkle data if present
      merkleRoot: n.merkleRoot ? new Uint8Array(Buffer.from(n.merkleRoot, 'hex')) : undefined,
      merklePath: n.merklePath ? n.merklePath.map((p: string) => new Uint8Array(Buffer.from(p, 'hex'))) : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Clear all privacy data (for testing/reset)
 * Call this when commitment format changes
 */
export function clearPrivacyData(): void {
  if (typeof window === 'undefined') return;

  // Clear deposit notes
  localStorage.removeItem('veil_deposit_notes');

  // Clear Merkle tree commitments for all denominations
  const denominations = [
    DENOMINATION_0_1_SOL,
    DENOMINATION_0_5_SOL,
    DENOMINATION_1_SOL,
    DENOMINATION_5_SOL,
    DENOMINATION_10_SOL,
    DENOMINATION_100_SOL,
  ];

  for (const denom of denominations) {
    localStorage.removeItem(getCommitmentsKey(denom));
  }

  // Clear in-memory stores
  depositNotes.clear();
  commitmentsByDenom.clear();

  console.log('[StealthSol] Privacy data cleared. Please make a fresh deposit.');
}

/**
 * Get available balance from unspent deposit notes
 */
export function getAvailableBalance(): { lamports: bigint; sol: number } {
  const notes = loadDepositNotes();
  let total = BigInt(0);

  for (const note of notes) {
    // Count deposits that have a tx signature (confirmed on-chain) OR valid leafIndex
    const isConfirmed = note.leafIndex >= 0 || (note.txSignature && note.txSignature.length > 0);
    if (isConfirmed) {
      total += note.denomination;
    }
  }

  return {
    lamports: total,
    sol: Number(total) / LAMPORTS_PER_SOL,
  };
}

/**
 * Find a deposit note that can cover the requested amount
 */
export function findNoteForWithdrawal(amountLamports: bigint): DepositNote | null {
  const notes = loadDepositNotes();

  const isNoteValid = (note: DepositNote) =>
    note.leafIndex >= 0 || (note.txSignature && note.txSignature.length > 0);

  // Find exact match first
  for (const note of notes) {
    if (note.denomination === amountLamports && isNoteValid(note)) {
      return note;
    }
  }

  // Find any note that covers the amount
  for (const note of notes) {
    if (note.denomination >= amountLamports && isNoteValid(note)) {
      return note;
    }
  }

  return null;
}

/**
 * Mark a note as spent
 */
export function markNoteAsSpent(commitment: Uint8Array): void {
  const key = Buffer.from(commitment).toString('hex');
  depositNotes.delete(key);

  if (typeof window !== 'undefined') {
    const notes = JSON.parse(localStorage.getItem('veil_deposit_notes') || '[]');
    const filtered = notes.filter((n: any) => n.commitment !== key);
    localStorage.setItem('veil_deposit_notes', JSON.stringify(filtered));
  }
}

// ============================================
// Denomination Helpers
// ============================================

/**
 * Find the best denomination for an amount
 * Prefers larger denominations for better privacy (more users = larger anonymity set)
 * NOTE: Currently only 1, 10, 100 SOL are deployed on-chain
 */
export function findBestDenomination(amountSol: number): Denomination | null {
  const lamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

  // Check denominations from largest to smallest (only deployed ones)
  if (lamports >= DENOMINATION_100_SOL) return DENOMINATION_100_SOL;
  if (lamports >= DENOMINATION_10_SOL) return DENOMINATION_10_SOL;
  if (lamports >= DENOMINATION_1_SOL) return DENOMINATION_1_SOL;
  if (lamports >= DENOMINATION_0_1_SOL) return DENOMINATION_0_1_SOL;

  return null;
}

/**
 * Find exact denomination match for an amount
 */
export function findExactDenomination(amountSol: number): Denomination | null {
  const lamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

  for (const denom of VALID_DENOMINATIONS) {
    if (lamports === denom) return denom;
  }
  return null;
}

/**
 * Split amount into optimal denomination notes
 * Uses greedy algorithm starting from largest denomination
 */
export function splitIntoDenominations(amountSol: number): Denomination[] {
  const notes: Denomination[] = [];
  let remaining = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

  // Process denominations from largest to smallest
  const sortedDenoms = [...VALID_DENOMINATIONS].sort((a, b) => Number(b - a));

  for (const denom of sortedDenoms) {
    while (remaining >= denom) {
      notes.push(denom);
      remaining -= denom;
    }
  }

  return notes;
}

/**
 * Calculate how many notes for an amount
 */
export function countNotes(amountSol: number): number {
  return splitIntoDenominations(amountSol).length;
}

/**
 * Get all available denominations with labels
 * NOTE: Only denominations deployed on-chain are available
 */
export function getDenominationOptions(): { value: Denomination; sol: number; label: string; recommended?: boolean }[] {
  return [
    { value: DENOMINATION_0_1_SOL, sol: 0.1, label: '0.1 SOL' },
    { value: DENOMINATION_1_SOL, sol: 1, label: '1 SOL', recommended: true },
    { value: DENOMINATION_10_SOL, sol: 10, label: '10 SOL' },
    { value: DENOMINATION_100_SOL, sol: 100, label: '100 SOL' },
  ];
}

// ============================================
// StealthSol Backend (Your Program)
// ============================================

export interface DepositResult {
  success: boolean;
  txId?: string;
  commitment?: Uint8Array;
  leafIndex?: number;
  denomination?: bigint;
  error?: string;
}

export interface WithdrawResult {
  success: boolean;
  txId?: string;
  stealthAddress?: string;
  denomination?: bigint;
  error?: string;
}

/**
 * Deposit using StealthSol program
 */
export async function stealthsolDeposit(
  connection: Connection,
  depositor: PublicKey,
  denomination: Denomination,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<DepositResult> {
  try {
    console.log(`[StealthSol] Depositing ${Number(denomination) / LAMPORTS_PER_SOL} SOL...`);

    // Check if pool is initialized, if not initialize it
    const poolExists = await isPoolInitialized(connection, denomination);
    if (!poolExists) {
      console.log(`[StealthSol] Pool for ${Number(denomination) / LAMPORTS_PER_SOL} SOL not initialized, creating...`);
      const initResult = await initializePool(connection, depositor, denomination, signTransaction);
      if (!initResult.success) {
        return { success: false, error: `Failed to initialize pool: ${initResult.error}` };
      }
      console.log(`[StealthSol] Pool initialized: ${initResult.signature}`);
    }

    // Generate deposit note
    const { note, commitment } = await generateDepositNote(denomination);

    // Execute deposit
    const result = await privateDeposit(
      connection,
      depositor,
      denomination,
      commitment,
      signTransaction
    );

    // Update note with result
    note.leafIndex = result.leafIndex;
    note.txSignature = result.signature;

    // CRITICAL: Capture merkle data immediately after deposit
    // The filled_subtrees at this moment represents the correct merkle path
    // for the leaf we just inserted (since leaves are added left to right)
    console.log('[StealthSol] Capturing merkle data for withdrawal proof...');
    const poolState = await getPoolState(connection, denomination);
    const filledSubtrees = await getFilledSubtrees(connection, denomination);

    if (poolState && filledSubtrees) {
      note.merkleRoot = poolState.merkleRoot;
      // Compute path elements based on leaf index
      // For the rightmost leaf (just inserted), filled_subtrees gives correct siblings
      note.merklePath = await computeMerklePathFromSubtrees(result.leafIndex, filledSubtrees);
      console.log('[StealthSol] Merkle data captured: root =', Buffer.from(poolState.merkleRoot).toString('hex').slice(0, 16) + '...');
    } else {
      console.warn('[StealthSol] Warning: Could not capture merkle data. Withdrawal may fail.');
    }

    // Save note for later withdrawal
    saveDepositNote(note);

    // Save commitment to client-side Merkle tree (for backwards compatibility)
    saveCommitment(denomination, commitment, result.leafIndex);

    console.log(`[StealthSol] Deposit successful: ${result.signature}`);
    console.log(`[StealthSol] Commitment saved at leaf index: ${result.leafIndex}`);

    return {
      success: true,
      txId: result.signature,
      commitment,
      leafIndex: result.leafIndex,
      denomination,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[StealthSol] Deposit failed:', error);
    return { success: false, error };
  }
}

/**
 * Withdraw using StealthSol program via relayer
 *
 * PRIVACY: Withdrawal is submitted by the relayer, not the user.
 * This prevents linking the user's wallet to the withdrawal.
 */
// Demo mode flag - set to true to skip ZK proof for hackathon demo
// ZK proof generation takes 30-60 seconds in browser
const DEMO_MODE = false;

export async function stealthsolWithdraw(
  connection: Connection,
  _relayer: PublicKey, // Unused - relayer submits the tx
  stealth: StealthAddressParams,
  denomination: Denomination,
  _signTransaction: (tx: Transaction) => Promise<Transaction> // Unused - relayer signs
): Promise<WithdrawResult> {
  try {
    console.log(`[StealthSol] Withdrawing ${Number(denomination) / LAMPORTS_PER_SOL} SOL via relayer...`);

    // Find a deposit note to spend
    const note = findNoteForWithdrawal(denomination);
    if (!note) {
      return { success: false, error: 'No deposit note found for this amount' };
    }

    // DEMO MODE: Skip ZK proof and relayer, simulate successful withdrawal
    if (DEMO_MODE) {
      console.log('[StealthSol] DEMO MODE: Simulating withdrawal...');

      // Simulate processing delay
      await new Promise(r => setTimeout(r, 2000));

      // Mark note as spent
      markNoteAsSpent(note.commitment);

      // Generate a mock transaction ID
      const mockTxId = `demo_withdraw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      console.log('[StealthSol] DEMO: Withdrawal simulated successfully');
      console.log('[StealthSol] DEMO: Stealth address:', stealth.stealthAddress.toBase58());

      return {
        success: true,
        txId: mockTxId,
        stealthAddress: stealth.stealthAddress.toBase58(),
        denomination,
      };
    }

    // PRODUCTION MODE: Full ZK proof flow
    // Check relayer availability
    const relayerInfo = await getRelayerInfo();
    if (!relayerInfo) {
      return { success: false, error: 'Relayer not available. Please try again later.' };
    }

    console.log(`[StealthSol] Using relayer: ${relayerInfo.address} (fee: ${relayerInfo.feePercent}%)`);

    // Get pool state for merkle root
    const poolState = await getPoolState(connection, denomination);
    if (!poolState) {
      return { success: false, error: 'Pool not initialized' };
    }

    // Compute nullifier hash
    const nullifierHash = await computePoseidonHash([note.nullifier]);
    const nullifierHashBytes = new Uint8Array(bigintToBytes32(nullifierHash));

    // Check if already spent
    const isSpent = await isNullifierUsed(connection, denomination, nullifierHashBytes);
    if (isSpent) {
      markNoteAsSpent(note.commitment);
      return { success: false, error: 'Note already spent' };
    }

    // Generate real ZK proof
    console.log('[StealthSol] Generating ZK proof...');

    // Initialize prover if needed
    if (!isGroth16ProverReady()) {
      await initializeGroth16Prover();
    }

    // Get merkle data - prefer stored data from deposit time
    let merkleRoot: bigint;
    let pathElements: bigint[];
    let pathIndices: number[];

    if (note.merkleRoot && note.merklePath && note.merklePath.length === MERKLE_DEPTH) {
      // Use stored merkle data from deposit time (correct approach)
      console.log('[StealthSol] Using stored merkle data from deposit time');
      merkleRoot = BigInt('0x' + Buffer.from(note.merkleRoot).toString('hex'));
      pathElements = note.merklePath.map(p => BigInt('0x' + Buffer.from(p).toString('hex')));
      // Compute path indices from leaf index
      pathIndices = [];
      let idx = note.leafIndex;
      for (let i = 0; i < MERKLE_DEPTH; i++) {
        pathIndices.push(idx & 1);
        idx = Math.floor(idx / 2);
      }
      console.log('[StealthSol] Stored merkle root:', merkleRoot.toString(16).slice(0, 16) + '...');
    } else {
      // Fallback: compute from client-side tree (may not match on-chain)
      console.warn('[StealthSol] Warning: No stored merkle data, computing from client tree (may fail)');
      saveCommitment(denomination, note.commitment, note.leafIndex);
      console.log('[StealthSol] Computing merkle proof for leaf index:', note.leafIndex);
      const computed = await computeMerkleProof(denomination, note.leafIndex);
      merkleRoot = computed.root;
      pathElements = computed.pathElements;
      pathIndices = computed.pathIndices;
      console.log('[StealthSol] Computed merkle root:', merkleRoot.toString(16).slice(0, 16) + '...');
    }

    console.log('[StealthSol] On-chain merkle root:', Buffer.from(poolState.merkleRoot).toString('hex').slice(0, 16) + '...');

    // Generate withdrawal proof
    // The commitment was created with recipient=0 as placeholder
    // We must use the same value here for the proof to verify
    const PLACEHOLDER_RECIPIENT = BigInt(0);

    // Use the stored/computed root that matches our path elements
    const withdrawInputs: WithdrawInputs = {
      // Public inputs
      merkleRoot: merkleRoot, // Use stored root from deposit time
      nullifierHash: nullifierHash,
      recipient: PLACEHOLDER_RECIPIENT, // Must match deposit-time commitment
      amount: denomination,
      // Private inputs
      nullifier: note.nullifier,
      secret: note.secret,
      pathElements,
      pathIndices,
    };

    console.log('[StealthSol] ZK proof inputs:', {
      merkleRoot: merkleRoot.toString(16).slice(0, 16) + '...',
      nullifierHash: nullifierHash.toString(16).slice(0, 16) + '...',
      recipient: PLACEHOLDER_RECIPIENT.toString(),
      amount: denomination.toString(),
      leafIndex: note.leafIndex,
      pathElementsLength: pathElements.length,
      pathIndicesLength: pathIndices.length,
    });

    console.log('[StealthSol] Starting ZK proof generation (this takes 30-60 seconds)...');
    const proofStartTime = Date.now();

    let proof;
    try {
      const result = await generateWithdrawProof(withdrawInputs);
      proof = result.proof;
      const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(1);
      console.log(`[StealthSol] ZK proof generated in ${proofTime}s`);
    } catch (proofError) {
      console.error('[StealthSol] ZK proof generation failed:', proofError);
      return { success: false, error: `ZK proof failed: ${proofError}` };
    }

    // Flatten proof for relayer
    const proofBytes = [...proof.pi_a, ...proof.pi_b, ...proof.pi_c];

    // Convert merkle root to bytes for relayer
    const merkleRootBytes = new Uint8Array(bigintToBytes32(merkleRoot));

    // Build relayer request
    const relayerRequest: RelayerWithdrawRequest = {
      proof: proofBytes,
      merkleRoot: Array.from(merkleRootBytes), // Use stored root from deposit time
      nullifierHash: Array.from(nullifierHashBytes),
      stealthAddress: stealth.stealthAddress.toBase58(),
      ephemeralPubkey: Array.from(stealth.ephemeralPubkey),
      scanPubkey: Array.from(stealth.scanPubkey),
      spendPubkey: Array.from(stealth.spendPubkey),
      stealthCommitment: Array.from(stealth.stealthCommitment),
      denomination: denomination.toString(),
    };

    // Submit to relayer
    console.log('[StealthSol] Submitting to relayer...');
    const result = await submitToRelayer(relayerRequest);

    if (!result.success) {
      return { success: false, error: result.error || 'Relayer submission failed' };
    }

    // Mark note as spent
    markNoteAsSpent(note.commitment);

    console.log(`[StealthSol] Withdrawal successful via relayer: ${result.signature}`);
    console.log(`[StealthSol] Relayer fee: ${result.fee} SOL`);

    return {
      success: true,
      txId: result.signature,
      stealthAddress: stealth.stealthAddress.toBase58(),
      denomination,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[StealthSol] Withdrawal failed:', error);
    return { success: false, error };
  }
}

// ============================================
// Mock Backend (for testing without blockchain)
// ============================================

let mockBalance = BigInt(0);

export function resetMockBalance(lamports: bigint = BigInt(0)): void {
  mockBalance = lamports;
}

export async function mockDeposit(denomination: Denomination): Promise<DepositResult> {
  console.log(`[Mock] Depositing ${Number(denomination) / LAMPORTS_PER_SOL} SOL...`);

  // Simulate delay
  await new Promise(r => setTimeout(r, 1000));

  mockBalance += denomination;

  const { note, commitment } = await generateDepositNote(denomination);
  note.leafIndex = Math.floor(Math.random() * 1000);
  note.txSignature = `mock_deposit_${Date.now()}`;
  saveDepositNote(note);

  return {
    success: true,
    txId: note.txSignature,
    commitment,
    leafIndex: note.leafIndex,
    denomination,
  };
}

export async function mockWithdraw(denomination: Denomination, stealthAddress: string): Promise<WithdrawResult> {
  console.log(`[Mock] Withdrawing ${Number(denomination) / LAMPORTS_PER_SOL} SOL...`);

  if (mockBalance < denomination) {
    return { success: false, error: 'Insufficient mock balance' };
  }

  const note = findNoteForWithdrawal(denomination);
  if (!note) {
    return { success: false, error: 'No deposit note found' };
  }

  // Simulate delay
  await new Promise(r => setTimeout(r, 1500));

  mockBalance -= denomination;
  markNoteAsSpent(note.commitment);

  return {
    success: true,
    txId: `mock_withdraw_${Date.now()}`,
    stealthAddress,
    denomination,
  };
}

export function getMockBalance(): { lamports: bigint; sol: number } {
  return {
    lamports: mockBalance,
    sol: Number(mockBalance) / LAMPORTS_PER_SOL,
  };
}

// ============================================
// Unified Interface
// ============================================

export interface PrivacyBackend {
  mode: BackendMode;
  deposit: (denomination: Denomination) => Promise<DepositResult>;
  withdraw: (denomination: Denomination, stealthAddress: string, stealthParams: StealthAddressParams) => Promise<WithdrawResult>;
  getBalance: () => Promise<{ lamports: bigint; sol: number }>;
}

// ============================================
// Light Protocol Backend
// ============================================

/**
 * Deposit using Light Protocol ZK compression
 * No compute unit limits - heavy computation is off-chain
 */
export async function lightProtocolDeposit(
  connection: Connection,
  publicKey: PublicKey,
  denomination: Denomination,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<DepositResult> {
  try {
    console.log(`[LightProtocol] Shielding ${Number(denomination) / LAMPORTS_PER_SOL} SOL...`);

    // Initialize Light Protocol RPC
    initLightRpc();

    const result = await shieldSolWithWallet(
      connection,
      publicKey,
      denomination,
      signTransaction
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Generate a mock commitment for compatibility
    const commitment = new Uint8Array(32);
    crypto.getRandomValues(commitment);

    console.log(`[LightProtocol] Shield successful: ${result.signature}`);

    return {
      success: true,
      txId: result.signature,
      commitment,
      leafIndex: 0, // Not used in Light Protocol
      denomination,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[LightProtocol] Shield failed:', error);
    return { success: false, error };
  }
}

/**
 * Withdraw using Light Protocol ZK compression
 */
export async function lightProtocolWithdraw(
  connection: Connection,
  publicKey: PublicKey,
  recipient: PublicKey,
  denomination: Denomination,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<WithdrawResult> {
  try {
    console.log(`[LightProtocol] Unshielding ${Number(denomination) / LAMPORTS_PER_SOL} SOL...`);

    // Initialize Light Protocol RPC
    initLightRpc();

    const result = await unshieldSolWithWallet(
      connection,
      publicKey,
      recipient,
      denomination,
      signTransaction
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    console.log(`[LightProtocol] Unshield successful: ${result.signature}`);

    return {
      success: true,
      txId: result.signature,
      stealthAddress: recipient.toBase58(),
      denomination,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[LightProtocol] Unshield failed:', error);
    return { success: false, error };
  }
}

/**
 * Get Light Protocol compressed balance
 */
export async function getLightProtocolBalance(publicKey: PublicKey): Promise<{ lamports: bigint; sol: number }> {
  try {
    initLightRpc();
    const balance = await getCompressedSolBalance(publicKey);
    return {
      lamports: balance,
      sol: Number(balance) / LAMPORTS_PER_SOL,
    };
  } catch (err) {
    console.error('[LightProtocol] Get balance failed:', err);
    return { lamports: BigInt(0), sol: 0 };
  }
}

/**
 * Create a privacy backend based on current mode
 */
export function createPrivacyBackend(
  connection: Connection,
  wallet: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
  }
): PrivacyBackend {
  const mode = BACKEND_MODE;

  // Light Protocol mode - recommended, no compute limit issues
  if (mode === 'lightprotocol') {
    return {
      mode,
      deposit: async (denomination) => {
        return lightProtocolDeposit(
          connection,
          wallet.publicKey,
          denomination,
          wallet.signTransaction
        );
      },
      withdraw: async (denomination, _stealthAddress, stealthParams) => {
        return lightProtocolWithdraw(
          connection,
          wallet.publicKey,
          stealthParams.stealthAddress,
          denomination,
          wallet.signTransaction
        );
      },
      getBalance: async () => {
        return getLightProtocolBalance(wallet.publicKey);
      },
    };
  }

  // StealthSol mode - original implementation
  if (mode === 'stealthsol') {
    return {
      mode,
      deposit: async (denomination) => {
        return stealthsolDeposit(
          connection,
          wallet.publicKey,
          denomination,
          wallet.signTransaction
        );
      },
      withdraw: async (denomination, _stealthAddress, stealthParams) => {
        return stealthsolWithdraw(
          connection,
          wallet.publicKey,
          stealthParams,
          denomination,
          wallet.signTransaction
        );
      },
      getBalance: async () => {
        // Sum up unspent deposit notes
        return getAvailableBalance();
      },
    };
  }

  // Mock mode
  return {
    mode: 'mock',
    deposit: async (denomination) => mockDeposit(denomination),
    withdraw: async (denomination, stealthAddress) => mockWithdraw(denomination, stealthAddress),
    getBalance: async () => getMockBalance(),
  };
}

// ============================================
// Exports
// ============================================

export {
  PROGRAM_ID,
  VALID_DENOMINATIONS,
  DENOMINATION_0_1_SOL,
  DENOMINATION_0_5_SOL,
  DENOMINATION_1_SOL,
  DENOMINATION_5_SOL,
  DENOMINATION_10_SOL,
  DENOMINATION_100_SOL,
  type Denomination,
};
