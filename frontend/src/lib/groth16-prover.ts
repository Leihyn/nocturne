/**
 * Groth16 ZK Prover for StealthSol
 *
 * Uses snarkjs to generate Groth16 proofs that can be verified
 * on-chain using Solana's alt_bn128 syscalls.
 *
 * This replaces the UltraHonk/Barretenberg prover for trustless
 * on-chain verification (no oracle needed).
 */

import * as snarkjs from 'snarkjs';

// ============================================
// Types
// ============================================

export interface Groth16Proof {
  pi_a: [string, string, string];  // G1 point (affine + 1)
  pi_b: [[string, string], [string, string], [string, string]];  // G2 point
  pi_c: [string, string, string];  // G1 point
  protocol: 'groth16';
  curve: 'bn128';
}

export interface Groth16ProofForSolana {
  pi_a: number[];  // 64 bytes
  pi_b: number[];  // 128 bytes
  pi_c: number[];  // 64 bytes
}

export interface WithdrawInputs {
  // Public inputs
  merkleRoot: bigint;
  nullifierHash: bigint;
  recipient: bigint;
  amount: bigint;

  // Private inputs
  nullifier: bigint;
  secret: bigint;
  pathElements: bigint[];
  pathIndices: number[];
}

export interface DepositInputs {
  // Public input
  commitment: bigint;

  // Private inputs
  nullifier: bigint;
  secret: bigint;
  amount: bigint;
  recipient: bigint;
}

export interface ProofResult {
  proof: Groth16ProofForSolana;
  publicSignals: string[];
}

// ============================================
// Circuit Artifacts
// ============================================

let withdrawWasm: ArrayBuffer | null = null;
let withdrawZkey: ArrayBuffer | null = null;
let withdrawVk: any = null;

let depositWasm: ArrayBuffer | null = null;
let depositZkey: ArrayBuffer | null = null;
let depositVk: any = null;

let initialized = false;

// ============================================
// Initialization
// ============================================

/**
 * Load circuit artifacts from the server
 */
export async function initializeGroth16Prover(): Promise<void> {
  if (initialized) return;

  console.log('Initializing Groth16 prover...');

  try {
    // Load withdraw circuit artifacts
    const [
      withdrawWasmResponse,
      withdrawZkeyResponse,
      withdrawVkResponse,
      depositWasmResponse,
      depositZkeyResponse,
      depositVkResponse,
    ] = await Promise.all([
      fetch('/circuits/groth16/withdraw/withdraw_js/withdraw.wasm'),
      fetch('/circuits/groth16/withdraw/withdraw_final.zkey'),
      fetch('/circuits/groth16/withdraw/verification_key.json'),
      fetch('/circuits/groth16/deposit/deposit_js/deposit.wasm'),
      fetch('/circuits/groth16/deposit/deposit_final.zkey'),
      fetch('/circuits/groth16/deposit/verification_key.json'),
    ]);

    withdrawWasm = await withdrawWasmResponse.arrayBuffer();
    withdrawZkey = await withdrawZkeyResponse.arrayBuffer();
    withdrawVk = await withdrawVkResponse.json();

    depositWasm = await depositWasmResponse.arrayBuffer();
    depositZkey = await depositZkeyResponse.arrayBuffer();
    depositVk = await depositVkResponse.json();

    initialized = true;
    console.log('Groth16 prover initialized');
  } catch (err) {
    console.error('Failed to initialize Groth16 prover:', err);
    throw new Error('Failed to load circuit artifacts. Run the trusted setup first.');
  }
}

/**
 * Check if prover is ready
 */
export function isGroth16ProverReady(): boolean {
  return initialized;
}

// ============================================
// Proof Generation
// ============================================

/**
 * Generate a withdrawal proof
 */
export async function generateWithdrawProof(inputs: WithdrawInputs): Promise<ProofResult> {
  if (!initialized || !withdrawWasm || !withdrawZkey) {
    throw new Error('Prover not initialized');
  }

  console.log('Generating withdrawal proof...');

  // Format inputs for snarkjs
  const circuitInputs = {
    merkleRoot: inputs.merkleRoot.toString(),
    nullifierHash: inputs.nullifierHash.toString(),
    recipient: inputs.recipient.toString(),
    amount: inputs.amount.toString(),
    nullifier: inputs.nullifier.toString(),
    secret: inputs.secret.toString(),
    pathElements: inputs.pathElements.map(e => e.toString()),
    pathIndices: inputs.pathIndices.map(i => i.toString()),
  };

  // Generate proof
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    new Uint8Array(withdrawWasm),
    new Uint8Array(withdrawZkey)
  );

  console.log('Withdrawal proof generated');

  return {
    proof: convertProofToSolana(proof as unknown as Groth16Proof),
    publicSignals,
  };
}

/**
 * Generate a deposit proof
 */
export async function generateDepositProof(inputs: DepositInputs): Promise<ProofResult> {
  if (!initialized || !depositWasm || !depositZkey) {
    throw new Error('Prover not initialized');
  }

  console.log('Generating deposit proof...');

  const circuitInputs = {
    commitment: inputs.commitment.toString(),
    nullifier: inputs.nullifier.toString(),
    secret: inputs.secret.toString(),
    amount: inputs.amount.toString(),
    recipient: inputs.recipient.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    new Uint8Array(depositWasm),
    new Uint8Array(depositZkey)
  );

  console.log('Deposit proof generated');

  return {
    proof: convertProofToSolana(proof as unknown as Groth16Proof),
    publicSignals,
  };
}

// ============================================
// Proof Verification (Client-side)
// ============================================

/**
 * Verify a withdrawal proof locally
 */
export async function verifyWithdrawProof(
  proof: Groth16Proof,
  publicSignals: string[]
): Promise<boolean> {
  if (!withdrawVk) {
    throw new Error('Prover not initialized');
  }

  return snarkjs.groth16.verify(withdrawVk, publicSignals, proof);
}

/**
 * Verify a deposit proof locally
 */
export async function verifyDepositProof(
  proof: Groth16Proof,
  publicSignals: string[]
): Promise<boolean> {
  if (!depositVk) {
    throw new Error('Prover not initialized');
  }

  return snarkjs.groth16.verify(depositVk, publicSignals, proof);
}

// ============================================
// Proof Format Conversion
// ============================================

/**
 * Convert snarkjs proof to Solana-compatible byte arrays
 */
function convertProofToSolana(proof: Groth16Proof): Groth16ProofForSolana {
  return {
    pi_a: g1PointToBytes(proof.pi_a),
    pi_b: g2PointToBytes(proof.pi_b),
    pi_c: g1PointToBytes(proof.pi_c),
  };
}

/**
 * Convert G1 point to 64 bytes (x: 32, y: 32)
 */
function g1PointToBytes(point: [string, string, string]): number[] {
  const x = bigintToBytes32(BigInt(point[0]));
  const y = bigintToBytes32(BigInt(point[1]));
  return [...x, ...y];
}

/**
 * Convert G2 point to 128 bytes
 * G2 in BN254 uses Fp2, so each coordinate is 64 bytes
 *
 * snarkjs format: [[x_c0, x_c1], [y_c0, y_c1], [z_c0, z_c1]]
 * Solana alt_bn128 expects: x_c1 || x_c0 || y_c1 || y_c0 (imaginary part first)
 */
function g2PointToBytes(point: [[string, string], [string, string], [string, string]]): number[] {
  // snarkjs gives us [c0, c1] but Solana expects [c1, c0] (imaginary first)
  const x_c0 = bigintToBytes32(BigInt(point[0][0]));
  const x_c1 = bigintToBytes32(BigInt(point[0][1]));
  const y_c0 = bigintToBytes32(BigInt(point[1][0]));
  const y_c1 = bigintToBytes32(BigInt(point[1][1]));
  // Return in Solana's expected order: x_c1 || x_c0 || y_c1 || y_c0
  return [...x_c1, ...x_c0, ...y_c1, ...y_c0];
}

/**
 * Convert bigint to 32-byte big-endian array
 */
function bigintToBytes32(n: bigint): number[] {
  const hex = n.toString(16).padStart(64, '0');
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}

/**
 * Convert public signals to 32-byte arrays for Solana
 */
export function publicSignalsToBytes(signals: string[]): number[][] {
  return signals.map(s => bigintToBytes32(BigInt(s)));
}

// ============================================
// Utility Functions
// ============================================

// Cache the Poseidon instance to avoid rebuilding on every hash
let poseidonInstance: any = null;
let poseidonPromise: Promise<any> | null = null;

async function getPoseidon() {
  if (poseidonInstance) return poseidonInstance;
  if (poseidonPromise) return poseidonPromise;

  poseidonPromise = (async () => {
    const { buildPoseidon } = await import('circomlibjs');
    poseidonInstance = await buildPoseidon();
    return poseidonInstance;
  })();

  return poseidonPromise;
}

/**
 * Compute Poseidon hash (matches circuit)
 * Caches the Poseidon instance for performance
 */
export async function computePoseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const hash = poseidon(inputs.map(i => i.toString()));
  return BigInt(poseidon.F.toString(hash));
}

/**
 * Generate a random field element
 */
export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  // BN254 scalar field modulus
  const FIELD_MODULUS = BigInt(
    '21888242871839275222246405745257275088548364400416034343698204186575808495617'
  );

  let value = BigInt(0);
  for (let i = 0; i < 32; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }

  return value % FIELD_MODULUS;
}

/**
 * Generate nullifier and secret for a new deposit
 */
export function generateDepositSecrets(): {
  nullifier: bigint;
  secret: bigint;
} {
  return {
    nullifier: randomFieldElement(),
    secret: randomFieldElement(),
  };
}

// ============================================
// Exports
// ============================================

export { convertProofToSolana, bigintToBytes32 };
