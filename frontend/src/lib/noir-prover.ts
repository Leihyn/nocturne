/**
 * Noir ZK Prover for StealthSol
 *
 * This module provides real ZK proof generation using:
 * - @noir-lang/noir_js for circuit execution
 * - @noir-lang/backend_barretenberg for proof generation
 *
 * Supports deposit and withdrawal proofs for the privacy pool
 *
 * NOTE: Uses dynamic imports to avoid WASM loading during SSR
 */

// Types for the dynamically loaded modules
type NoirModule = typeof import('@noir-lang/noir_js');
type BarretenbergModule = typeof import('@noir-lang/backend_barretenberg');
type CompiledCircuit = import('@noir-lang/noir_js').CompiledCircuit;
type Noir = import('@noir-lang/noir_js').Noir;
type UltraHonkBackend = import('@noir-lang/backend_barretenberg').UltraHonkBackend;

// Circuit artifacts (loaded from public/circuits)
let withdrawCircuit: CompiledCircuit | null = null;
let depositCircuit: CompiledCircuit | null = null;

// Noir instances
let withdrawNoir: Noir | null = null;
let depositNoir: Noir | null = null;

// Barretenberg backends
let withdrawBackend: UltraHonkBackend | null = null;
let depositBackend: UltraHonkBackend | null = null;

// Cached module references (loaded dynamically)
let noirModule: NoirModule | null = null;
let barretenbergModule: BarretenbergModule | null = null;

/**
 * Load a circuit from the public directory
 */
async function loadCircuit(name: 'withdraw' | 'deposit'): Promise<CompiledCircuit> {
  const response = await fetch(`/circuits/${name}.json`);
  if (!response.ok) {
    throw new Error(`Failed to load ${name} circuit: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Check if we're running in a browser environment
 */
function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Dynamically load the Noir and Barretenberg modules
 * Only loads in browser to avoid SSR WASM issues
 */
async function loadNoirModules(): Promise<{ Noir: NoirModule['Noir']; UltraHonkBackend: BarretenbergModule['UltraHonkBackend'] }> {
  if (!isBrowser()) {
    throw new Error('Noir prover can only be initialized in the browser');
  }

  if (!noirModule) {
    noirModule = await import('@noir-lang/noir_js');
  }
  if (!barretenbergModule) {
    barretenbergModule = await import('@noir-lang/backend_barretenberg');
  }

  return {
    Noir: noirModule.Noir,
    UltraHonkBackend: barretenbergModule.UltraHonkBackend,
  };
}

/**
 * Initialize the prover with the required circuits
 * Should be called once when the app starts
 * NOTE: Only works in browser environment due to WASM dependencies
 */
export async function initializeProver(): Promise<void> {
  if (!isBrowser()) {
    throw new Error('Noir prover can only be initialized in the browser');
  }

  console.log('Initializing Noir prover...');

  // Dynamically load Noir modules (avoids SSR WASM issues)
  const { Noir, UltraHonkBackend } = await loadNoirModules();

  // Load circuits in parallel
  const [withdraw, deposit] = await Promise.all([
    loadCircuit('withdraw'),
    loadCircuit('deposit'),
  ]);

  withdrawCircuit = withdraw;
  depositCircuit = deposit;

  // Initialize Noir instances
  withdrawNoir = new Noir(withdrawCircuit);
  depositNoir = new Noir(depositCircuit);

  // Initialize Barretenberg backends (pass the full CompiledCircuit)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withdrawBackend = new UltraHonkBackend(withdrawCircuit as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  depositBackend = new UltraHonkBackend(depositCircuit as any);

  console.log('Noir prover initialized successfully');
}

/**
 * Check if the prover is initialized
 */
export function isProverReady(): boolean {
  return withdrawNoir !== null && depositNoir !== null &&
         withdrawBackend !== null && depositBackend !== null;
}

/**
 * Convert a bigint to a hex string formatted for Noir (0x prefix, 64 chars)
 */
function bigintToNoirField(value: bigint): string {
  const hex = value.toString(16).padStart(64, '0');
  return '0x' + hex;
}

/**
 * Convert a number array (merkle path indices) to Noir format
 */
function pathIndicesToNoir(indices: number[]): string[] {
  return indices.map(i => i.toString());
}

// ============================================
// Withdrawal Proof
// ============================================

export interface WithdrawProofInputs {
  // Public inputs
  merkleRoot: bigint;
  nullifierHash: bigint;
  recipient: bigint;  // Recipient address as field element
  amount: bigint;

  // Private inputs
  nullifier: bigint;
  secret: bigint;
  stealthAddress: bigint;
  merklePath: bigint[];
  pathIndices: number[];
}

export interface WithdrawProof {
  proof: Uint8Array;
  publicInputs: {
    merkleRoot: string;
    nullifierHash: string;
    recipient: string;
    amount: string;
  };
}

/**
 * Generate a withdrawal proof
 */
export async function generateWithdrawProof(inputs: WithdrawProofInputs): Promise<WithdrawProof> {
  if (!withdrawNoir || !withdrawBackend) {
    throw new Error('Prover not initialized. Call initializeProver() first.');
  }

  console.log('Generating withdrawal proof...');

  // Format inputs for Noir circuit
  const witnessInputs = {
    // Public inputs
    merkle_root: bigintToNoirField(inputs.merkleRoot),
    nullifier_hash: bigintToNoirField(inputs.nullifierHash),
    recipient: bigintToNoirField(inputs.recipient),
    amount: bigintToNoirField(inputs.amount),

    // Private inputs
    nullifier: bigintToNoirField(inputs.nullifier),
    secret: bigintToNoirField(inputs.secret),
    stealth_address: bigintToNoirField(inputs.stealthAddress),
    merkle_path: inputs.merklePath.map(bigintToNoirField),
    path_indices: pathIndicesToNoir(inputs.pathIndices),
  };

  // Execute circuit to generate witness
  const { witness } = await withdrawNoir.execute(witnessInputs);

  // Generate proof
  const proof = await withdrawBackend.generateProof(witness);

  console.log('Withdrawal proof generated successfully');

  return {
    proof: proof.proof,
    publicInputs: {
      merkleRoot: bigintToNoirField(inputs.merkleRoot),
      nullifierHash: bigintToNoirField(inputs.nullifierHash),
      recipient: bigintToNoirField(inputs.recipient),
      amount: bigintToNoirField(inputs.amount),
    },
  };
}

/**
 * Verify a withdrawal proof
 */
export async function verifyWithdrawProof(
  proof: Uint8Array,
  publicInputs: string[]
): Promise<boolean> {
  if (!withdrawBackend) {
    throw new Error('Prover not initialized. Call initializeProver() first.');
  }

  console.log('Verifying withdrawal proof...');

  const isValid = await withdrawBackend.verifyProof({
    proof,
    publicInputs,
  });

  console.log('Withdrawal proof verification:', isValid ? 'VALID' : 'INVALID');

  return isValid;
}

// ============================================
// Deposit Proof
// ============================================

export interface DepositProofInputs {
  // Public inputs
  commitment: bigint;

  // Private inputs
  nullifier: bigint;
  secret: bigint;
  amount: bigint;
  recipient: bigint;
}

export interface DepositProof {
  proof: Uint8Array;
  publicInputs: {
    commitment: string;
  };
}

/**
 * Generate a deposit proof
 */
export async function generateDepositProof(inputs: DepositProofInputs): Promise<DepositProof> {
  if (!depositNoir || !depositBackend) {
    throw new Error('Prover not initialized. Call initializeProver() first.');
  }

  console.log('Generating deposit proof...');

  // Format inputs for Noir circuit
  const witnessInputs = {
    // Public inputs
    commitment: bigintToNoirField(inputs.commitment),

    // Private inputs
    nullifier: bigintToNoirField(inputs.nullifier),
    secret: bigintToNoirField(inputs.secret),
    amount: bigintToNoirField(inputs.amount),
    recipient: bigintToNoirField(inputs.recipient),
  };

  // Execute circuit to generate witness
  const { witness } = await depositNoir.execute(witnessInputs);

  // Generate proof
  const proof = await depositBackend.generateProof(witness);

  console.log('Deposit proof generated successfully');

  return {
    proof: proof.proof,
    publicInputs: {
      commitment: bigintToNoirField(inputs.commitment),
    },
  };
}

/**
 * Verify a deposit proof
 */
export async function verifyDepositProof(
  proof: Uint8Array,
  publicInputs: string[]
): Promise<boolean> {
  if (!depositBackend) {
    throw new Error('Prover not initialized. Call initializeProver() first.');
  }

  console.log('Verifying deposit proof...');

  const isValid = await depositBackend.verifyProof({
    proof,
    publicInputs,
  });

  console.log('Deposit proof verification:', isValid ? 'VALID' : 'INVALID');

  return isValid;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Convert a Solana public key (32 bytes) to a field element
 */
export function pubkeyToField(pubkeyBytes: Uint8Array): bigint {
  // Take first 31 bytes to ensure we're within the BN254 field
  let result = BigInt(0);
  for (let i = 0; i < Math.min(pubkeyBytes.length, 31); i++) {
    result = result | (BigInt(pubkeyBytes[i]) << BigInt(i * 8));
  }
  return result;
}

/**
 * Serialize a proof for on-chain submission
 */
export function serializeProof(proof: Uint8Array): string {
  return Buffer.from(proof).toString('base64');
}

/**
 * Deserialize a proof from base64
 */
export function deserializeProof(proofStr: string): Uint8Array {
  return new Uint8Array(Buffer.from(proofStr, 'base64'));
}

/**
 * Get proof size info
 */
export function getProofInfo(proof: Uint8Array): {
  sizeBytes: number;
  sizeKB: string;
} {
  return {
    sizeBytes: proof.length,
    sizeKB: (proof.length / 1024).toFixed(2),
  };
}
