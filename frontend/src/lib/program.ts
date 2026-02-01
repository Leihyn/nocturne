/**
 * StealthSol On-Chain Program Integration
 *
 * This module provides TypeScript bindings to call the Solana program
 * with real ZK proofs for private deposits and withdrawals.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

// Program ID (deployed on devnet)
export const PROGRAM_ID = new PublicKey('6mKNcFyg2qKuobBkket5tVHKE9178N2CkRonkzkprDrp');

// PDA Seeds
const POOL_SEED = Buffer.from('privacy_pool');
const CONFIG_SEED = Buffer.from('pool_config');
const COMMITMENT_SEED = Buffer.from('commitment');
const NULLIFIER_SEED = Buffer.from('nullifier');

// Fixed denominations for privacy
// NOTE: On-chain program currently only supports 1, 10, 100 SOL
// Smaller amounts require redeploying the program
export const DENOMINATION_0_1_SOL = BigInt(100_000_000);   // 0.1 SOL (not deployed)
export const DENOMINATION_0_5_SOL = BigInt(500_000_000);   // 0.5 SOL (not deployed)
export const DENOMINATION_1_SOL = BigInt(1_000_000_000);   // 1 SOL (recommended)
export const DENOMINATION_5_SOL = BigInt(5_000_000_000);   // 5 SOL (not deployed)
export const DENOMINATION_10_SOL = BigInt(10_000_000_000); // 10 SOL
export const DENOMINATION_100_SOL = BigInt(100_000_000_000); // 100 SOL

// Valid denominations that match the DEPLOYED on-chain program
// 0.1 SOL added for testing with fresh pool (no old depth 20 structure)
export const VALID_DENOMINATIONS = [
  DENOMINATION_0_1_SOL,
  DENOMINATION_1_SOL,
  DENOMINATION_10_SOL,
  DENOMINATION_100_SOL,
] as const;

export type Denomination = typeof VALID_DENOMINATIONS[number];

// Instruction discriminators (first 8 bytes of sha256("global:<instruction_name>"))
const INSTRUCTION_DISCRIMINATORS = {
  initializePool: Buffer.from([0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28]),
  privateDeposit: Buffer.from([0x4d, 0xa9, 0xc2, 0x23, 0xd4, 0x03, 0x4f, 0x5c]),
  privateWithdraw: Buffer.from([0x5a, 0xee, 0x07, 0x11, 0x61, 0x06, 0xb5, 0xdd]),
  closePool: Buffer.from([0x8c, 0xbd, 0xd1, 0x17, 0xef, 0x3e, 0xef, 0x0b]),
};

// ============================================
// PDA Derivations (with denomination)
// ============================================

/**
 * Convert bigint denomination to 8-byte little-endian buffer
 */
function denominationToBytes(denomination: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(denomination);
  return buf;
}

/**
 * Get pool PDA for a specific denomination
 */
export function getPoolPDA(denomination: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, denominationToBytes(denomination)],
    PROGRAM_ID
  );
}

/**
 * Get config PDA for a specific denomination
 */
export function getConfigPDA(denomination: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CONFIG_SEED, denominationToBytes(denomination)],
    PROGRAM_ID
  );
}

/**
 * Get commitment PDA (includes denomination for cross-pool uniqueness)
 */
export function getCommitmentPDA(denomination: bigint, commitment: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, denominationToBytes(denomination), commitment],
    PROGRAM_ID
  );
}

/**
 * Get nullifier PDA (includes denomination for cross-pool uniqueness)
 */
export function getNullifierPDA(denomination: bigint, nullifierHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, denominationToBytes(denomination), nullifierHash],
    PROGRAM_ID
  );
}

// ============================================
// Instruction Builders
// ============================================

/**
 * Fixed-denomination deposit parameters
 * Amount is determined by denomination - not user-specified
 */
export interface PrivateDepositParams {
  depositor: PublicKey;
  denomination: bigint; // 1, 10, or 100 SOL (in lamports)
  commitment: Uint8Array; // 32 bytes
  feeRecipient: PublicKey; // Must match config.fee_recipient
  encryptedNote?: Uint8Array; // 128 bytes optional
}

/**
 * Build a private deposit instruction for a fixed-denomination pool
 *
 * PRIVACY: The amount is NOT specified - it's determined by the pool's denomination.
 * All deposits in a pool are exactly the same amount.
 */
export function buildPrivateDepositInstruction(
  params: PrivateDepositParams
): TransactionInstruction {
  const { depositor, denomination, commitment, feeRecipient, encryptedNote } = params;

  // Derive PDAs with denomination
  const [poolPDA] = getPoolPDA(denomination);
  const [configPDA] = getConfigPDA(denomination);
  const [commitmentPDA] = getCommitmentPDA(denomination, commitment);

  // Serialize instruction data
  // Format: discriminator (8) + denomination (8) + commitment (32) + has_note (1) + [note (128)]
  const hasNote = encryptedNote ? 1 : 0;
  const dataSize = 8 + 8 + 32 + 1 + (hasNote ? 128 : 0);
  const data = Buffer.alloc(dataSize);

  let offset = 0;
  INSTRUCTION_DISCRIMINATORS.privateDeposit.copy(data, offset);
  offset += 8;

  // Denomination first (matches on-chain instruction order)
  data.writeBigUInt64LE(denomination, offset);
  offset += 8;

  Buffer.from(commitment).copy(data, offset);
  offset += 32;

  data.writeUInt8(hasNote, offset);
  offset += 1;

  if (encryptedNote) {
    Buffer.from(encryptedNote).copy(data, offset);
    offset += 128;
  }

  // Build accounts - matching deployed program structure
  // Fee recipient must match config.fee_recipient exactly
  const accounts = [
    { pubkey: depositor, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: configPDA, isSigner: false, isWritable: false },
    { pubkey: commitmentPDA, isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: true }, // fee_recipient from config
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys: accounts,
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Build an initialize pool instruction for a specific denomination
 */
export function buildInitializePoolInstruction(
  authority: PublicKey,
  denomination: bigint
): TransactionInstruction {
  const [poolPDA] = getPoolPDA(denomination);
  const [configPDA] = getConfigPDA(denomination);

  // Serialize instruction data: discriminator (8) + denomination (8)
  const data = Buffer.alloc(16);
  INSTRUCTION_DISCRIMINATORS.initializePool.copy(data, 0);
  data.writeBigUInt64LE(denomination, 8);

  const accounts = [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: configPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys: accounts,
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Initialize a privacy pool for a specific denomination
 */
export async function initializePool(
  connection: Connection,
  authority: PublicKey,
  denomination: Denomination,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const instruction = buildInitializePoolInstruction(authority, denomination);

    // Request max compute units - Poseidon zero hash computation is very expensive
    // The program computes 8 Poseidon hashes (MERKLE_DEPTH=8) × 65 rounds each
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000, // 1.4M CUs (max) for pool initialization
    });

    const transaction = new Transaction()
      .add(computeBudgetIx)
      .add(instruction);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = authority;

    const signedTx = await signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');

    console.log(`Pool initialized for ${Number(denomination) / 1e9} SOL: ${signature}`);
    return { success: true, signature };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Check if already initialized
    if (error.includes('already in use')) {
      return { success: true, signature: 'already-initialized' };
    }
    console.error('Failed to initialize pool:', error);
    return { success: false, error };
  }
}

/**
 * Close a privacy pool (for migration/cleanup)
 * Only the pool authority can close
 */
export async function closePool(
  connection: Connection,
  authority: PublicKey,
  denomination: Denomination,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const [poolPDA] = getPoolPDA(BigInt(denomination));
    const [configPDA] = getConfigPDA(BigInt(denomination));

    // Build instruction data: discriminator + denomination
    const data = Buffer.alloc(8 + 8);
    INSTRUCTION_DISCRIMINATORS.closePool.copy(data, 0);
    data.writeBigUInt64LE(BigInt(denomination), 8);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const transaction = new Transaction().add(instruction);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = authority;

    const signedTx = await signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');

    console.log(`Pool closed for ${Number(denomination) / 1e9} SOL: ${signature}`);
    return { success: true, signature };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('Failed to close pool:', error);
    return { success: false, error };
  }
}

/**
 * Check if a pool is initialized for a denomination
 */
export async function isPoolInitialized(
  connection: Connection,
  denomination: bigint
): Promise<boolean> {
  const [poolPDA] = getPoolPDA(denomination);
  const accountInfo = await connection.getAccountInfo(poolPDA);
  return accountInfo !== null && accountInfo.owner.equals(PROGRAM_ID);
}

export interface Attestation {
  proofHash: Uint8Array; // 32 bytes
  publicInputsHash: Uint8Array; // 32 bytes
  verifier: Uint8Array; // 32 bytes
  signature: Uint8Array; // 64 bytes
  verifiedAt: bigint; // i64 timestamp
}

// Announcement PDA seed
const ANNOUNCEMENT_SEED = Buffer.from('announcement');

/**
 * Get announcement PDA for a stealth withdrawal
 */
export function getAnnouncementPDA(ephemeralPubkey: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ANNOUNCEMENT_SEED, ephemeralPubkey],
    PROGRAM_ID
  );
}

/**
 * Stealth address parameters for private withdrawal
 * These prove the recipient address was correctly derived from a meta-address
 */
export interface StealthAddressParams {
  stealthAddress: PublicKey; // One-time unlinkable address
  ephemeralPubkey: Uint8Array; // 32 bytes - R = r·G for scanning
  scanPubkey: Uint8Array; // 32 bytes - recipient's scan key
  spendPubkey: Uint8Array; // 32 bytes - recipient's spend key
  stealthCommitment: Uint8Array; // 32 bytes - proves correct derivation
}

/**
 * Fixed-denomination withdrawal parameters with stealth address
 * Amount is determined by pool denomination - not user-specified
 * Recipient identity is hidden via stealth address
 */
export interface PrivateWithdrawParams {
  relayer: PublicKey;
  stealth: StealthAddressParams; // Stealth address for recipient privacy
  denomination: bigint; // 1, 10, or 100 SOL (in lamports)
  proof: Uint8Array; // Noir proof bytes
  merkleRoot: Uint8Array; // 32 bytes
  nullifierHash: Uint8Array; // 32 bytes
  relayerFee: bigint; // lamports
  attestation?: Attestation; // Optional in dev mode, required in production
}

/**
 * Build a private withdraw instruction for a fixed-denomination pool
 * with stealth address recipient for maximum privacy.
 *
 * PRIVACY PROPERTIES:
 * - Amount: HIDDEN (fixed denomination)
 * - Deposit↔Withdrawal link: HIDDEN (ZK proof)
 * - Recipient identity: HIDDEN (stealth address)
 */
export function buildPrivateWithdrawInstruction(
  params: PrivateWithdrawParams
): TransactionInstruction {
  const {
    relayer,
    stealth,
    denomination,
    proof,
    merkleRoot,
    nullifierHash,
    relayerFee,
    attestation,
  } = params;

  // Derive PDAs with denomination
  const [poolPDA] = getPoolPDA(denomination);
  const [configPDA] = getConfigPDA(denomination);
  const [nullifierPDA] = getNullifierPDA(denomination, nullifierHash);
  const [announcementPDA] = getAnnouncementPDA(stealth.ephemeralPubkey);

  // Serialize instruction data
  // Format: discriminator (8) + denomination (8) + WithdrawProof (serialized) + relayer_fee (8)
  // WithdrawProof = proof_len (4) + proof (var) + public_inputs + attestation_option
  // public_inputs = merkle_root (32) + nullifier_hash (32) + stealth_address (32) +
  //                 ephemeral_pubkey (32) + scan_pubkey (32) + spend_pubkey (32) + stealth_commitment (32)
  // attestation_option = has_attestation (1) + [attestation (168)]
  // attestation = proof_hash (32) + public_inputs_hash (32) + verifier (32) + signature (64) + verified_at (8)

  const proofLen = proof.length;
  const hasAttestation = attestation ? 1 : 0;
  const attestationSize = hasAttestation ? (32 + 32 + 32 + 64 + 8) : 0;

  // Public inputs now include stealth address fields (no amount - implicit from denomination)
  // merkle_root(32) + nullifier_hash(32) + stealth_address(32) + ephemeral(32) + scan(32) + spend(32) + commitment(32) = 224
  const dataSize = 8 + 8 + 4 + proofLen + 224 + 1 + attestationSize + 8;
  const data = Buffer.alloc(dataSize);

  let offset = 0;
  INSTRUCTION_DISCRIMINATORS.privateWithdraw.copy(data, offset);
  offset += 8;

  // Denomination first (matches on-chain instruction order)
  data.writeBigUInt64LE(denomination, offset);
  offset += 8;

  // Proof length and bytes
  data.writeUInt32LE(proofLen, offset);
  offset += 4;

  Buffer.from(proof).copy(data, offset);
  offset += proofLen;

  // Public inputs with stealth address (NO AMOUNT - determined by pool denomination)
  Buffer.from(merkleRoot).copy(data, offset);
  offset += 32;

  Buffer.from(nullifierHash).copy(data, offset);
  offset += 32;

  // Stealth address fields
  stealth.stealthAddress.toBuffer().copy(data, offset);
  offset += 32;

  Buffer.from(stealth.ephemeralPubkey).copy(data, offset);
  offset += 32;

  Buffer.from(stealth.scanPubkey).copy(data, offset);
  offset += 32;

  Buffer.from(stealth.spendPubkey).copy(data, offset);
  offset += 32;

  Buffer.from(stealth.stealthCommitment).copy(data, offset);
  offset += 32;

  // Attestation option
  data.writeUInt8(hasAttestation, offset);
  offset += 1;

  if (attestation) {
    Buffer.from(attestation.proofHash).copy(data, offset);
    offset += 32;

    Buffer.from(attestation.publicInputsHash).copy(data, offset);
    offset += 32;

    Buffer.from(attestation.verifier).copy(data, offset);
    offset += 32;

    Buffer.from(attestation.signature).copy(data, offset);
    offset += 64;

    data.writeBigInt64LE(attestation.verifiedAt, offset);
    offset += 8;
  }

  // Relayer fee
  data.writeBigUInt64LE(relayerFee, offset);

  // Build accounts (now includes announcement for recipient scanning)
  const accounts = [
    { pubkey: relayer, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: configPDA, isSigner: false, isWritable: false },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: stealth.stealthAddress, isSigner: false, isWritable: true },
    { pubkey: announcementPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys: accounts,
    programId: PROGRAM_ID,
    data,
  });
}

// ============================================
// High-Level Functions
// ============================================

export interface DepositResult {
  signature: string;
  commitment: Uint8Array;
  leafIndex: number;
  denomination: bigint;
}

/**
 * Execute a private deposit to a fixed-denomination pool
 *
 * PRIVACY: The amount is determined by the pool's denomination.
 * All deposits in a pool are exactly the same amount.
 */
export async function privateDeposit(
  connection: Connection,
  depositor: PublicKey,
  denomination: bigint,
  commitment: Uint8Array,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  encryptedNote?: Uint8Array
): Promise<DepositResult> {
  // Fetch config to get the correct fee recipient
  const config = await getPoolConfig(connection, denomination);
  if (!config) {
    throw new Error('Pool config not found - pool may not be initialized');
  }

  const instruction = buildPrivateDepositInstruction({
    depositor,
    denomination,
    commitment,
    feeRecipient: config.feeRecipient,
    encryptedNote,
  });

  // Request more compute units - Merkle tree operations are expensive
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000, // 1.4M CUs (max is 1.4M per transaction)
  });

  const transaction = new Transaction()
    .add(computeBudgetIx)
    .add(instruction);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = depositor;

  const signedTx = await signTransaction(transaction);
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  // Query pool state to get the leaf index (nextLeafIndex - 1 after deposit)
  const poolState = await getPoolState(connection, denomination);
  const leafIndex = poolState ? Number(poolState.nextLeafIndex) - 1 : 0;

  return {
    signature,
    commitment,
    leafIndex,
    denomination,
  };
}

export interface WithdrawResult {
  signature: string;
  denomination: bigint;
  stealthAddress: PublicKey;
}

/**
 * Execute a private withdrawal from a fixed-denomination pool
 * to a stealth address for maximum privacy.
 *
 * PRIVACY PROPERTIES:
 * - Amount: HIDDEN (fixed denomination)
 * - Deposit↔Withdrawal link: HIDDEN (ZK proof)
 * - Recipient identity: HIDDEN (stealth address)
 */
export async function privateWithdraw(
  connection: Connection,
  relayer: PublicKey,
  stealth: StealthAddressParams,
  denomination: bigint,
  proof: Uint8Array,
  merkleRoot: Uint8Array,
  nullifierHash: Uint8Array,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  relayerFee: bigint = BigInt(0)
): Promise<WithdrawResult> {
  const instruction = buildPrivateWithdrawInstruction({
    relayer,
    stealth,
    denomination,
    proof,
    merkleRoot,
    nullifierHash,
    relayerFee,
  });

  const transaction = new Transaction().add(instruction);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = relayer;

  const signedTx = await signTransaction(transaction);
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  return {
    signature,
    denomination,
    stealthAddress: stealth.stealthAddress,
  };
}

// ============================================
// Pool State Queries
// ============================================

export interface PoolState {
  authority: PublicKey;
  denomination: bigint;
  merkleRoot: Uint8Array;
  nextLeafIndex: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  depositCount: bigint;
  withdrawalCount: bigint;
  isActive: boolean;
}

/**
 * Fetch the current pool state for a specific denomination
 */
export async function getPoolState(connection: Connection, denomination: bigint): Promise<PoolState | null> {
  const [poolPDA] = getPoolPDA(denomination);
  const accountInfo = await connection.getAccountInfo(poolPDA);

  if (!accountInfo) {
    return null;
  }

  // Parse account data (after 8-byte discriminator)
  const data = accountInfo.data;
  let offset = 8;

  const authority = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const poolDenomination = data.readBigUInt64LE(offset);
  offset += 8;

  const merkleRoot = data.slice(offset, offset + 32);
  offset += 32;

  const nextLeafIndex = data.readBigUInt64LE(offset);
  offset += 8;

  // Skip filled_subtrees (20 * 32 = 640 bytes)
  offset += 640;

  const totalDeposited = data.readBigUInt64LE(offset);
  offset += 8;

  const totalWithdrawn = data.readBigUInt64LE(offset);
  offset += 8;

  const depositCount = data.readBigUInt64LE(offset);
  offset += 8;

  const withdrawalCount = data.readBigUInt64LE(offset);
  offset += 8;

  const isActive = data.readUInt8(offset) === 1;

  return {
    authority,
    denomination: poolDenomination,
    merkleRoot: new Uint8Array(merkleRoot),
    nextLeafIndex,
    totalDeposited,
    totalWithdrawn,
    depositCount,
    withdrawalCount,
    isActive,
  };
}

/**
 * Get the filled subtrees from pool state (needed for merkle proofs)
 */
export async function getFilledSubtrees(
  connection: Connection,
  denomination: bigint
): Promise<Uint8Array[] | null> {
  const [poolPDA] = getPoolPDA(denomination);
  const accountInfo = await connection.getAccountInfo(poolPDA);

  if (!accountInfo) {
    return null;
  }

  const data = accountInfo.data;
  // Skip: discriminator(8) + authority(32) + denomination(8) + merkle_root(32) + next_leaf_index(8) = 88
  const subtreesOffset = 88;
  const MERKLE_DEPTH = 8; // Reduced to fit Solana compute budget (256 deposits)

  const subtrees: Uint8Array[] = [];
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const start = subtreesOffset + i * 32;
    subtrees.push(new Uint8Array(data.slice(start, start + 32)));
  }

  return subtrees;
}

/**
 * Compute merkle path for a leaf at a given index
 * Uses filled_subtrees from the pool state
 */
export async function getMerklePath(
  connection: Connection,
  denomination: bigint,
  leafIndex: number
): Promise<{ pathElements: Uint8Array[]; pathIndices: number[] } | null> {
  const subtrees = await getFilledSubtrees(connection, denomination);
  if (!subtrees) return null;

  const MERKLE_DEPTH = 8; // Reduced to fit Solana compute budget (256 deposits)
  const pathElements: Uint8Array[] = [];
  const pathIndices: number[] = [];

  let index = leafIndex;
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    // Path index is the bit at this level (0 = left, 1 = right)
    pathIndices.push(index & 1);

    // The sibling is the filled subtree at this level
    // Note: This is a simplified version - for a complete implementation,
    // we'd need to track all leaves and compute exact siblings
    pathElements.push(subtrees[level]);

    index = Math.floor(index / 2);
  }

  return { pathElements, pathIndices };
}

/**
 * Check if a nullifier has been used in a specific denomination pool
 */
export async function isNullifierUsed(
  connection: Connection,
  denomination: bigint,
  nullifierHash: Uint8Array
): Promise<boolean> {
  const [nullifierPDA] = getNullifierPDA(denomination, nullifierHash);
  const accountInfo = await connection.getAccountInfo(nullifierPDA);
  return accountInfo !== null;
}

/**
 * Pool config structure
 */
export interface PoolConfig {
  authority: PublicKey;
  minDeposit: bigint;
  maxDeposit: bigint;
  feeBps: number;
  feeRecipient: PublicKey;
  depositsPaused: boolean;
  withdrawalsPaused: boolean;
}

/**
 * Fetch the pool config for a specific denomination
 */
export async function getPoolConfig(connection: Connection, denomination: bigint): Promise<PoolConfig | null> {
  const [configPDA] = getConfigPDA(denomination);
  const accountInfo = await connection.getAccountInfo(configPDA);

  if (!accountInfo) {
    return null;
  }

  // Parse config account data (after 8-byte discriminator)
  const data = accountInfo.data;
  let offset = 8;

  const authority = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const minDeposit = data.readBigUInt64LE(offset);
  offset += 8;

  const maxDeposit = data.readBigUInt64LE(offset);
  offset += 8;

  const feeBps = data.readUInt16LE(offset);
  offset += 2;

  const feeRecipient = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const depositsPaused = data.readUInt8(offset) === 1;
  offset += 1;

  const withdrawalsPaused = data.readUInt8(offset) === 1;

  return {
    authority,
    minDeposit,
    maxDeposit,
    feeBps,
    feeRecipient,
    depositsPaused,
    withdrawalsPaused,
  };
}

/**
 * Fetch the pool's root history for validating proofs
 * Returns current root + historical roots
 */
export async function getPoolRootHistory(
  connection: Connection,
  denomination: bigint
): Promise<{ currentRoot: Uint8Array; rootHistory: Uint8Array[] } | null> {
  const [poolPDA] = getPoolPDA(denomination);
  const accountInfo = await connection.getAccountInfo(poolPDA);

  if (!accountInfo) {
    return null;
  }

  const data = accountInfo.data;

  // Skip to merkle_root: 8 (disc) + 32 (authority) + 8 (denom) = 48
  const merkleRoot = new Uint8Array(data.slice(48, 80));

  // Skip to root_history: 48 + 32 (root) + 8 (index) + 640 (subtrees) + 8*4 (stats) + 1 (active) = 761
  const ROOT_HISTORY_SIZE = 30;
  const rootHistoryOffset = 48 + 32 + 8 + 640 + 32 + 1; // 761
  const rootHistory: Uint8Array[] = [];

  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    const start = rootHistoryOffset + i * 32;
    const root = new Uint8Array(data.slice(start, start + 32));
    // Skip zero roots
    if (!root.every(b => b === 0)) {
      rootHistory.push(root);
    }
  }

  return { currentRoot: merkleRoot, rootHistory };
}

/**
 * Check if a Merkle root is valid (current or in history)
 */
export async function isValidMerkleRoot(
  connection: Connection,
  denomination: bigint,
  root: Uint8Array
): Promise<boolean> {
  const poolRoots = await getPoolRootHistory(connection, denomination);
  if (!poolRoots) return false;

  // Check current root
  if (arraysEqual(poolRoots.currentRoot, root)) {
    return true;
  }

  // Check historical roots
  for (const historicalRoot of poolRoots.rootHistory) {
    if (arraysEqual(historicalRoot, root)) {
      return true;
    }
  }

  return false;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
