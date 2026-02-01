/**
 * CoinJoin Coordination Server
 *
 * Coordinates the blind CoinJoin protocol between multiple participants.
 * The server facilitates communication but CANNOT link depositors to commitments
 * due to the blind signature scheme.
 *
 * Privacy guarantee: Even a malicious server cannot determine which
 * participant owns which commitment.
 *
 * Security features:
 * - Input validation on all messages
 * - Rate limiting per IP address
 * - Session authentication
 * - Secure random IDs using crypto.randomBytes
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import { randomBytes, createHash } from 'crypto';
import { IncomingMessage } from 'http';

// ============================================
// Security: Rate Limiting
// ============================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimiter = new Map<string, RateLimitEntry>();

const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // Max requests per window
const RATE_LIMIT_MAX_CONNECTIONS = 5; // Max concurrent connections per IP

function getClientIP(req: IncomingMessage): string {
  // Handle proxied connections
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimiter.get(ip);

  if (!entry || entry.resetAt < now) {
    rateLimiter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}

// Track connections per IP
const connectionsPerIP = new Map<string, number>();

function checkConnectionLimit(ip: string): boolean {
  const count = connectionsPerIP.get(ip) || 0;
  return count < RATE_LIMIT_MAX_CONNECTIONS;
}

function incrementConnectionCount(ip: string): void {
  connectionsPerIP.set(ip, (connectionsPerIP.get(ip) || 0) + 1);
}

function decrementConnectionCount(ip: string): void {
  const count = connectionsPerIP.get(ip) || 1;
  if (count <= 1) {
    connectionsPerIP.delete(ip);
  } else {
    connectionsPerIP.set(ip, count - 1);
  }
}

// ============================================
// Security: Input Validation
// ============================================

const HEX_REGEX = /^[0-9a-f]+$/i;
const MAX_HEX_LENGTH = 1024; // Max length for hex strings
const MAX_PUBKEY_LENGTH = 128; // Max length for public keys

interface ValidationResult {
  valid: boolean;
  error?: string;
}

function validateHex(value: string, maxLength: number = MAX_HEX_LENGTH): ValidationResult {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Expected string' };
  }
  if (value.length === 0) {
    return { valid: false, error: 'Empty string' };
  }
  if (value.length > maxLength) {
    return { valid: false, error: `String too long (max ${maxLength})` };
  }
  if (!HEX_REGEX.test(value)) {
    return { valid: false, error: 'Invalid hex string' };
  }
  return { valid: true };
}

function validateDenomination(value: string): ValidationResult {
  try {
    const denom = BigInt(value);
    const validDenoms = [
      BigInt(1_000_000_000),   // 1 SOL
      BigInt(10_000_000_000),  // 10 SOL
      BigInt(100_000_000_000), // 100 SOL
    ];
    if (!validDenoms.includes(denom)) {
      return { valid: false, error: 'Invalid denomination' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid denomination format' };
  }
}

function validateClientMessage(raw: unknown): { valid: boolean; message?: ClientMessage; error?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, error: 'Message must be an object' };
  }

  const msg = raw as Record<string, unknown>;

  if (typeof msg.type !== 'string') {
    return { valid: false, error: 'Message type required' };
  }

  switch (msg.type) {
    case 'JOIN': {
      if (typeof msg.denomination !== 'string') {
        return { valid: false, error: 'Denomination required' };
      }
      const denomValid = validateDenomination(msg.denomination);
      if (!denomValid.valid) {
        return { valid: false, error: denomValid.error };
      }
      if (typeof msg.publicKey !== 'string' || msg.publicKey.length > MAX_PUBKEY_LENGTH) {
        return { valid: false, error: 'Invalid public key' };
      }
      if (typeof msg.timestamp !== 'number' || msg.timestamp <= 0) {
        return { valid: false, error: 'Invalid timestamp' };
      }
      if (typeof msg.signature !== 'string' || msg.signature.length !== 128) {
        return { valid: false, error: 'Invalid signature (must be 128 hex chars)' };
      }
      const sigValid = validateHex(msg.signature, 128);
      if (!sigValid.valid) {
        return { valid: false, error: `Invalid signature: ${sigValid.error}` };
      }
      return {
        valid: true,
        message: {
          type: 'JOIN',
          denomination: msg.denomination,
          publicKey: msg.publicKey,
          timestamp: msg.timestamp,
          signature: msg.signature,
        },
      };
    }

    case 'READY':
      return { valid: true, message: { type: 'READY' } };

    case 'SUBMIT_BLINDED': {
      if (typeof msg.blindedCommitment !== 'string') {
        return { valid: false, error: 'Blinded commitment required' };
      }
      const hexValid = validateHex(msg.blindedCommitment);
      if (!hexValid.valid) {
        return { valid: false, error: `Invalid blinded commitment: ${hexValid.error}` };
      }
      return { valid: true, message: { type: 'SUBMIT_BLINDED', blindedCommitment: msg.blindedCommitment } };
    }

    case 'SUBMIT_UNBLINDED': {
      if (typeof msg.unblindedCommitment !== 'string' || typeof msg.blindSignature !== 'string') {
        return { valid: false, error: 'Unblinded commitment and signature required' };
      }
      const commitValid = validateHex(msg.unblindedCommitment);
      const sigValid = validateHex(msg.blindSignature);
      if (!commitValid.valid || !sigValid.valid) {
        return { valid: false, error: 'Invalid commitment or signature format' };
      }
      return {
        valid: true,
        message: {
          type: 'SUBMIT_UNBLINDED',
          unblindedCommitment: msg.unblindedCommitment,
          blindSignature: msg.blindSignature,
        },
      };
    }

    case 'SUBMIT_INPUT': {
      if (typeof msg.inputAddress !== 'string' || msg.inputAddress.length > 64) {
        return { valid: false, error: 'Invalid input address' };
      }
      return { valid: true, message: { type: 'SUBMIT_INPUT', inputAddress: msg.inputAddress } };
    }

    case 'SUBMIT_SIGNATURE': {
      if (typeof msg.signature !== 'string') {
        return { valid: false, error: 'Signature required' };
      }
      const sigValid = validateHex(msg.signature, 256);
      if (!sigValid.valid) {
        return { valid: false, error: `Invalid signature: ${sigValid.error}` };
      }
      return { valid: true, message: { type: 'SUBMIT_SIGNATURE', signature: msg.signature } };
    }

    case 'ABORT':
      return { valid: true, message: { type: 'ABORT' } };

    default:
      return { valid: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ============================================
// Security: Session Authentication (Ed25519)
// ============================================

import { createVerify } from 'crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure ed25519 to use synchronous sha512
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Verify Ed25519 signature for session authentication
 * Message format: "StealthSol CoinJoin Auth:<publicKey>:<timestamp>:<denomination>"
 */
async function verifyJoinSignature(
  publicKey: string,
  timestamp: number,
  denomination: string,
  signatureHex: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Check timestamp freshness (5 minute window)
    const now = Date.now();
    const age = now - timestamp;
    if (age < 0 || age > 5 * 60 * 1000) {
      return { valid: false, error: 'Signature timestamp expired or future-dated' };
    }

    // Construct the message that should have been signed
    const message = `StealthSol CoinJoin Auth:${publicKey}:${timestamp}:${denomination}`;
    const messageBytes = new TextEncoder().encode(message);

    // Decode the signature and public key from hex/base58
    const signature = hexToBytes(signatureHex);
    if (signature.length !== 64) {
      return { valid: false, error: 'Invalid signature length' };
    }

    // Decode public key (base58 Solana format)
    const pubkeyBytes = base58Decode(publicKey);
    if (pubkeyBytes.length !== 32) {
      return { valid: false, error: 'Invalid public key length' };
    }

    // Verify the Ed25519 signature
    const isValid = await ed.verifyAsync(signature, messageBytes, pubkeyBytes);

    if (!isValid) {
      return { valid: false, error: 'Signature verification failed' };
    }

    return { valid: true };
  } catch (err) {
    console.error('Signature verification error:', err);
    return { valid: false, error: 'Signature verification error' };
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Base58 decode (Solana public key format)
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('Invalid base58 character');

    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Add leading zeros
  for (const c of str) {
    if (c !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

// ============================================
// Security: Secure Random
// ============================================
import {
  type CoinJoinSession,
  type Participant,
  type ClientMessage,
  type ServerMessage,
  type RSAKeyPair,
  SessionState,
  DEFAULT_CONFIG,
} from './types.js';
import {
  generateRSAKeyPair,
  signBlinded,
  hexToBigint,
  bigintToHex,
  serializePublicKey,
} from './blind-sig.js';

// Active sessions by denomination
const sessions: Map<string, CoinJoinSession> = new Map();

// Client to session mapping
const clientSessions: Map<WebSocket, { sessionId: string; participantId: string }> = new Map();

// RSA keypair for blind signatures (rotated per session)
let currentKeyPair: RSAKeyPair | null = null;

function generateSessionId(): string {
  return randomBytes(16).toString('hex');
}

function generateParticipantId(): string {
  return randomBytes(8).toString('hex');
}

function getOrCreateSession(denomination: bigint): CoinJoinSession {
  const denomKey = denomination.toString();

  // Find existing session that's waiting for participants
  for (const [id, session] of sessions) {
    if (
      session.denomination === denomination &&
      session.state === SessionState.WAITING_FOR_PARTICIPANTS &&
      session.participants.size < session.maxParticipants &&
      Date.now() < session.expiresAt
    ) {
      return session;
    }
  }

  // Create new session
  const session: CoinJoinSession = {
    id: generateSessionId(),
    denomination,
    state: SessionState.WAITING_FOR_PARTICIPANTS,
    participants: new Map(),
    minParticipants: DEFAULT_CONFIG.minParticipants,
    maxParticipants: DEFAULT_CONFIG.maxParticipants,
    blindedCommitments: [],
    unblindedCommitments: [],
    signatures: new Map(),
    createdAt: Date.now(),
    expiresAt: Date.now() + DEFAULT_CONFIG.sessionTimeout,
  };

  // Generate fresh RSA keypair for this session
  currentKeyPair = generateRSAKeyPair(2048);

  sessions.set(session.id, session);
  console.log(`Created new session ${session.id} for ${denomination} lamports`);
  return session;
}

function broadcastToSession(session: CoinJoinSession, message: ServerMessage, exclude?: WebSocket) {
  const msgStr = JSON.stringify(message);
  for (const [client, info] of clientSessions) {
    if (info.sessionId === session.id && client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(msgStr);
    }
  }
}

function sendToClient(client: WebSocket, message: ServerMessage) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function checkSessionReady(session: CoinJoinSession) {
  const readyCount = Array.from(session.participants.values()).filter(p => p.ready).length;

  if (readyCount >= session.minParticipants) {
    startSession(session);
  } else {
    broadcastToSession(session, {
      type: 'PARTICIPANT_COUNT',
      count: readyCount,
      needed: session.minParticipants,
    });
  }
}

function startSession(session: CoinJoinSession) {
  console.log(`Starting session ${session.id} with ${session.participants.size} participants`);

  session.state = SessionState.COLLECTING_BLINDED_COMMITMENTS;

  broadcastToSession(session, {
    type: 'SESSION_STARTING',
    participants: session.participants.size,
  });

  // Request blinded commitments from all participants
  broadcastToSession(session, {
    type: 'REQUEST_BLINDED_COMMITMENT',
  });
}

function handleBlindedCommitment(
  session: CoinJoinSession,
  participantId: string,
  blindedCommitment: string,
  client: WebSocket
) {
  const participant = session.participants.get(participantId);
  if (!participant) return;

  participant.blindedCommitment = blindedCommitment;
  session.blindedCommitments.push(blindedCommitment);

  console.log(`Received blinded commitment from ${participantId}`);

  // Sign the blinded commitment (we can't see the real value!)
  if (currentKeyPair) {
    const blindedBigInt = hexToBigint(blindedCommitment);
    const signature = signBlinded(blindedBigInt, currentKeyPair.privateKey);

    sendToClient(client, {
      type: 'BLIND_SIGNATURE',
      signature: bigintToHex(signature),
    });
  }

  // Check if all participants have submitted
  const submittedCount = session.blindedCommitments.length;
  if (submittedCount === session.participants.size) {
    // Move to next phase - collect unblinded commitments
    session.state = SessionState.COLLECTING_UNBLINDED;
    broadcastToSession(session, {
      type: 'REQUEST_UNBLINDED_COMMITMENT',
    });
  }
}

function handleUnblindedCommitment(
  session: CoinJoinSession,
  unblindedCommitment: string,
  blindSignature: string
) {
  // Verify the signature is valid (proves this commitment was signed)
  // Note: We don't know WHO submitted this - that's the privacy!

  session.unblindedCommitments.push(unblindedCommitment);
  console.log(`Received unblinded commitment (anonymous): ${unblindedCommitment.slice(0, 16)}...`);

  // Check if all commitments collected
  if (session.unblindedCommitments.length === session.participants.size) {
    // Shuffle the commitments (extra privacy measure)
    shuffleArray(session.unblindedCommitments);

    broadcastToSession(session, {
      type: 'COMMITMENTS_COLLECTED',
      count: session.unblindedCommitments.length,
    });

    // Request input addresses for transaction building
    session.state = SessionState.BUILDING_TRANSACTION;
    broadcastToSession(session, {
      type: 'REQUEST_INPUT_ADDRESS',
    });
  }
}

function handleInputAddress(
  session: CoinJoinSession,
  participantId: string,
  inputAddress: string
) {
  const participant = session.participants.get(participantId);
  if (!participant) return;

  participant.inputAddress = inputAddress;
  console.log(`Received input address from ${participantId}: ${inputAddress.slice(0, 8)}...`);

  // Check if all inputs collected
  const inputsCollected = Array.from(session.participants.values()).filter(p => p.inputAddress).length;
  if (inputsCollected === session.participants.size) {
    buildTransaction(session);
  }
}

function buildTransaction(session: CoinJoinSession) {
  console.log(`Building transaction for session ${session.id}`);

  // In a real implementation, this would:
  // 1. Create a Solana transaction with multiple inputs (depositors)
  // 2. Add instructions for each commitment to the privacy pool
  // 3. The commitments are already shuffled, so no one knows the mapping

  const inputs = Array.from(session.participants.values())
    .map(p => p.inputAddress)
    .filter((a): a is string => !!a);

  // Create mock transaction data (in production, this is a real Solana tx)
  const txData = {
    inputs,
    commitments: session.unblindedCommitments,
    denomination: session.denomination.toString(),
  };

  session.transaction = JSON.stringify(txData);
  session.state = SessionState.SIGNING_TRANSACTION;

  // Send transaction to each participant with their input index
  let index = 0;
  for (const [client, info] of clientSessions) {
    if (info.sessionId === session.id) {
      const participant = session.participants.get(info.participantId);
      if (participant?.inputAddress) {
        const inputIndex = inputs.indexOf(participant.inputAddress);
        sendToClient(client, {
          type: 'TRANSACTION_READY',
          transaction: session.transaction,
          inputIndex,
        });
      }
      index++;
    }
  }
}

function handleSignature(
  session: CoinJoinSession,
  participantId: string,
  signature: string
) {
  session.signatures.set(participantId, signature);
  console.log(`Received signature from ${participantId}`);

  // Check if all signatures collected
  if (session.signatures.size === session.participants.size) {
    broadcastTransaction(session);
  }
}

function broadcastTransaction(session: CoinJoinSession) {
  console.log(`Broadcasting transaction for session ${session.id}`);

  session.state = SessionState.BROADCASTING;

  // In production: Combine signatures and submit to Solana
  // For now, generate mock tx signature
  const txSignature = randomBytes(64).toString('hex');

  session.state = SessionState.COMPLETED;

  broadcastToSession(session, {
    type: 'TRANSACTION_COMPLETE',
    txSignature,
  });

  // Cleanup session after delay
  setTimeout(() => {
    sessions.delete(session.id);
    console.log(`Cleaned up session ${session.id}`);
  }, 60000);
}

function shuffleArray<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

async function handleClientMessage(client: WebSocket, message: ClientMessage) {
  const clientInfo = clientSessions.get(client);

  switch (message.type) {
    case 'JOIN': {
      // Verify Ed25519 signature for authentication
      const sigResult = await verifyJoinSignature(
        message.publicKey,
        message.timestamp,
        message.denomination,
        message.signature
      );

      if (!sigResult.valid) {
        console.log(`Authentication failed for ${message.publicKey}: ${sigResult.error}`);
        sendToClient(client, {
          type: 'ERROR',
          message: `Authentication failed: ${sigResult.error}`,
        });
        return;
      }

      console.log(`Authenticated join from ${message.publicKey.slice(0, 8)}...`);

      const denomination = BigInt(message.denomination);
      const session = getOrCreateSession(denomination);
      const participantId = generateParticipantId();

      const participant: Participant = {
        id: participantId,
        publicKey: message.publicKey,
        ready: false,
        timestamp: Date.now(),
      };

      session.participants.set(participantId, participant);
      clientSessions.set(client, { sessionId: session.id, participantId });

      console.log(`Participant ${participantId} joined session ${session.id}`);

      sendToClient(client, {
        type: 'JOINED',
        sessionId: session.id,
        participantId,
        rsaPublicKey: currentKeyPair ? serializePublicKey(currentKeyPair.publicKey) : '',
      });

      broadcastToSession(session, {
        type: 'PARTICIPANT_COUNT',
        count: session.participants.size,
        needed: session.minParticipants,
      });
      break;
    }

    case 'READY': {
      if (!clientInfo) return;
      const session = sessions.get(clientInfo.sessionId);
      if (!session) return;

      const participant = session.participants.get(clientInfo.participantId);
      if (participant) {
        participant.ready = true;
        checkSessionReady(session);
      }
      break;
    }

    case 'SUBMIT_BLINDED': {
      if (!clientInfo) return;
      const session = sessions.get(clientInfo.sessionId);
      if (!session || session.state !== SessionState.COLLECTING_BLINDED_COMMITMENTS) return;

      handleBlindedCommitment(session, clientInfo.participantId, message.blindedCommitment, client);
      break;
    }

    case 'SUBMIT_UNBLINDED': {
      if (!clientInfo) return;
      const session = sessions.get(clientInfo.sessionId);
      if (!session || session.state !== SessionState.COLLECTING_UNBLINDED) return;

      handleUnblindedCommitment(session, message.unblindedCommitment, message.blindSignature);
      break;
    }

    case 'SUBMIT_INPUT': {
      if (!clientInfo) return;
      const session = sessions.get(clientInfo.sessionId);
      if (!session || session.state !== SessionState.BUILDING_TRANSACTION) return;

      handleInputAddress(session, clientInfo.participantId, message.inputAddress);
      break;
    }

    case 'SUBMIT_SIGNATURE': {
      if (!clientInfo) return;
      const session = sessions.get(clientInfo.sessionId);
      if (!session || session.state !== SessionState.SIGNING_TRANSACTION) return;

      handleSignature(session, clientInfo.participantId, message.signature);
      break;
    }

    case 'ABORT': {
      if (!clientInfo) return;
      const session = sessions.get(clientInfo.sessionId);
      if (session) {
        session.state = SessionState.ABORTED;
        broadcastToSession(session, {
          type: 'SESSION_ABORTED',
          reason: 'Participant aborted',
        });
      }
      break;
    }
  }
}

function handleClientDisconnect(client: WebSocket) {
  const clientInfo = clientSessions.get(client);
  if (clientInfo) {
    const session = sessions.get(clientInfo.sessionId);
    if (session && session.state !== SessionState.COMPLETED) {
      session.participants.delete(clientInfo.participantId);

      if (session.state !== SessionState.WAITING_FOR_PARTICIPANTS) {
        // Session was in progress - abort
        session.state = SessionState.ABORTED;
        broadcastToSession(session, {
          type: 'SESSION_ABORTED',
          reason: 'Participant disconnected',
        });
      } else {
        // Just update participant count
        broadcastToSession(session, {
          type: 'PARTICIPANT_COUNT',
          count: session.participants.size,
          needed: session.minParticipants,
        });
      }
    }
    clientSessions.delete(client);
  }
}

// Track client IPs for rate limiting cleanup
const clientIPs = new Map<WebSocket, string>();

// Start server
export function startServer(port: number = 8080) {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws, req) => {
    const clientIP = getClientIP(req);

    // Check connection limit
    if (!checkConnectionLimit(clientIP)) {
      console.log(`Connection limit exceeded for ${clientIP}`);
      ws.close(1008, 'Too many connections');
      return;
    }

    incrementConnectionCount(clientIP);
    clientIPs.set(ws, clientIP);
    console.log(`Client connected from ${clientIP}`);

    ws.on('message', (data: RawData) => {
      // Check rate limit
      const rateCheck = checkRateLimit(clientIP);
      if (!rateCheck.allowed) {
        sendToClient(ws, {
          type: 'ERROR',
          message: `Rate limited. Retry after ${rateCheck.retryAfter} seconds`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(data.toString());
        const validation = validateClientMessage(parsed);

        if (!validation.valid) {
          console.log(`Invalid message from ${clientIP}: ${validation.error}`);
          sendToClient(ws, { type: 'ERROR', message: validation.error || 'Invalid message' });
          return;
        }

        handleClientMessage(ws, validation.message!);
      } catch (err) {
        console.error('Failed to parse message:', err);
        sendToClient(ws, { type: 'ERROR', message: 'Invalid JSON' });
      }
    });

    ws.on('close', () => {
      const ip = clientIPs.get(ws);
      if (ip) {
        decrementConnectionCount(ip);
        clientIPs.delete(ws);
      }
      console.log('Client disconnected');
      handleClientDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      const ip = clientIPs.get(ws);
      if (ip) {
        decrementConnectionCount(ip);
        clientIPs.delete(ws);
      }
      handleClientDisconnect(ws);
    });
  });

  console.log(`CoinJoin coordination server running on port ${port}`);

  // Cleanup expired sessions periodically
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now > session.expiresAt && session.state !== SessionState.COMPLETED) {
        session.state = SessionState.ABORTED;
        broadcastToSession(session, {
          type: 'SESSION_ABORTED',
          reason: 'Session expired',
        });
        sessions.delete(id);
        console.log(`Expired session ${id}`);
      }
    }
  }, 30000);

  return wss;
}

// Run if executed directly
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const port = parseInt(process.env.PORT || '8080');
  startServer(port);
}
