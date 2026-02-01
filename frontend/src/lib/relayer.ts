/**
 * Relayer Service for Anonymous Withdrawals
 *
 * The relayer submits transactions on behalf of users, hiding the user's
 * IP address and wallet from the transaction. This is the final piece
 * for complete privacy:
 *
 * Without relayer:
 * - Amount: HIDDEN (fixed denomination)
 * - Deposit↔Withdrawal link: HIDDEN (ZK proof)
 * - Recipient: HIDDEN (stealth address)
 * - Transaction submitter: VISIBLE ❌
 *
 * With relayer:
 * - Amount: HIDDEN (fixed denomination)
 * - Deposit↔Withdrawal link: HIDDEN (ZK proof)
 * - Recipient: HIDDEN (stealth address)
 * - Transaction submitter: HIDDEN ✅ (relayer submits)
 *
 * Privacy Score: 99%
 */

import { Connection, PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  buildPrivateWithdrawInstruction,
  type PrivateWithdrawParams,
  type StealthAddressParams,
  getPoolConfig,
} from './program';

// ============================================
// Types
// ============================================

export interface RelayerInfo {
  address: string;
  feeBps: number;        // Fee in basis points (100 = 1%)
  minFee: bigint;        // Minimum fee in lamports
  maxFee: bigint;        // Maximum fee in lamports
  supportedDenominations: bigint[];
  isActive: boolean;
  endpoint: string;      // API endpoint
}

export interface RelayRequest {
  // Withdrawal parameters
  denomination: bigint;
  proof: Uint8Array;
  merkleRoot: Uint8Array;
  nullifierHash: Uint8Array;
  stealth: StealthAddressParams;

  // Signature from the depositor proving they own the note
  // This prevents griefing attacks where someone steals your proof
  signature?: Uint8Array;
}

export interface RelayResponse {
  success: boolean;
  txSignature?: string;
  error?: string;
  fee?: bigint;
}

// ============================================
// Local Relayer (For Development/Testing)
// ============================================

/**
 * Local relayer that uses the connected wallet to submit transactions
 * This is useful for development and testing without a real relayer
 */
export class LocalRelayer {
  private connection: Connection;
  private feeBps: number;

  constructor(connection: Connection, feeBps: number = 50) { // 0.5% default
    this.connection = connection;
    this.feeBps = feeBps;
  }

  /**
   * Calculate the relayer fee for a withdrawal
   */
  calculateFee(denomination: bigint): bigint {
    const fee = (denomination * BigInt(this.feeBps)) / BigInt(10000);
    return fee;
  }

  /**
   * Submit a withdrawal transaction via the local wallet
   * This simulates what a real relayer would do
   */
  async submitWithdrawal(
    request: RelayRequest,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    relayerPublicKey: PublicKey
  ): Promise<RelayResponse> {
    try {
      const fee = this.calculateFee(request.denomination);

      console.log(`[LocalRelayer] Submitting withdrawal for ${Number(request.denomination) / LAMPORTS_PER_SOL} SOL`);
      console.log(`[LocalRelayer] Fee: ${Number(fee) / LAMPORTS_PER_SOL} SOL (${this.feeBps} bps)`);

      // Build the withdrawal instruction
      const withdrawParams: PrivateWithdrawParams = {
        relayer: relayerPublicKey,
        stealth: request.stealth,
        denomination: request.denomination,
        proof: request.proof,
        merkleRoot: request.merkleRoot,
        nullifierHash: request.nullifierHash,
        relayerFee: fee,
      };

      const instruction = buildPrivateWithdrawInstruction(withdrawParams);

      // Build transaction
      const transaction = new Transaction().add(instruction);
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = relayerPublicKey;

      // Sign and send
      const signedTx = await signTransaction(transaction);
      const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      console.log(`[LocalRelayer] Withdrawal successful: ${signature}`);

      return {
        success: true,
        txSignature: signature,
        fee,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[LocalRelayer] Withdrawal failed:', error);
      return { success: false, error };
    }
  }
}

// ============================================
// HTTP Relayer Client (For Production)
// ============================================

/**
 * HTTP client for communicating with a remote relayer service
 */
export class RelayerClient {
  private endpoint: string;
  private timeout: number;

  constructor(endpoint: string, timeout: number = 30000) {
    this.endpoint = endpoint;
    this.timeout = timeout;
  }

  /**
   * Get relayer information
   */
  async getInfo(): Promise<RelayerInfo | null> {
    try {
      const response = await fetch(`${this.endpoint}/info`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    } catch (err) {
      console.error('[RelayerClient] Failed to get info:', err);
      return null;
    }
  }

  /**
   * Submit a withdrawal request to the relayer
   */
  async submitWithdrawal(request: RelayRequest): Promise<RelayResponse> {
    try {
      console.log(`[RelayerClient] Submitting withdrawal to ${this.endpoint}`);

      const response = await fetch(`${this.endpoint}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          denomination: request.denomination.toString(),
          proof: Buffer.from(request.proof).toString('base64'),
          merkleRoot: Buffer.from(request.merkleRoot).toString('base64'),
          nullifierHash: Buffer.from(request.nullifierHash).toString('base64'),
          stealth: {
            stealthAddress: request.stealth.stealthAddress.toBase58(),
            ephemeralPubkey: Buffer.from(request.stealth.ephemeralPubkey).toString('base64'),
            scanPubkey: Buffer.from(request.stealth.scanPubkey).toString('base64'),
            spendPubkey: Buffer.from(request.stealth.spendPubkey).toString('base64'),
            stealthCommitment: Buffer.from(request.stealth.stealthCommitment).toString('base64'),
          },
          signature: request.signature ? Buffer.from(request.signature).toString('base64') : undefined,
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      return {
        success: true,
        txSignature: result.txSignature,
        fee: BigInt(result.fee || '0'),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[RelayerClient] Withdrawal failed:', error);
      return { success: false, error };
    }
  }

  /**
   * Check withdrawal status by nullifier hash
   */
  async checkStatus(nullifierHash: Uint8Array): Promise<{
    status: 'pending' | 'completed' | 'failed' | 'not_found';
    txSignature?: string;
    error?: string;
  }> {
    try {
      const response = await fetch(`${this.endpoint}/status/${Buffer.from(nullifierHash).toString('hex')}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return { status: 'not_found' };
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    } catch (err) {
      console.error('[RelayerClient] Status check failed:', err);
      return { status: 'not_found' };
    }
  }
}

// ============================================
// Relayer Discovery
// ============================================

// Known relayer endpoints (for production, this would be fetched from on-chain registry)
const KNOWN_RELAYERS: string[] = [
  // Add production relayer endpoints here
  // 'https://relayer1.stealthsol.io',
  // 'https://relayer2.stealthsol.io',
];

/**
 * Discover available relayers
 */
export async function discoverRelayers(): Promise<RelayerInfo[]> {
  const relayers: RelayerInfo[] = [];

  for (const endpoint of KNOWN_RELAYERS) {
    const client = new RelayerClient(endpoint);
    const info = await client.getInfo();
    if (info && info.isActive) {
      relayers.push(info);
    }
  }

  return relayers;
}

/**
 * Find the best relayer for a withdrawal
 * Selects based on fee and supported denominations
 */
export async function findBestRelayer(denomination: bigint): Promise<RelayerInfo | null> {
  const relayers = await discoverRelayers();

  // Filter relayers that support the denomination
  const compatible = relayers.filter(r =>
    r.supportedDenominations.some(d => d === denomination)
  );

  if (compatible.length === 0) {
    return null;
  }

  // Sort by fee (lowest first)
  compatible.sort((a, b) => a.feeBps - b.feeBps);

  return compatible[0];
}

// ============================================
// Integrated Withdrawal with Relayer
// ============================================

export interface WithdrawWithRelayerOptions {
  connection: Connection;
  denomination: bigint;
  proof: Uint8Array;
  merkleRoot: Uint8Array;
  nullifierHash: Uint8Array;
  stealth: StealthAddressParams;

  // Optional: use specific relayer
  relayerEndpoint?: string;

  // Optional: for local relayer mode
  localRelayer?: {
    publicKey: PublicKey;
    signTransaction: (tx: Transaction) => Promise<Transaction>;
  };
}

/**
 * Withdraw with relayer for maximum privacy
 */
export async function withdrawWithRelayer(
  options: WithdrawWithRelayerOptions
): Promise<RelayResponse> {
  const {
    connection,
    denomination,
    proof,
    merkleRoot,
    nullifierHash,
    stealth,
    relayerEndpoint,
    localRelayer,
  } = options;

  // If local relayer is provided, use it (for testing)
  if (localRelayer) {
    console.log('[Relayer] Using local relayer mode');
    const relayer = new LocalRelayer(connection);
    return relayer.submitWithdrawal(
      { denomination, proof, merkleRoot, nullifierHash, stealth },
      localRelayer.signTransaction,
      localRelayer.publicKey
    );
  }

  // Use remote relayer
  const endpoint = relayerEndpoint || await findBestRelayerEndpoint(denomination);

  if (!endpoint) {
    return {
      success: false,
      error: 'No relayer available for this denomination. Try local relayer mode.',
    };
  }

  console.log(`[Relayer] Using remote relayer: ${endpoint}`);
  const client = new RelayerClient(endpoint);

  return client.submitWithdrawal({
    denomination,
    proof,
    merkleRoot,
    nullifierHash,
    stealth,
  });
}

async function findBestRelayerEndpoint(denomination: bigint): Promise<string | null> {
  const relayer = await findBestRelayer(denomination);
  return relayer?.endpoint || null;
}

// ============================================
// Groth16 Relayer Client (Trustless On-Chain Verification)
// ============================================

/**
 * Request for Groth16 withdrawal via relayer
 * Uses on-chain proof verification (no oracle needed)
 */
export interface Groth16RelayRequest {
  // Groth16 proof
  piA: Uint8Array;  // 64 bytes (G1 point)
  piB: Uint8Array;  // 128 bytes (G2 point)
  piC: Uint8Array;  // 64 bytes (G1 point)

  // Public inputs
  merkleRoot: Uint8Array;     // 32 bytes
  nullifierHash: Uint8Array;  // 32 bytes
  recipient: string;          // Base58 public key
  amount: bigint;             // Amount in lamports

  // Pool denomination
  denomination: bigint;
}

/**
 * Client for submitting Groth16 withdrawals via relayer
 * Proofs are verified ON-CHAIN using Solana's alt_bn128 precompiles
 */
export class Groth16RelayerClient {
  private endpoint: string;
  private timeout: number;

  constructor(endpoint: string, timeout: number = 60000) {
    this.endpoint = endpoint;
    this.timeout = timeout;
  }

  /**
   * Get relayer information
   */
  async getInfo(): Promise<{
    address: string;
    balance: number;
    feePercent: number;
    minFeeSol: number;
    program: string;
  } | null> {
    try {
      const response = await fetch(`${this.endpoint}/info`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return response.json();
    } catch (err) {
      console.error('[Groth16RelayerClient] Failed to get info:', err);
      return null;
    }
  }

  /**
   * Submit a Groth16 withdrawal request
   * The proof will be verified ON-CHAIN (trustless)
   */
  async submitWithdrawal(request: Groth16RelayRequest): Promise<RelayResponse> {
    try {
      console.log(`[Groth16RelayerClient] Submitting withdrawal to ${this.endpoint}/relay-groth16`);
      console.log(`  Recipient: ${request.recipient}`);
      console.log(`  Amount: ${Number(request.amount) / LAMPORTS_PER_SOL} SOL`);

      const response = await fetch(`${this.endpoint}/relay-groth16`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          piA: Array.from(request.piA),
          piB: Array.from(request.piB),
          piC: Array.from(request.piC),
          merkleRoot: Array.from(request.merkleRoot),
          nullifierHash: Array.from(request.nullifierHash),
          recipient: request.recipient,
          amount: request.amount.toString(),
          denomination: request.denomination.toString(),
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      console.log(`[Groth16RelayerClient] Withdrawal successful: ${result.signature}`);

      return {
        success: true,
        txSignature: result.signature,
        fee: BigInt(Math.floor(result.fee * LAMPORTS_PER_SOL)),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Groth16RelayerClient] Withdrawal failed:', error);
      return { success: false, error };
    }
  }
}

/**
 * Withdraw with Groth16 proof via relayer (maximum privacy + trustless)
 *
 * Privacy Properties:
 * - Amount: HIDDEN (fixed denomination)
 * - Deposit↔Withdrawal: HIDDEN (ZK proof)
 * - Recipient: Can be stealth address
 * - Submitter: HIDDEN (relayer)
 * - Verification: TRUSTLESS (on-chain Groth16)
 */
export async function withdrawWithGroth16Relayer(
  relayerEndpoint: string,
  request: Groth16RelayRequest
): Promise<RelayResponse> {
  const client = new Groth16RelayerClient(relayerEndpoint);
  return client.submitWithdrawal(request);
}

// ============================================
// Relayer Fee Estimation
// ============================================

/**
 * Estimate the total cost of a withdrawal including relayer fee
 */
export async function estimateWithdrawalCost(
  denomination: bigint,
  relayerEndpoint?: string
): Promise<{
  denomination: bigint;
  relayerFee: bigint;
  networkFee: bigint;
  totalCost: bigint;
  amountReceived: bigint;
}> {
  const networkFee = BigInt(5000); // ~0.000005 SOL network fee estimate

  let relayerFee = BigInt(0);

  if (relayerEndpoint) {
    const client = new RelayerClient(relayerEndpoint);
    const info = await client.getInfo();
    if (info) {
      relayerFee = (denomination * BigInt(info.feeBps)) / BigInt(10000);
      relayerFee = relayerFee < info.minFee ? info.minFee : relayerFee;
      relayerFee = relayerFee > info.maxFee ? info.maxFee : relayerFee;
    }
  } else {
    // Default 0.5% fee estimate
    relayerFee = (denomination * BigInt(50)) / BigInt(10000);
  }

  const totalCost = relayerFee + networkFee;
  const amountReceived = denomination - totalCost;

  return {
    denomination,
    relayerFee,
    networkFee,
    totalCost,
    amountReceived,
  };
}
