/**
 * TEE Encryption Utilities
 *
 * Provides encryption for TEE relayer requests.
 * Requests are encrypted with the TEE's public key using NaCl box encryption.
 * Only the TEE can decrypt them - even the relayer operator can't see the contents.
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

const VERIFIER_URL = process.env.NEXT_PUBLIC_VERIFIER_URL || 'http://localhost:3001';

/**
 * TEE public key cache
 */
let cachedTeePubkey: Uint8Array | null = null;
let cachedRelayerWallet: string | null = null;

/**
 * Fetch TEE public key from verifier service
 */
export async function getTeePubkey(): Promise<{ teePubkey: Uint8Array; relayerWallet: string }> {
  if (cachedTeePubkey && cachedRelayerWallet) {
    return { teePubkey: cachedTeePubkey, relayerWallet: cachedRelayerWallet };
  }

  const response = await fetch(`${VERIFIER_URL}/tee/pubkey`);
  if (!response.ok) {
    throw new Error('Failed to fetch TEE public key');
  }

  const data = await response.json();
  cachedTeePubkey = new Uint8Array(data.teePubkeyBytes);
  cachedRelayerWallet = data.relayerWallet;

  return { teePubkey: cachedTeePubkey, relayerWallet: cachedRelayerWallet! };
}

/**
 * Attestation data for the withdrawal
 */
export interface WithdrawalAttestation {
  proofHash: string;
  publicInputsHash: string;
  verifier: string;
  signature: string;
  verifiedAt: string;
}

/**
 * Withdrawal request to be encrypted
 */
export interface WithdrawalRequest {
  stealthAddress: string;
  nullifierHash: string;
  denomination: number;
  merkleRoot: string;
  ephemeralPubkey: string;
  scanPubkey: string;
  spendPubkey: string;
  stealthCommitment: string;
  attestation?: WithdrawalAttestation; // Attestation for verifier to build tx
  serializedTx?: string; // Pre-built transaction (base64) - DEPRECATED, use attestation instead
}

/**
 * Encrypted request ready for submission
 */
export interface EncryptedRequest {
  encryptedRequest: number[];
  nonce: number[];
  senderPubkey: number[];
}

/**
 * Encrypt a withdrawal request for the TEE
 *
 * Uses NaCl box encryption (X25519-XSalsa20-Poly1305):
 * - Generates ephemeral keypair
 * - Derives shared secret with TEE pubkey
 * - Encrypts with authenticated encryption
 *
 * Only the TEE can decrypt (has the private key)
 */
export async function encryptForTee(request: WithdrawalRequest): Promise<EncryptedRequest> {
  const { teePubkey } = await getTeePubkey();

  // Generate ephemeral keypair for this request
  const ephemeralKeypair = nacl.box.keyPair();

  // Serialize the request (handle BigInt values)
  const requestJson = JSON.stringify(request, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
  const requestBytes = new TextEncoder().encode(requestJson);

  // Generate random nonce
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  // Encrypt with TEE public key
  const encrypted = nacl.box(
    requestBytes,
    nonce,
    teePubkey,
    ephemeralKeypair.secretKey
  );

  if (!encrypted) {
    throw new Error('Encryption failed');
  }

  return {
    encryptedRequest: Array.from(encrypted),
    nonce: Array.from(nonce),
    senderPubkey: Array.from(ephemeralKeypair.publicKey),
  };
}

/**
 * Submit encrypted withdrawal request to TEE relayer
 */
export async function submitEncryptedWithdrawal(
  request: WithdrawalRequest
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    console.log('[TEE] Encrypting withdrawal request...');

    // Encrypt the request
    const encrypted = await encryptForTee(request);

    console.log('[TEE] Encrypted request size:', encrypted.encryptedRequest.length, 'bytes');
    console.log('[TEE] Submitting to TEE relayer...');

    // Submit to relayer
    const response = await fetch(`${VERIFIER_URL}/tee/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encrypted),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[TEE] Relay failed:', result.error);
      return { success: false, error: result.error };
    }

    console.log('[TEE] Withdrawal relayed successfully!');
    console.log('[TEE] Signature:', result.signature);

    return { success: true, signature: result.signature };
  } catch (err: any) {
    console.error('[TEE] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Simple relay (no encryption) for testing
 * Relayer will pay fees but can see the transaction contents
 */
export async function submitSimpleRelay(
  serializedTx: string
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    console.log('[Relayer] Submitting transaction for relay...');

    const response = await fetch(`${VERIFIER_URL}/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serializedTx }),
    });

    const result = await response.json();

    if (!response.ok) {
      return { success: false, error: result.error };
    }

    console.log('[Relayer] Transaction relayed!');
    return { success: true, signature: result.signature };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if TEE relay is available
 */
export async function isTeeRelayAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${VERIFIER_URL}/health`);
    const data = await response.json();
    return data.teeRelay === true;
  } catch {
    return false;
  }
}
