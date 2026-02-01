/**
 * P2P Blind CoinJoin Protocol Types
 *
 * This implements a Chaumian blind signature protocol for private deposits.
 * Multiple users coordinate to deposit simultaneously, making it impossible
 * to link any specific depositor to any specific commitment.
 */

// Session states
export enum SessionState {
  WAITING_FOR_PARTICIPANTS = 'waiting',
  COLLECTING_BLINDED_COMMITMENTS = 'collecting',
  SIGNING = 'signing',
  COLLECTING_UNBLINDED = 'unblinded',
  BUILDING_TRANSACTION = 'building',
  SIGNING_TRANSACTION = 'signing_tx',
  BROADCASTING = 'broadcasting',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ABORTED = 'aborted',
}

// Participant in a CoinJoin session
export interface Participant {
  id: string;  // Unique session ID (not their wallet!)
  publicKey: string;  // For encrypted communication
  inputAddress?: string;  // Solana address (revealed only when signing tx)
  blindedCommitment?: string;  // Blinded commitment (can't see real value)
  signature?: string;  // Partial signature for transaction
  ready: boolean;
  timestamp: number;
}

// CoinJoin session
export interface CoinJoinSession {
  id: string;
  denomination: bigint;  // Fixed denomination (1, 10, or 100 SOL)
  state: SessionState;
  participants: Map<string, Participant>;
  minParticipants: number;
  maxParticipants: number;
  blindedCommitments: string[];  // Collected blinded commitments
  unblindedCommitments: string[];  // Shuffled unblinded commitments
  transaction?: string;  // Serialized transaction for signing
  signatures: Map<string, string>;  // Collected signatures
  createdAt: number;
  expiresAt: number;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'JOIN'; denomination: string; publicKey: string; timestamp: number; signature: string }
  | { type: 'SUBMIT_BLINDED'; blindedCommitment: string }
  | { type: 'SUBMIT_UNBLINDED'; unblindedCommitment: string; blindSignature: string }
  | { type: 'SUBMIT_INPUT'; inputAddress: string }
  | { type: 'SUBMIT_SIGNATURE'; signature: string }
  | { type: 'READY' }
  | { type: 'ABORT' };

// Authentication configuration
export const AUTH_CONFIG = {
  // Maximum age of signature in milliseconds (5 minutes)
  MAX_SIGNATURE_AGE_MS: 5 * 60 * 1000,
  // Message prefix for signing
  MESSAGE_PREFIX: 'StealthSol CoinJoin Auth:',
};

// Server -> Client messages
export type ServerMessage =
  | { type: 'JOINED'; sessionId: string; participantId: string; rsaPublicKey: string }
  | { type: 'PARTICIPANT_COUNT'; count: number; needed: number }
  | { type: 'SESSION_STARTING'; participants: number }
  | { type: 'REQUEST_BLINDED_COMMITMENT' }
  | { type: 'BLIND_SIGNATURE'; signature: string }
  | { type: 'REQUEST_UNBLINDED_COMMITMENT' }
  | { type: 'COMMITMENTS_COLLECTED'; count: number }
  | { type: 'REQUEST_INPUT_ADDRESS' }
  | { type: 'TRANSACTION_READY'; transaction: string; inputIndex: number }
  | { type: 'REQUEST_SIGNATURE' }
  | { type: 'TRANSACTION_COMPLETE'; txSignature: string }
  | { type: 'SESSION_ABORTED'; reason: string }
  | { type: 'ERROR'; message: string };

// RSA key pair for blind signatures
export interface RSAKeyPair {
  publicKey: {
    n: bigint;  // Modulus
    e: bigint;  // Public exponent
  };
  privateKey: {
    n: bigint;  // Modulus
    d: bigint;  // Private exponent
    p: bigint;  // Prime factor 1
    q: bigint;  // Prime factor 2
  };
}

// Blinding result
export interface BlindingResult {
  blindedMessage: bigint;
  blindingFactor: bigint;
}

// Protocol configuration
export interface CoinJoinConfig {
  minParticipants: number;  // Minimum users for privacy (default: 5)
  maxParticipants: number;  // Maximum users per session (default: 20)
  sessionTimeout: number;   // Timeout in ms (default: 5 minutes)
  denomination: bigint;     // Fixed denomination in lamports
}

export const DEFAULT_CONFIG: CoinJoinConfig = {
  minParticipants: 2,  // Set to 2 for testing (use 5+ in production for privacy)
  maxParticipants: 20,
  sessionTimeout: 5 * 60 * 1000,  // 5 minutes
  denomination: BigInt(1_000_000_000),  // 1 SOL
};
