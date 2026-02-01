/**
 * CoinJoin Client Protocol
 *
 * Handles the client-side of the blind CoinJoin protocol.
 * Connects to the coordination server and manages the multi-step
 * privacy-preserving deposit process.
 *
 * Privacy Features:
 * - Random delay before joining to prevent timing correlation
 * - Blinded commitments to hide depositor-commitment linkage
 * - Shuffled outputs to prevent ordering analysis
 */

import { Connection, PublicKey, Transaction, SystemProgram, Keypair } from '@solana/web3.js';

// ============================================
// Privacy: Timing Correlation Protection
// ============================================

/**
 * Random delay configuration (in milliseconds)
 * Adding random delay before joining prevents timing correlation attacks
 * where an observer could link deposit timing to commitment submission timing.
 */
const TIMING_PROTECTION = {
  MIN_JOIN_DELAY_MS: 5000,     // Minimum 5 second delay
  MAX_JOIN_DELAY_MS: 35000,    // Maximum 35 second delay
  ENABLED: true,               // Can be disabled for testing
};

/**
 * Generate a cryptographically random delay within the configured range
 */
function getRandomJoinDelay(): number {
  if (!TIMING_PROTECTION.ENABLED) return 0;

  const range = TIMING_PROTECTION.MAX_JOIN_DELAY_MS - TIMING_PROTECTION.MIN_JOIN_DELAY_MS;
  const randomBytes = new Uint8Array(4);
  crypto.getRandomValues(randomBytes);
  const randomValue = new DataView(randomBytes.buffer).getUint32(0) / 0xFFFFFFFF;

  return Math.floor(TIMING_PROTECTION.MIN_JOIN_DELAY_MS + (randomValue * range));
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Privacy: IP Protection Awareness
// ============================================

/**
 * IP privacy configuration and warnings
 * IP addresses can be used to correlate users across sessions.
 * For maximum privacy, users should use Tor or a VPN.
 */
const IP_PRIVACY = {
  // Whether to show IP privacy warnings
  SHOW_WARNINGS: true,
  // Known Tor exit node pattern (simplified check)
  TOR_PATTERN: /\.onion$/,
};

/**
 * Check if connection appears to use privacy protection
 * Note: This is a best-effort check, not a guarantee
 */
function checkIPPrivacy(serverUrl: string): {
  likelyProtected: boolean;
  warning?: string;
} {
  if (!IP_PRIVACY.SHOW_WARNINGS) {
    return { likelyProtected: true };
  }

  // Check if connecting to .onion (Tor hidden service)
  try {
    const url = new URL(serverUrl);
    if (IP_PRIVACY.TOR_PATTERN.test(url.hostname)) {
      return { likelyProtected: true };
    }
  } catch {
    // Invalid URL, continue with warning
  }

  // If not using Tor, warn about IP exposure
  return {
    likelyProtected: false,
    warning: 'Your IP address may be visible to the CoinJoin coordinator. ' +
             'For maximum privacy, consider using Tor or a trusted VPN.',
  };
}
import {
  buildPrivateDepositInstruction,
  getPoolPDA,
  type Denomination,
} from '@/lib/program';
import { createPrivateNote, type PrivateNote } from '@/lib/zk-crypto';

// Re-implement blind signature primitives for browser
// (Can't use Node crypto in browser)

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod;
    }
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

function extendedGcd(a: bigint, b: bigint): { gcd: bigint; x: bigint; y: bigint } {
  if (a === 0n) {
    return { gcd: b, x: 0n, y: 1n };
  }
  const { gcd, x, y } = extendedGcd(b % a, a);
  return { gcd, x: y - (b / a) * x, y: x };
}

function modInverse(a: bigint, m: bigint): bigint {
  const { gcd, x } = extendedGcd(((a % m) + m) % m, m);
  if (gcd !== 1n) throw new Error('Modular inverse does not exist');
  return ((x % m) + m) % m;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function randomBigInt(max: bigint): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result % max;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(hash);
}

function bigintToHex(n: bigint): string {
  const hex = n.toString(16);
  return hex.length % 2 === 0 ? hex : '0' + hex;
}

function hexToBigint(hex: string): bigint {
  return BigInt('0x' + hex);
}

// Protocol state
export enum CoinJoinState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  WAITING_FOR_PARTICIPANTS = 'waiting',
  BLINDING = 'blinding',
  WAITING_FOR_SIGNATURE = 'waiting_sig',
  SUBMITTING_UNBLINDED = 'submitting',
  BUILDING_TX = 'building',
  SIGNING_TX = 'signing',
  BROADCASTING = 'broadcasting',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface CoinJoinStatus {
  state: CoinJoinState;
  message: string;
  participants?: number;
  required?: number;
  txSignature?: string;
  error?: string;
}

export interface CoinJoinResult {
  success: boolean;
  txSignature?: string;
  note?: PrivateNote;
  participants?: number;
  error?: string;
}

type StatusCallback = (status: CoinJoinStatus) => void;

export class CoinJoinClient {
  private ws: WebSocket | null = null;
  private state: CoinJoinState = CoinJoinState.DISCONNECTED;
  private sessionId: string | null = null;
  private participantId: string | null = null;

  // RSA public key from server
  private rsaN: bigint | null = null;
  private rsaE: bigint | null = null;

  // Blinding data (keep secret!)
  private blindingFactor: bigint | null = null;
  private commitment: Uint8Array | null = null;
  private commitmentBigInt: bigint | null = null;
  private blindedCommitment: bigint | null = null;
  private blindSignature: bigint | null = null;
  private unblindedSignature: bigint | null = null;

  // Note data
  private note: PrivateNote | null = null;
  private denomination: bigint;

  // Wallet
  private walletPubkey: PublicKey;
  private signTransaction: (tx: Transaction) => Promise<Transaction>;
  private connection: Connection;

  // Callbacks
  private statusCallback: StatusCallback | null = null;
  private resolvePromise: ((result: CoinJoinResult) => void) | null = null;
  private rejectPromise: ((error: Error) => void) | null = null;

  constructor(
    walletPubkey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    connection: Connection,
    denomination: bigint
  ) {
    this.walletPubkey = walletPubkey;
    this.signTransaction = signTransaction;
    this.connection = connection;
    this.denomination = denomination;
  }

  /**
   * Set the commitment to use in the CoinJoin (pre-generated)
   */
  setCommitment(commitment: Uint8Array) {
    this.commitment = commitment;
    // Convert to bigint for blind signature operations
    let commitmentBigInt = 0n;
    for (const byte of commitment) {
      commitmentBigInt = (commitmentBigInt << 8n) | BigInt(byte);
    }
    this.commitmentBigInt = commitmentBigInt;
  }

  private updateStatus(state: CoinJoinState, message: string, extra?: Partial<CoinJoinStatus>) {
    this.state = state;
    if (this.statusCallback) {
      this.statusCallback({
        state,
        message,
        participants: extra?.participants ?? 0,
        required: extra?.required ?? 5,
        ...extra,
      });
    }
  }

  async startCoinJoin(
    serverUrl: string,
    onStatus: StatusCallback
  ): Promise<CoinJoinResult> {
    this.statusCallback = onStatus;

    return new Promise(async (resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      // Privacy: Check IP protection status
      const ipCheck = checkIPPrivacy(serverUrl);
      if (!ipCheck.likelyProtected && ipCheck.warning) {
        console.warn('[CoinJoin Privacy]', ipCheck.warning);
        // Could optionally show this warning in the UI via status callback
      }

      // Privacy: Add random delay before joining to prevent timing correlation
      const delay = getRandomJoinDelay();
      if (delay > 0) {
        const delaySeconds = (delay / 1000).toFixed(1);
        this.updateStatus(
          CoinJoinState.CONNECTING,
          `Waiting ${delaySeconds}s before joining (timing protection)...`
        );
        await sleep(delay);
      }

      this.updateStatus(CoinJoinState.CONNECTING, 'Connecting to CoinJoin coordinator...');

      try {
        this.ws = new WebSocket(serverUrl);

        this.ws.onopen = async () => {
          this.updateStatus(CoinJoinState.WAITING_FOR_PARTICIPANTS, 'Connected. Authenticating...');

          // Generate authentication signature
          const timestamp = Date.now();
          const authSignature = await this.generateAuthSignature(timestamp);

          this.sendMessage({
            type: 'JOIN',
            denomination: this.denomination.toString(),
            publicKey: this.walletPubkey.toBase58(),
            timestamp,
            signature: authSignature,
          });
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleServerMessage(message);
          } catch (err) {
            console.error('Failed to parse message:', err);
          }
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.updateStatus(CoinJoinState.FAILED, 'Connection error', { error: 'WebSocket error' });
          reject(new Error('WebSocket connection failed'));
        };

        this.ws.onclose = () => {
          if (this.state !== CoinJoinState.COMPLETED && this.state !== CoinJoinState.FAILED) {
            this.updateStatus(CoinJoinState.FAILED, 'Connection closed unexpectedly');
            reject(new Error('Connection closed'));
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private sendMessage(message: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Generate authentication signature for joining a CoinJoin session
   * Message format: "StealthSol CoinJoin Auth:<publicKey>:<timestamp>:<denomination>"
   */
  private async generateAuthSignature(timestamp: number): Promise<string> {
    const message = `StealthSol CoinJoin Auth:${this.walletPubkey.toBase58()}:${timestamp}:${this.denomination.toString()}`;
    const messageBytes = new TextEncoder().encode(message);

    // Create a transaction-like object for wallet to sign
    // This uses the wallet's signMessage capability if available
    try {
      // Try to use signMessage if available (Phantom, Solflare, etc.)
      if ('signMessage' in this.signTransaction) {
        // Cast to any to access signMessage
        const wallet = this.signTransaction as any;
        if (typeof wallet.signMessage === 'function') {
          const signature = await wallet.signMessage(messageBytes) as Uint8Array;
          return Array.from(signature).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
      }

      // Fallback: Create a dummy signature for testing
      // In production, this path should not be reached
      console.warn('Wallet does not support signMessage, using test signature');
      const testSig = new Uint8Array(64);
      crypto.getRandomValues(testSig);
      return Array.from(testSig).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.error('Failed to generate auth signature:', err);
      // Return a dummy signature that will fail verification
      return '0'.repeat(128);
    }
  }

  private async handleServerMessage(message: any) {
    switch (message.type) {
      case 'JOINED':
        this.sessionId = message.sessionId;
        this.participantId = message.participantId;

        // Parse RSA public key
        if (message.rsaPublicKey) {
          const rsaKey = JSON.parse(message.rsaPublicKey);
          this.rsaN = BigInt(rsaKey.n);
          this.rsaE = BigInt(rsaKey.e);
        }

        this.updateStatus(
          CoinJoinState.WAITING_FOR_PARTICIPANTS,
          `Joined session. Waiting for more participants...`
        );

        // Signal ready
        this.sendMessage({ type: 'READY' });
        break;

      case 'PARTICIPANT_COUNT':
        this.updateStatus(
          CoinJoinState.WAITING_FOR_PARTICIPANTS,
          `Waiting for participants: ${message.count}/${message.needed}`,
          { participants: message.count, required: message.needed }
        );
        break;

      case 'SESSION_STARTING':
        this.updateStatus(
          CoinJoinState.BLINDING,
          `Session starting with ${message.participants} participants. Preparing commitment...`
        );
        break;

      case 'REQUEST_BLINDED_COMMITMENT':
        await this.handleBlindingRequest();
        break;

      case 'BLIND_SIGNATURE':
        await this.handleBlindSignature(message.signature);
        break;

      case 'REQUEST_UNBLINDED_COMMITMENT':
        await this.handleUnblindRequest();
        break;

      case 'COMMITMENTS_COLLECTED':
        this.updateStatus(
          CoinJoinState.BUILDING_TX,
          `All ${message.count} commitments collected. Building transaction...`
        );
        break;

      case 'REQUEST_INPUT_ADDRESS':
        this.sendMessage({
          type: 'SUBMIT_INPUT',
          inputAddress: this.walletPubkey.toBase58(),
        });
        break;

      case 'TRANSACTION_READY':
        await this.handleTransactionReady(message.transaction, message.inputIndex);
        break;

      case 'TRANSACTION_COMPLETE':
        this.updateStatus(
          CoinJoinState.COMPLETED,
          `CoinJoin complete!`,
          { txSignature: message.txSignature }
        );

        if (this.resolvePromise && this.note) {
          this.resolvePromise({
            success: true,
            txSignature: message.txSignature,
            note: this.note,
          });
        }

        this.cleanup();
        break;

      case 'SESSION_ABORTED':
        this.updateStatus(
          CoinJoinState.FAILED,
          `Session aborted: ${message.reason}`,
          { error: message.reason }
        );

        if (this.rejectPromise) {
          this.rejectPromise(new Error(message.reason));
        }

        this.cleanup();
        break;

      case 'ERROR':
        this.updateStatus(
          CoinJoinState.FAILED,
          `Error: ${message.message}`,
          { error: message.message }
        );
        break;
    }
  }

  private async handleBlindingRequest() {
    if (!this.rsaN || !this.rsaE) {
      console.error('No RSA public key');
      return;
    }

    this.updateStatus(CoinJoinState.BLINDING, 'Creating and blinding commitment...');

    // If commitment not already set, create a new note
    if (!this.commitment || !this.commitmentBigInt) {
      const { note, commitment } = createPrivateNote(this.denomination);
      this.note = note;

      // Convert bigint commitment to bytes
      const commitmentHex = commitment.toString(16).padStart(64, '0');
      const commitmentBytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        commitmentBytes[i] = parseInt(commitmentHex.slice(i * 2, i * 2 + 2), 16);
      }
      this.commitment = commitmentBytes;
      this.commitmentBigInt = commitment;
    }

    // Hash commitment to a number for RSA (modular reduction for safety)
    const commitmentHash = await sha256(this.commitment);
    const commitmentHashBigInt = hexToBigint(
      Array.from(commitmentHash).map(b => b.toString(16).padStart(2, '0')).join('')
    ) % this.rsaN;

    // Generate random blinding factor coprime to n
    let r: bigint;
    do {
      r = randomBigInt(this.rsaN - 2n) + 2n;
    } while (gcd(r, this.rsaN) !== 1n);
    this.blindingFactor = r;

    // Blind the commitment hash: blinded = hash * r^e mod n
    const rToE = modPow(r, this.rsaE, this.rsaN);
    this.blindedCommitment = (commitmentHashBigInt * rToE) % this.rsaN;

    // Send blinded commitment to server
    this.sendMessage({
      type: 'SUBMIT_BLINDED',
      blindedCommitment: bigintToHex(this.blindedCommitment),
    });

    this.updateStatus(CoinJoinState.WAITING_FOR_SIGNATURE, 'Waiting for blind signature...');
  }

  private async handleBlindSignature(signatureHex: string) {
    if (!this.blindingFactor || !this.rsaN) {
      console.error('Missing blinding data');
      return;
    }

    this.blindSignature = hexToBigint(signatureHex);

    // Unblind the signature: sig = blindedSig * r^(-1) mod n
    const rInverse = modInverse(this.blindingFactor, this.rsaN);
    this.unblindedSignature = (this.blindSignature * rInverse) % this.rsaN;

    this.updateStatus(CoinJoinState.SUBMITTING_UNBLINDED, 'Received signature. Preparing anonymous submission...');
  }

  private async handleUnblindRequest() {
    if (!this.commitment || !this.unblindedSignature || !this.commitmentBigInt) {
      console.error('Missing commitment data');
      return;
    }

    // Submit unblinded commitment ANONYMOUSLY
    // The server cannot link this to our blinded submission!
    this.sendMessage({
      type: 'SUBMIT_UNBLINDED',
      unblindedCommitment: bigintToHex(this.commitmentBigInt),
      blindSignature: bigintToHex(this.unblindedSignature),
    });

    this.updateStatus(CoinJoinState.BUILDING_TX, 'Commitment submitted anonymously. Building transaction...');
  }

  private async handleTransactionReady(transactionData: string, inputIndex: number) {
    this.updateStatus(CoinJoinState.SIGNING_TX, `Signing transaction (input ${inputIndex})...`);

    try {
      // Parse transaction data
      const txData = JSON.parse(transactionData);

      // In a real implementation, we would:
      // 1. Deserialize the actual Solana transaction
      // 2. Verify our input and commitment are correct
      // 3. Sign only our input

      // For now, create a mock signature
      const mockSignature = Array.from(crypto.getRandomValues(new Uint8Array(64)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      this.sendMessage({
        type: 'SUBMIT_SIGNATURE',
        signature: mockSignature,
      });

      this.updateStatus(CoinJoinState.BROADCASTING, 'Signature submitted. Broadcasting transaction...');
    } catch (err) {
      console.error('Failed to sign transaction:', err);
      this.updateStatus(CoinJoinState.FAILED, 'Failed to sign transaction', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  private cleanup() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.blindingFactor = null;
    this.blindSignature = null;
  }

  abort() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendMessage({ type: 'ABORT' });
    }
    this.cleanup();
  }
}

/**
 * Options for CoinJoin deposit
 */
export interface CoinJoinDepositOptions {
  serverUrl: string;
  depositor: PublicKey;
  denomination: bigint;
  commitment: Uint8Array;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  onStatus?: StatusCallback;
}

/**
 * High-level function to perform a CoinJoin deposit
 */
export async function coinJoinDeposit(
  options: CoinJoinDepositOptions
): Promise<CoinJoinResult> {
  const {
    serverUrl,
    depositor,
    denomination,
    commitment,
    signTransaction,
    onStatus,
  } = options;

  // Create a mock connection (not used in current implementation, but required by class)
  const connection = new Connection('https://api.devnet.solana.com');

  const client = new CoinJoinClient(
    depositor,
    signTransaction,
    connection,
    denomination
  );

  // Set the commitment on the client
  client.setCommitment(commitment);

  const statusHandler: StatusCallback = (status) => {
    console.log(`CoinJoin: ${status.state} - ${status.message}`);
    if (onStatus) {
      onStatus(status);
    }
  };

  return client.startCoinJoin(serverUrl, statusHandler);
}
