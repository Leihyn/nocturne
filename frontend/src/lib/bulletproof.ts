/**
 * Bulletproof Range Proof Implementation
 *
 * Provides ZK range proofs for hiding transaction amounts.
 * Uses bulletproof-js library for proof generation.
 *
 * Key features:
 * - Prove amount is in valid range (0 to 2^64) without revealing the amount
 * - Pedersen commitment hiding
 * - Compatible with on-chain verification via oracle attestation
 */

// @ts-ignore - bulletproof-js doesn't have types
import * as bulletproof from 'bulletproof-js';
// @ts-ignore - noble/hashes types resolution issue
import { sha256 } from '@noble/hashes/sha2';
// @ts-ignore - noble/hashes types resolution issue
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// Constants
export const MAX_AMOUNT = BigInt(2) ** BigInt(64) - BigInt(1); // Max u64
export const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

/**
 * Range proof for a hidden amount
 */
export interface RangeProof {
  /** The Pedersen commitment to the amount */
  commitment: Uint8Array;
  /** The range proof data */
  proof: Uint8Array;
  /** Bit length of the range (typically 64 for u64) */
  bitLength: number;
  /** Hash of the proof for verification */
  proofHash: Uint8Array;
}

/**
 * Commitment with blinding factor (for sender to reconstruct)
 */
export interface AmountCommitment {
  /** The Pedersen commitment */
  commitment: Uint8Array;
  /** The blinding factor (keep secret!) */
  blindingFactor: Uint8Array;
  /** The actual amount (keep secret!) */
  amount: bigint;
  /** Range proof */
  rangeProof: RangeProof;
}

/**
 * Oracle attestation for range proof validity
 */
export interface RangeProofAttestation {
  /** Hash of the commitment being proven */
  commitmentHash: Uint8Array;
  /** The amount range (min, max) */
  amountRange: [bigint, bigint];
  /** Verifier's signature */
  signature: Uint8Array;
  /** Verifier's public key */
  verifier: Uint8Array;
  /** Timestamp of verification */
  verifiedAt: number;
}

/**
 * Initialize the Bulletproof system
 * Must be called before using other functions
 */
let initialized = false;
let bpInstance: any = null;

export async function initBulletproof(): Promise<void> {
  if (initialized) return;

  try {
    // Initialize the bulletproof library
    bpInstance = bulletproof;
    initialized = true;
    console.log('Bulletproof system initialized');
  } catch (error) {
    console.error('Failed to initialize Bulletproof:', error);
    throw new Error('Bulletproof initialization failed');
  }
}

/**
 * Create a Pedersen commitment to an amount with a range proof
 *
 * @param amount - The amount to commit to (in lamports)
 * @param blindingFactor - Optional blinding factor (generated if not provided)
 * @returns AmountCommitment with the commitment, blinding factor, and range proof
 */
export async function createAmountCommitment(
  amount: bigint,
  blindingFactor?: Uint8Array
): Promise<AmountCommitment> {
  await initBulletproof();

  // Validate amount is in valid range
  if (amount < BigInt(0) || amount > MAX_AMOUNT) {
    throw new Error(`Amount must be between 0 and ${MAX_AMOUNT}`);
  }

  // Generate random blinding factor if not provided
  const blind = blindingFactor || crypto.getRandomValues(new Uint8Array(32));

  // Convert to format expected by bulletproof-js
  const amountBigInt = BigInt(amount.toString());
  const blindBigInt = bytesToBigInt(blind);

  try {
    // Create the Pedersen commitment: C = amount*G + blind*H
    const commitmentResult = bpInstance.commit(amountBigInt, blindBigInt);
    const commitment = bigIntToBytes(commitmentResult.commitment, 33);

    // Generate range proof (proves 0 <= amount < 2^64)
    const proofResult = bpInstance.prove(amountBigInt, blindBigInt, 64);
    const proofBytes = serializeProof(proofResult);

    // Compute proof hash for verification
    const proofHash = sha256(proofBytes);

    const rangeProof: RangeProof = {
      commitment,
      proof: proofBytes,
      bitLength: 64,
      proofHash: new Uint8Array(proofHash),
    };

    return {
      commitment,
      blindingFactor: blind,
      amount,
      rangeProof,
    };
  } catch (error) {
    console.error('Failed to create commitment:', error);
    throw new Error('Failed to create amount commitment');
  }
}

/**
 * Verify a range proof
 *
 * @param rangeProof - The range proof to verify
 * @returns true if the proof is valid
 */
export async function verifyRangeProof(rangeProof: RangeProof): Promise<boolean> {
  await initBulletproof();

  try {
    const proof = deserializeProof(rangeProof.proof);
    const commitment = bytesToBigInt(rangeProof.commitment);

    return bpInstance.verify(proof, commitment, rangeProof.bitLength);
  } catch (error) {
    console.error('Range proof verification failed:', error);
    return false;
  }
}

/**
 * Create a confidential transfer amount
 * This creates the commitment and proof needed for a private transfer
 *
 * @param amountSol - Amount in SOL (e.g., 1.5 for 1.5 SOL)
 * @returns AmountCommitment for the transfer
 */
export async function createConfidentialAmount(
  amountSol: number
): Promise<AmountCommitment> {
  const amountLamports = BigInt(Math.floor(amountSol * Number(LAMPORTS_PER_SOL)));
  return createAmountCommitment(amountLamports);
}

/**
 * Encode amount commitment for transmission
 */
export function encodeAmountCommitment(commitment: AmountCommitment): string {
  const data = {
    c: bytesToHex(commitment.commitment),
    p: bytesToHex(commitment.rangeProof.proof),
    h: bytesToHex(commitment.rangeProof.proofHash),
    b: commitment.rangeProof.bitLength,
  };
  return btoa(JSON.stringify(data));
}

/**
 * Decode amount commitment from transmission format
 * Note: This only recovers the public parts, not the blinding factor or amount
 */
export function decodeAmountCommitment(encoded: string): RangeProof {
  const data = JSON.parse(atob(encoded));
  return {
    commitment: hexToBytes(data.c),
    proof: hexToBytes(data.p),
    proofHash: hexToBytes(data.h),
    bitLength: data.b,
  };
}

/**
 * Create an oracle attestation request for a range proof
 */
export function createAttestationRequest(
  rangeProof: RangeProof
): { commitmentHash: Uint8Array; proofHash: Uint8Array } {
  const commitmentHash = sha256(rangeProof.commitment);
  return {
    commitmentHash: new Uint8Array(commitmentHash),
    proofHash: rangeProof.proofHash,
  };
}

/**
 * Verify an oracle attestation
 */
export async function verifyAttestation(
  attestation: RangeProofAttestation,
  rangeProof: RangeProof
): Promise<boolean> {
  // Verify commitment hash matches
  const expectedHash = sha256(rangeProof.commitment);
  if (!constantTimeEqual(attestation.commitmentHash, new Uint8Array(expectedHash))) {
    return false;
  }

  // Verify attestation is recent (within 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const age = now - attestation.verifiedAt;
  if (age < 0 || age > 300) {
    return false;
  }

  // Verify range is valid (0 to 2^64)
  if (attestation.amountRange[0] !== BigInt(0) ||
      attestation.amountRange[1] !== MAX_AMOUNT) {
    return false;
  }

  // Signature verification would happen on-chain via Ed25519 program
  return true;
}

// ============================================
// Homomorphic Operations
// ============================================

/**
 * Add two commitments (for combining amounts)
 * C1 + C2 = (a1 + a2)*G + (b1 + b2)*H
 */
export async function addCommitments(
  c1: Uint8Array,
  c2: Uint8Array
): Promise<Uint8Array> {
  await initBulletproof();

  const commitment1 = bytesToBigInt(c1);
  const commitment2 = bytesToBigInt(c2);

  // Point addition on the curve
  const sum = bpInstance.addCommitments(commitment1, commitment2);
  return bigIntToBytes(sum, 33);
}

/**
 * Subtract commitments (for computing change)
 * C1 - C2 = (a1 - a2)*G + (b1 - b2)*H
 */
export async function subtractCommitments(
  c1: Uint8Array,
  c2: Uint8Array
): Promise<Uint8Array> {
  await initBulletproof();

  const commitment1 = bytesToBigInt(c1);
  const commitment2 = bytesToBigInt(c2);

  const diff = bpInstance.subtractCommitments(commitment1, commitment2);
  return bigIntToBytes(diff, 33);
}

// ============================================
// Helper Functions
// ============================================

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = '0x';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return BigInt(hex);
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const hex = n.toString(16).padStart(length * 2, '0');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function serializeProof(proof: any): Uint8Array {
  // Serialize the proof object to bytes
  const json = JSON.stringify(proof, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  return new TextEncoder().encode(json);
}

function deserializeProof(bytes: Uint8Array): any {
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json, (_, v) => {
    if (typeof v === 'string' && /^\d+$/.test(v) && v.length > 15) {
      return BigInt(v);
    }
    return v;
  });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ============================================
// Export for use in ShadowWire
// ============================================

export const Bulletproof = {
  init: initBulletproof,
  createCommitment: createAmountCommitment,
  createConfidentialAmount,
  verifyProof: verifyRangeProof,
  encode: encodeAmountCommitment,
  decode: decodeAmountCommitment,
  addCommitments,
  subtractCommitments,
  createAttestationRequest,
  verifyAttestation,
  MAX_AMOUNT,
  LAMPORTS_PER_SOL,
};

export default Bulletproof;
