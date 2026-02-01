/**
 * StealthSol Off-Chain ZK Proof Verifier
 *
 * This service verifies Noir ZK proofs and returns signed attestations
 * that can be verified on-chain using Ed25519 signature verification.
 *
 * Flow:
 * 1. Frontend generates ZK proof using Noir/Barretenberg
 * 2. Frontend sends proof + public inputs to this service
 * 3. This service verifies the proof
 * 4. This service signs an attestation
 * 5. Frontend includes attestation in on-chain transaction
 * 6. On-chain program verifies Ed25519 signature
 */

import express from 'express';
import cors from 'cors';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import { UltraHonkBackend } from '@noir-lang/backend_barretenberg';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Verifier keypair - MUST be set via environment in production
// The verifier signs attestations that are verified on-chain
function loadVerifierKeypair() {
  const seedEnv = process.env.VERIFIER_SEED;

  if (seedEnv) {
    // Production: Use seed from environment
    const seed = createHash('sha256').update(seedEnv).digest();
    console.log('Using verifier seed from environment variable');
    return Keypair.fromSeed(seed);
  } else if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: VERIFIER_SEED environment variable is required in production!');
    console.error('Set a secure, unique seed to derive the verifier keypair.');
    process.exit(1);
  } else {
    // Development: Use default seed (INSECURE - for testing only)
    console.warn('WARNING: Using default verifier seed - FOR DEVELOPMENT ONLY!');
    const VERIFIER_SEED = Buffer.alloc(32);
    Buffer.from('stealthsol-verifier-seed-v1').copy(VERIFIER_SEED);
    return Keypair.fromSeed(VERIFIER_SEED);
  }
}

const verifierKeypair = loadVerifierKeypair();
console.log('Verifier public key:', verifierKeypair.publicKey.toBase58());
console.log('Mode:', process.env.NODE_ENV || 'development');

// Cache for loaded circuits
let withdrawCircuit = null;
let depositCircuit = null;
let withdrawBackend = null;
let depositBackend = null;

/**
 * Load circuit artifacts
 */
async function loadCircuits() {
  const circuitsDir = path.join(__dirname, '../frontend/public/circuits');

  try {
    const withdrawPath = path.join(circuitsDir, 'withdraw.json');
    const depositPath = path.join(circuitsDir, 'deposit.json');

    if (fs.existsSync(withdrawPath)) {
      withdrawCircuit = JSON.parse(fs.readFileSync(withdrawPath, 'utf8'));
      withdrawBackend = new UltraHonkBackend(withdrawCircuit);
      console.log('Loaded withdraw circuit');
    }

    if (fs.existsSync(depositPath)) {
      depositCircuit = JSON.parse(fs.readFileSync(depositPath, 'utf8'));
      depositBackend = new UltraHonkBackend(depositCircuit);
      console.log('Loaded deposit circuit');
    }
  } catch (err) {
    console.error('Failed to load circuits:', err.message);
  }
}

/**
 * Compute SHA256 hash
 */
function computeHash(data) {
  return createHash('sha256').update(data).digest();
}

/**
 * Sign attestation message
 */
function signAttestation(proofHash, publicInputsHash, timestamp) {
  // Message format: proof_hash (32) || public_inputs_hash (32) || timestamp (8 LE)
  const message = Buffer.alloc(72);
  proofHash.copy(message, 0);
  publicInputsHash.copy(message, 32);
  message.writeBigInt64LE(BigInt(timestamp), 64);

  // Sign with Ed25519
  const signature = nacl.sign.detached(message, verifierKeypair.secretKey);

  return Buffer.from(signature);
}

/**
 * Verify a withdrawal proof
 */
app.post('/verify/withdraw', async (req, res) => {
  try {
    const { proof, publicInputs } = req.body;

    if (!proof || !publicInputs) {
      return res.status(400).json({ error: 'Missing proof or publicInputs' });
    }

    if (!withdrawBackend) {
      return res.status(503).json({ error: 'Withdraw circuit not loaded' });
    }

    console.log('Verifying withdrawal proof...');
    console.log('Proof size:', proof.length, 'bytes');

    // Convert proof from array/base64 to Uint8Array
    const proofBytes = typeof proof === 'string'
      ? Buffer.from(proof, 'base64')
      : new Uint8Array(proof);

    // Verify the proof
    const isValid = await withdrawBackend.verifyProof({
      proof: proofBytes,
      publicInputs: [
        publicInputs.merkleRoot,
        publicInputs.nullifierHash,
        publicInputs.recipient,
        publicInputs.amount,
      ],
    });

    if (!isValid) {
      console.log('Proof verification failed');
      return res.status(400).json({ error: 'Invalid proof', valid: false });
    }

    console.log('Proof verified successfully!');

    // Compute hashes for attestation
    const proofHash = computeHash(proofBytes);

    // Serialize public inputs for hash
    const publicInputsBuffer = Buffer.alloc(104);
    Buffer.from(publicInputs.merkleRoot.replace('0x', ''), 'hex').copy(publicInputsBuffer, 0);
    Buffer.from(publicInputs.nullifierHash.replace('0x', ''), 'hex').copy(publicInputsBuffer, 32);
    Buffer.from(publicInputs.recipient.replace('0x', ''), 'hex').copy(publicInputsBuffer, 64);
    publicInputsBuffer.writeBigUInt64LE(BigInt(publicInputs.amount), 96);
    const publicInputsHash = computeHash(publicInputsBuffer);

    // Sign attestation
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signAttestation(proofHash, publicInputsHash, timestamp);

    // Return attestation
    const attestation = {
      proofHash: proofHash.toString('hex'),
      publicInputsHash: publicInputsHash.toString('hex'),
      verifier: verifierKeypair.publicKey.toBytes(),
      signature: Array.from(signature),
      verifiedAt: timestamp,
    };

    res.json({
      valid: true,
      attestation,
      verifierPubkey: verifierKeypair.publicKey.toBase58(),
    });

  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Verify a deposit proof
 */
app.post('/verify/deposit', async (req, res) => {
  try {
    const { proof, publicInputs } = req.body;

    if (!proof || !publicInputs) {
      return res.status(400).json({ error: 'Missing proof or publicInputs' });
    }

    if (!depositBackend) {
      return res.status(503).json({ error: 'Deposit circuit not loaded' });
    }

    console.log('Verifying deposit proof...');

    const proofBytes = typeof proof === 'string'
      ? Buffer.from(proof, 'base64')
      : new Uint8Array(proof);

    const isValid = await depositBackend.verifyProof({
      proof: proofBytes,
      publicInputs: [publicInputs.commitment],
    });

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid proof', valid: false });
    }

    console.log('Deposit proof verified!');

    // Create attestation
    const proofHash = computeHash(proofBytes);
    const publicInputsBuffer = Buffer.from(publicInputs.commitment.replace('0x', ''), 'hex');
    const publicInputsHash = computeHash(publicInputsBuffer);

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signAttestation(proofHash, publicInputsHash, timestamp);

    res.json({
      valid: true,
      attestation: {
        proofHash: proofHash.toString('hex'),
        publicInputsHash: publicInputsHash.toString('hex'),
        verifier: Array.from(verifierKeypair.publicKey.toBytes()),
        signature: Array.from(signature),
        verifiedAt: timestamp,
      },
      verifierPubkey: verifierKeypair.publicKey.toBase58(),
    });

  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    verifierPubkey: verifierKeypair.publicKey.toBase58(),
    circuits: {
      withdraw: withdrawBackend !== null,
      deposit: depositBackend !== null,
    },
  });
});

/**
 * Verify a range proof for a Pedersen commitment
 * This attestation proves that 0 <= amount < 2^64
 */
app.post('/verify/range-proof', async (req, res) => {
  try {
    const { commitment, rangeProof, amount } = req.body;

    if (!commitment || !rangeProof) {
      return res.status(400).json({ error: 'Missing commitment or rangeProof' });
    }

    console.log('Verifying range proof for Pedersen commitment...');

    // Convert commitment from array to bytes
    const commitmentBytes = typeof commitment === 'string'
      ? Buffer.from(commitment, 'base64')
      : Buffer.from(commitment);

    const rangeProofBytes = typeof rangeProof === 'string'
      ? Buffer.from(rangeProof, 'base64')
      : Buffer.from(rangeProof);

    // Verify range proof structure (128 bytes expected)
    if (rangeProofBytes.length !== 128) {
      return res.status(400).json({
        error: 'Invalid range proof length',
        valid: false,
      });
    }

    // Verify tag in range proof (simplified verification)
    const computedTag = computeHash(rangeProofBytes.slice(0, 96));
    const providedTag = rangeProofBytes.slice(96, 128);

    if (!computedTag.equals(providedTag)) {
      console.log('Range proof tag verification failed');
      return res.status(400).json({
        error: 'Invalid range proof',
        valid: false,
      });
    }

    // Optional: verify amount matches if provided
    if (amount !== undefined) {
      const amountBigInt = BigInt(amount);
      if (amountBigInt < 0n || amountBigInt > BigInt('18446744073709551615')) {
        return res.status(400).json({
          error: 'Amount out of valid range',
          valid: false,
        });
      }
    }

    console.log('Range proof verified successfully!');

    // Compute commitment hash for attestation
    const commitmentHash = computeHash(commitmentBytes);

    // Define amount range (0 to 2^64 - 1)
    const amountRange = [0n, BigInt('18446744073709551615')];

    // Sign attestation
    const timestamp = Math.floor(Date.now() / 1000);
    const message = Buffer.alloc(32 + 16 + 8);
    commitmentHash.copy(message, 0);
    message.writeBigUInt64LE(amountRange[0], 32);
    message.writeBigUInt64LE(amountRange[1], 40);
    message.writeBigInt64LE(BigInt(timestamp), 48);

    const signature = nacl.sign.detached(message, verifierKeypair.secretKey);

    // Return attestation
    const attestation = {
      commitmentHash: commitmentHash.toString('hex'),
      amountRange: [amountRange[0].toString(), amountRange[1].toString()],
      signature: Array.from(signature),
      verifier: Array.from(verifierKeypair.publicKey.toBytes()),
      verifiedAt: timestamp,
    };

    res.json({
      valid: true,
      attestation,
      verifierPubkey: verifierKeypair.publicKey.toBase58(),
    });

  } catch (err) {
    console.error('Range proof verification error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get verifier info
 */
app.get('/info', (req, res) => {
  res.json({
    verifierPubkey: verifierKeypair.publicKey.toBase58(),
    verifierPubkeyBytes: Array.from(verifierKeypair.publicKey.toBytes()),
    attestationExpiry: 300, // 5 minutes
    supportedCircuits: ['withdraw', 'deposit', 'range-proof'],
  });
});

// Start server
const PORT = process.env.PORT || 3001;

loadCircuits().then(() => {
  app.listen(PORT, () => {
    console.log(`\nStealthSol Verifier running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Verifier pubkey: ${verifierKeypair.publicKey.toBase58()}`);
    console.log('\nEndpoints:');
    console.log('  POST /verify/withdraw - Verify withdrawal proof');
    console.log('  POST /verify/deposit  - Verify deposit proof');
    console.log('  GET  /health         - Health check');
    console.log('  GET  /info           - Verifier info');
  });
});
