/**
 * Client for the StealthSol off-chain ZK proof verifier
 *
 * This module handles communication with the verifier service
 * to get attestations for ZK proofs.
 */

// Verifier service URL - configurable via environment
const VERIFIER_URL = process.env.NEXT_PUBLIC_VERIFIER_URL || 'http://localhost:3001';

export interface Attestation {
  proofHash: number[];
  publicInputsHash: number[];
  verifier: number[];
  signature: number[];
  verifiedAt: number;
}

export interface VerifyWithdrawRequest {
  proof: number[] | string; // Uint8Array as number[] or base64
  publicInputs: {
    merkleRoot: string;
    nullifierHash: string;
    recipient: string;
    amount: string;
  };
}

export interface VerifyDepositRequest {
  proof: number[] | string;
  publicInputs: {
    commitment: string;
  };
}

export interface VerifyResponse {
  valid: boolean;
  attestation?: Attestation;
  verifierPubkey?: string;
  error?: string;
}

export interface VerifierInfo {
  verifierPubkey: string;
  verifierPubkeyBytes: number[];
  attestationExpiry: number;
  supportedCircuits: string[];
}

/**
 * Get verifier info
 */
export async function getVerifierInfo(): Promise<VerifierInfo> {
  const response = await fetch(`${VERIFIER_URL}/info`);
  if (!response.ok) {
    throw new Error(`Failed to get verifier info: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Check verifier health
 */
export async function checkVerifierHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${VERIFIER_URL}/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Verify a withdrawal proof and get attestation
 */
export async function verifyWithdrawProof(
  proof: Uint8Array,
  publicInputs: {
    merkleRoot: string;
    nullifierHash: string;
    recipient: string;
    amount: string;
  }
): Promise<VerifyResponse> {
  const response = await fetch(`${VERIFIER_URL}/verify/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      proof: Array.from(proof),
      publicInputs,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return {
      valid: false,
      error: data.error || 'Verification failed',
    };
  }

  return data;
}

/**
 * Verify a deposit proof and get attestation
 */
export async function verifyDepositProof(
  proof: Uint8Array,
  publicInputs: {
    commitment: string;
  }
): Promise<VerifyResponse> {
  const response = await fetch(`${VERIFIER_URL}/verify/deposit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      proof: Array.from(proof),
      publicInputs,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return {
      valid: false,
      error: data.error || 'Verification failed',
    };
  }

  return data;
}

/**
 * Convert attestation to bytes for on-chain submission
 */
export function attestationToBytes(attestation: Attestation): Uint8Array {
  // Format: proof_hash (32) + public_inputs_hash (32) + verifier (32) + signature (64) + verified_at (8)
  const bytes = new Uint8Array(32 + 32 + 32 + 64 + 8);
  let offset = 0;

  // proof_hash
  for (let i = 0; i < 32; i++) {
    bytes[offset++] = attestation.proofHash[i] || 0;
  }

  // public_inputs_hash
  for (let i = 0; i < 32; i++) {
    bytes[offset++] = attestation.publicInputsHash[i] || 0;
  }

  // verifier pubkey
  for (let i = 0; i < 32; i++) {
    bytes[offset++] = attestation.verifier[i] || 0;
  }

  // signature
  for (let i = 0; i < 64; i++) {
    bytes[offset++] = attestation.signature[i] || 0;
  }

  // verified_at (little-endian i64)
  const view = new DataView(bytes.buffer);
  view.setBigInt64(offset, BigInt(attestation.verifiedAt), true);

  return bytes;
}

/**
 * Parse hex string to bytes
 */
function hexToBytes(hex: string): number[] {
  const cleanHex = hex.replace('0x', '');
  const bytes: number[] = [];
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes.push(parseInt(cleanHex.slice(i, i + 2), 16));
  }
  return bytes;
}

// ============================================
// Range Proof Verification
// ============================================

export interface RangeProofAttestation {
  commitmentHash: number[];
  amountRange: [string, string];
  signature: number[];
  verifier: number[];
  verifiedAt: number;
}

export interface RangeProofResponse {
  valid: boolean;
  attestation?: RangeProofAttestation;
  verifierPubkey?: string;
  error?: string;
}

/**
 * Verify a range proof for a Pedersen commitment
 */
export async function verifyRangeProof(
  commitment: Uint8Array,
  rangeProof: Uint8Array,
  amount?: bigint
): Promise<RangeProofResponse> {
  const response = await fetch(`${VERIFIER_URL}/verify/range-proof`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      commitment: Array.from(commitment),
      rangeProof: Array.from(rangeProof),
      amount: amount?.toString(),
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return {
      valid: false,
      error: data.error || 'Range proof verification failed',
    };
  }

  return data;
}

/**
 * Format range proof attestation for on-chain submission
 */
export function formatRangeProofAttestationForChain(attestation: RangeProofAttestation): {
  commitmentHash: Uint8Array;
  amountRange: [bigint, bigint];
  signature: Uint8Array;
  verifier: Uint8Array;
  verifiedAt: bigint;
} {
  return {
    commitmentHash: new Uint8Array(
      typeof attestation.commitmentHash === 'string'
        ? hexToBytes(attestation.commitmentHash)
        : attestation.commitmentHash
    ),
    amountRange: [
      BigInt(attestation.amountRange[0]),
      BigInt(attestation.amountRange[1]),
    ],
    signature: new Uint8Array(attestation.signature),
    verifier: new Uint8Array(attestation.verifier),
    verifiedAt: BigInt(attestation.verifiedAt),
  };
}

/**
 * Convert attestation from API response format to on-chain format
 */
export function formatAttestationForChain(attestation: Attestation): {
  proofHash: Uint8Array;
  publicInputsHash: Uint8Array;
  verifier: Uint8Array;
  signature: Uint8Array;
  verifiedAt: bigint;
} {
  return {
    proofHash: new Uint8Array(
      typeof attestation.proofHash === 'string'
        ? hexToBytes(attestation.proofHash)
        : attestation.proofHash
    ),
    publicInputsHash: new Uint8Array(
      typeof attestation.publicInputsHash === 'string'
        ? hexToBytes(attestation.publicInputsHash)
        : attestation.publicInputsHash
    ),
    verifier: new Uint8Array(attestation.verifier),
    signature: new Uint8Array(attestation.signature),
    verifiedAt: BigInt(attestation.verifiedAt),
  };
}
