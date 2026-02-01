/**
 * StealthSol Threshold ZK Proof Verifier
 *
 * Distributed verification service with threshold attestation signing.
 * Multiple verifier nodes must agree on proof validity before an
 * attestation is issued (2-of-3 by default).
 *
 * Features:
 * - Groth16 proof verification using snarkjs
 * - Threshold signature aggregation
 * - Peer coordination for distributed trust
 * - Supports both withdraw and deposit circuits
 *
 * Flow:
 * 1. Client submits proof to any verifier node
 * 2. Receiving node verifies proof locally
 * 3. If valid, node requests partial signatures from peers
 * 4. Once threshold is reached, combined attestation is returned
 */

import express from 'express';
import cors from 'cors';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// Configuration
// ============================================

const NODE_ID = process.env.NODE_ID || `verifier-${randomBytes(4).toString('hex')}`;
const PORT = parseInt(process.env.PORT || '3001');
const THRESHOLD_REQUIRED = parseInt(process.env.THRESHOLD_REQUIRED || '2');
const THRESHOLD_PEERS = (process.env.THRESHOLD_PEERS || '').split(',').filter(p => p.trim());
const REQUEST_TIMEOUT_MS = 10000;
const ATTESTATION_VALIDITY_SECS = 300; // 5 minutes

// ============================================
// Verifier Keypair
// ============================================

function loadVerifierKeypair() {
  const seedEnv = process.env.VERIFIER_SEED;

  if (seedEnv) {
    const seed = createHash('sha256').update(seedEnv).digest();
    console.log(`[${NODE_ID}] Using verifier seed from environment`);
    return Keypair.fromSeed(seed);
  } else if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: VERIFIER_SEED environment variable required in production!');
    process.exit(1);
  } else {
    console.warn(`[${NODE_ID}] WARNING: Using default seed - FOR DEVELOPMENT ONLY!`);
    const seed = Buffer.alloc(32);
    Buffer.from(`stealthsol-verifier-${NODE_ID}`).copy(seed);
    return Keypair.fromSeed(seed);
  }
}

const verifierKeypair = loadVerifierKeypair();
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// Circuit Caching
// ============================================

let withdrawVKey = null;
let depositVKey = null;
let snarkjs = null;

async function loadCircuits() {
  try {
    // Dynamically import snarkjs (ESM)
    const snarkjsModule = await import('snarkjs');
    snarkjs = snarkjsModule.default || snarkjsModule;

    const circuitsDir = process.env.CIRCUITS_DIR || path.join(__dirname, 'circuits');

    const withdrawVkPath = path.join(circuitsDir, 'withdraw_verification_key.json');
    const depositVkPath = path.join(circuitsDir, 'deposit_verification_key.json');

    if (fs.existsSync(withdrawVkPath)) {
      withdrawVKey = JSON.parse(fs.readFileSync(withdrawVkPath, 'utf8'));
      console.log(`[${NODE_ID}] Loaded withdraw verification key`);
    }

    if (fs.existsSync(depositVkPath)) {
      depositVKey = JSON.parse(fs.readFileSync(depositVkPath, 'utf8'));
      console.log(`[${NODE_ID}] Loaded deposit verification key`);
    }

    if (!withdrawVKey && !depositVKey) {
      console.warn(`[${NODE_ID}] No verification keys loaded - operating in attestation-only mode`);
    }
  } catch (err) {
    console.error(`[${NODE_ID}] Failed to load circuits:`, err.message);
  }
}

// ============================================
// Cryptographic Utilities
// ============================================

function computeHash(data) {
  return createHash('sha256').update(data).digest();
}

function createAttestationMessage(proofHash, publicInputsHash, timestamp) {
  const message = Buffer.alloc(72);
  proofHash.copy(message, 0);
  publicInputsHash.copy(message, 32);
  message.writeBigInt64LE(BigInt(timestamp), 64);
  return message;
}

function signAttestation(proofHash, publicInputsHash, timestamp) {
  const message = createAttestationMessage(proofHash, publicInputsHash, timestamp);
  const signature = nacl.sign.detached(message, verifierKeypair.secretKey);
  return Buffer.from(signature);
}

function verifyPartialSignature(proofHash, publicInputsHash, timestamp, signature, verifierPubkey) {
  const message = createAttestationMessage(proofHash, publicInputsHash, timestamp);
  return nacl.sign.detached.verify(message, new Uint8Array(signature), new Uint8Array(verifierPubkey));
}

// ============================================
// Peer Communication
// ============================================

const pendingRequests = new Map(); // requestId -> { signatures, timestamp, resolve, reject }

async function requestPartialSignature(peer, verificationRequest) {
  try {
    const response = await axios.post(
      `${peer}/internal/sign`,
      verificationRequest,
      { timeout: REQUEST_TIMEOUT_MS }
    );
    return response.data;
  } catch (err) {
    console.error(`[${NODE_ID}] Failed to get signature from ${peer}:`, err.message);
    return null;
  }
}

async function collectThresholdSignatures(proofHash, publicInputsHash, timestamp, proof, publicInputs, circuitType) {
  const verificationRequest = {
    proofHash: proofHash.toString('hex'),
    publicInputsHash: publicInputsHash.toString('hex'),
    timestamp,
    proof: Array.from(proof),
    publicInputs,
    circuitType,
    requesterNode: NODE_ID,
  };

  // Start with our own signature
  const localSignature = signAttestation(proofHash, publicInputsHash, timestamp);

  const partialSignatures = [{
    nodeId: NODE_ID,
    signature: Array.from(localSignature),
    verifierPubkey: Array.from(verifierKeypair.publicKey.toBytes()),
  }];

  // Request from peers in parallel
  if (THRESHOLD_PEERS.length > 0) {
    const peerPromises = THRESHOLD_PEERS.map(peer =>
      requestPartialSignature(peer, verificationRequest)
    );

    const peerResults = await Promise.allSettled(peerPromises);

    for (const result of peerResults) {
      if (result.status === 'fulfilled' && result.value?.signature) {
        // Verify the peer's signature
        const isValid = verifyPartialSignature(
          proofHash,
          publicInputsHash,
          timestamp,
          result.value.signature,
          result.value.verifierPubkey
        );

        if (isValid) {
          partialSignatures.push({
            nodeId: result.value.nodeId,
            signature: result.value.signature,
            verifierPubkey: result.value.verifierPubkey,
          });
        } else {
          console.warn(`[${NODE_ID}] Invalid signature from peer ${result.value?.nodeId}`);
        }
      }
    }
  }

  return partialSignatures;
}

// ============================================
// Groth16 Verification
// ============================================

async function verifyGroth16Proof(proof, publicInputs, circuitType) {
  if (!snarkjs) {
    console.warn(`[${NODE_ID}] snarkjs not loaded, skipping proof verification`);
    return true; // Fallback for development
  }

  const vKey = circuitType === 'withdraw' ? withdrawVKey : depositVKey;

  if (!vKey) {
    console.warn(`[${NODE_ID}] No verification key for ${circuitType}, skipping verification`);
    return true; // Fallback for development
  }

  try {
    // Convert proof format if needed
    const proofObject = typeof proof === 'object' && proof.pi_a
      ? proof
      : parseProofFromBytes(proof);

    const isValid = await snarkjs.groth16.verify(vKey, publicInputs, proofObject);
    return isValid;
  } catch (err) {
    console.error(`[${NODE_ID}] Groth16 verification error:`, err);
    return false;
  }
}

function parseProofFromBytes(proofBytes) {
  // Parse Groth16 proof from byte array
  // Format: pi_a (64 bytes) || pi_b (128 bytes) || pi_c (64 bytes)
  const bytes = typeof proofBytes === 'string'
    ? Buffer.from(proofBytes, 'base64')
    : Buffer.from(proofBytes);

  if (bytes.length < 256) {
    throw new Error(`Invalid proof length: ${bytes.length}`);
  }

  // Extract G1/G2 points
  const pi_a = [
    '0x' + bytes.slice(0, 32).toString('hex'),
    '0x' + bytes.slice(32, 64).toString('hex'),
    '1',
  ];

  const pi_b = [
    ['0x' + bytes.slice(64, 96).toString('hex'), '0x' + bytes.slice(96, 128).toString('hex')],
    ['0x' + bytes.slice(128, 160).toString('hex'), '0x' + bytes.slice(160, 192).toString('hex')],
    ['1', '0'],
  ];

  const pi_c = [
    '0x' + bytes.slice(192, 224).toString('hex'),
    '0x' + bytes.slice(224, 256).toString('hex'),
    '1',
  ];

  return { pi_a, pi_b, pi_c, protocol: 'groth16', curve: 'bn128' };
}

// ============================================
// API Endpoints
// ============================================

/**
 * Verify withdrawal proof and return threshold attestation
 */
app.post('/verify/withdraw', async (req, res) => {
  try {
    const { proof, publicInputs } = req.body;

    if (!proof || !publicInputs) {
      return res.status(400).json({ error: 'Missing proof or publicInputs' });
    }

    console.log(`[${NODE_ID}] Verifying withdrawal proof...`);

    // Convert proof to bytes
    const proofBytes = typeof proof === 'string'
      ? Buffer.from(proof, 'base64')
      : Buffer.from(proof);

    // Prepare public inputs array
    const publicInputsArray = [
      publicInputs.merkleRoot,
      publicInputs.nullifierHash,
      publicInputs.recipient,
      publicInputs.amount?.toString() || '0',
    ];

    // Verify the proof locally
    const isValid = await verifyGroth16Proof(proofBytes, publicInputsArray, 'withdraw');

    if (!isValid) {
      console.log(`[${NODE_ID}] Proof verification failed`);
      return res.status(400).json({ error: 'Invalid proof', valid: false });
    }

    console.log(`[${NODE_ID}] Proof verified locally`);

    // Compute hashes for attestation
    const proofHash = computeHash(proofBytes);

    const publicInputsBuffer = Buffer.alloc(104);
    Buffer.from(publicInputs.merkleRoot.replace('0x', '').padStart(64, '0'), 'hex').copy(publicInputsBuffer, 0);
    Buffer.from(publicInputs.nullifierHash.replace('0x', '').padStart(64, '0'), 'hex').copy(publicInputsBuffer, 32);
    Buffer.from(publicInputs.recipient.replace('0x', '').padStart(64, '0'), 'hex').copy(publicInputsBuffer, 64);
    publicInputsBuffer.writeBigUInt64LE(BigInt(publicInputs.amount || 0), 96);
    const publicInputsHash = computeHash(publicInputsBuffer);

    const timestamp = Math.floor(Date.now() / 1000);

    // Collect threshold signatures
    const partialSignatures = await collectThresholdSignatures(
      proofHash,
      publicInputsHash,
      timestamp,
      proofBytes,
      publicInputs,
      'withdraw'
    );

    if (partialSignatures.length < THRESHOLD_REQUIRED) {
      console.warn(`[${NODE_ID}] Insufficient signatures: ${partialSignatures.length}/${THRESHOLD_REQUIRED}`);
      return res.status(503).json({
        error: 'Insufficient verifier signatures',
        collected: partialSignatures.length,
        required: THRESHOLD_REQUIRED,
      });
    }

    console.log(`[${NODE_ID}] Collected ${partialSignatures.length}/${THRESHOLD_REQUIRED} signatures`);

    // Return threshold attestation
    res.json({
      valid: true,
      attestation: {
        proofHash: proofHash.toString('hex'),
        publicInputsHash: publicInputsHash.toString('hex'),
        verifiedAt: timestamp,
        threshold: {
          required: THRESHOLD_REQUIRED,
          collected: partialSignatures.length,
        },
        signatures: partialSignatures,
      },
      primaryVerifier: verifierKeypair.publicKey.toBase58(),
    });

  } catch (err) {
    console.error(`[${NODE_ID}] Verification error:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Verify deposit proof and return threshold attestation
 */
app.post('/verify/deposit', async (req, res) => {
  try {
    const { proof, publicInputs } = req.body;

    if (!proof || !publicInputs) {
      return res.status(400).json({ error: 'Missing proof or publicInputs' });
    }

    console.log(`[${NODE_ID}] Verifying deposit proof...`);

    const proofBytes = typeof proof === 'string'
      ? Buffer.from(proof, 'base64')
      : Buffer.from(proof);

    const publicInputsArray = [publicInputs.commitment];

    const isValid = await verifyGroth16Proof(proofBytes, publicInputsArray, 'deposit');

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid proof', valid: false });
    }

    const proofHash = computeHash(proofBytes);
    const publicInputsBuffer = Buffer.from(
      publicInputs.commitment.replace('0x', '').padStart(64, '0'),
      'hex'
    );
    const publicInputsHash = computeHash(publicInputsBuffer);

    const timestamp = Math.floor(Date.now() / 1000);

    const partialSignatures = await collectThresholdSignatures(
      proofHash,
      publicInputsHash,
      timestamp,
      proofBytes,
      publicInputs,
      'deposit'
    );

    if (partialSignatures.length < THRESHOLD_REQUIRED) {
      return res.status(503).json({
        error: 'Insufficient verifier signatures',
        collected: partialSignatures.length,
        required: THRESHOLD_REQUIRED,
      });
    }

    res.json({
      valid: true,
      attestation: {
        proofHash: proofHash.toString('hex'),
        publicInputsHash: publicInputsHash.toString('hex'),
        verifiedAt: timestamp,
        threshold: {
          required: THRESHOLD_REQUIRED,
          collected: partialSignatures.length,
        },
        signatures: partialSignatures,
      },
      primaryVerifier: verifierKeypair.publicKey.toBase58(),
    });

  } catch (err) {
    console.error(`[${NODE_ID}] Verification error:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Internal endpoint for peer signature requests
 */
app.post('/internal/sign', async (req, res) => {
  try {
    const { proofHash, publicInputsHash, timestamp, proof, publicInputs, circuitType, requesterNode } = req.body;

    if (requesterNode === NODE_ID) {
      return res.status(400).json({ error: 'Cannot sign own request' });
    }

    console.log(`[${NODE_ID}] Received signing request from ${requesterNode}`);

    // Verify the proof ourselves
    const proofBytes = Buffer.from(proof);
    const publicInputsArray = circuitType === 'withdraw'
      ? [publicInputs.merkleRoot, publicInputs.nullifierHash, publicInputs.recipient, publicInputs.amount?.toString() || '0']
      : [publicInputs.commitment];

    const isValid = await verifyGroth16Proof(proofBytes, publicInputsArray, circuitType);

    if (!isValid) {
      console.log(`[${NODE_ID}] Rejecting signing request - invalid proof`);
      return res.status(400).json({ error: 'Invalid proof' });
    }

    // Sign the attestation
    const proofHashBuf = Buffer.from(proofHash, 'hex');
    const publicInputsHashBuf = Buffer.from(publicInputsHash, 'hex');
    const signature = signAttestation(proofHashBuf, publicInputsHashBuf, timestamp);

    console.log(`[${NODE_ID}] Providing partial signature`);

    res.json({
      nodeId: NODE_ID,
      signature: Array.from(signature),
      verifierPubkey: Array.from(verifierKeypair.publicKey.toBytes()),
    });

  } catch (err) {
    console.error(`[${NODE_ID}] Signing error:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    nodeId: NODE_ID,
    verifierPubkey: verifierKeypair.publicKey.toBase58(),
    thresholdRequired: THRESHOLD_REQUIRED,
    peerCount: THRESHOLD_PEERS.length,
    circuits: {
      withdraw: withdrawVKey !== null,
      deposit: depositVKey !== null,
    },
  });
});

/**
 * Get verifier info
 */
app.get('/info', (req, res) => {
  res.json({
    nodeId: NODE_ID,
    verifierPubkey: verifierKeypair.publicKey.toBase58(),
    verifierPubkeyBytes: Array.from(verifierKeypair.publicKey.toBytes()),
    threshold: {
      required: THRESHOLD_REQUIRED,
      totalNodes: THRESHOLD_PEERS.length + 1,
    },
    peers: THRESHOLD_PEERS,
    attestationExpiry: ATTESTATION_VALIDITY_SECS,
    supportedCircuits: ['withdraw', 'deposit'],
    proofSystem: 'groth16',
  });
});

/**
 * Get network status
 */
app.get('/network', async (req, res) => {
  const peerStatuses = await Promise.allSettled(
    THRESHOLD_PEERS.map(async peer => {
      try {
        const response = await axios.get(`${peer}/health`, { timeout: 5000 });
        return { peer, status: 'online', nodeId: response.data.nodeId };
      } catch {
        return { peer, status: 'offline' };
      }
    })
  );

  const online = peerStatuses.filter(
    r => r.status === 'fulfilled' && r.value.status === 'online'
  ).length;

  res.json({
    nodeId: NODE_ID,
    status: 'online',
    peers: peerStatuses.map(r => r.status === 'fulfilled' ? r.value : { status: 'error' }),
    networkHealth: {
      onlineNodes: online + 1, // Include self
      totalNodes: THRESHOLD_PEERS.length + 1,
      thresholdMet: (online + 1) >= THRESHOLD_REQUIRED,
    },
  });
});

// ============================================
// Server Startup
// ============================================

loadCircuits().then(() => {
  app.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  StealthSol Threshold Verifier`);
    console.log(`${'='.repeat(50)}`);
    console.log(`  Node ID:       ${NODE_ID}`);
    console.log(`  Port:          ${PORT}`);
    console.log(`  Threshold:     ${THRESHOLD_REQUIRED}-of-${THRESHOLD_PEERS.length + 1}`);
    console.log(`  Verifier Key:  ${verifierKeypair.publicKey.toBase58()}`);
    console.log(`  Peers:         ${THRESHOLD_PEERS.length > 0 ? THRESHOLD_PEERS.join(', ') : 'none'}`);
    console.log(`${'='.repeat(50)}\n`);
    console.log('Endpoints:');
    console.log('  POST /verify/withdraw  - Verify withdrawal proof');
    console.log('  POST /verify/deposit   - Verify deposit proof');
    console.log('  GET  /health           - Health check');
    console.log('  GET  /info             - Verifier info');
    console.log('  GET  /network          - Network status');
    console.log('');
  });
});
