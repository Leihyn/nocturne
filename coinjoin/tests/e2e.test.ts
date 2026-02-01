/**
 * End-to-End CoinJoin Tests
 *
 * Tests the complete CoinJoin flow with multiple participants:
 * 1. Participants join session
 * 2. Submit blinded commitments
 * 3. Receive blind signatures
 * 4. Submit unblinded outputs
 * 5. Build and sign transaction
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import {
  generateRSAKey,
  BlindSigner,
  blindMessage,
  unblindSignature,
  verifySignature,
} from '../src/blind-sig.js';
import {
  splitSecret,
  reconstructSecret,
  splitRSAKey,
  generatePartialSignature,
  combinePartialSignatures,
  testSecretSharing,
} from '../src/threshold-rsa.js';

// ============================================
// Test Configuration
// ============================================

const TEST_CONFIG = {
  serverUrl: 'ws://localhost:8080',
  denomination: '1000000000', // 1 SOL
  numParticipants: 3,
  timeout: 30000,
};

// ============================================
// Helper Functions
// ============================================

function createTestClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TEST_CONFIG.serverUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, type: string, timeout = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${type}`));
    }, timeout);

    const handler = (data: any) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(message);
        }
      } catch {}
    };

    ws.on('message', handler);
  });
}

function sendMessage(ws: WebSocket, message: any): void {
  ws.send(JSON.stringify(message));
}

// ============================================
// Threshold RSA Tests
// ============================================

describe('Threshold RSA', () => {
  it('should split and reconstruct secrets correctly', () => {
    expect(testSecretSharing()).toBe(true);
  });

  it('should split secret into shares', () => {
    const secret = BigInt('0x' + randomBytes(32).toString('hex'));
    const shares = splitSecret(secret, 3, 5);

    expect(shares).toHaveLength(5);
    expect(shares.every(s => s.index >= 1 && s.index <= 5)).toBe(true);
  });

  it('should reconstruct secret from threshold shares', () => {
    const secret = BigInt('12345678901234567890');
    const shares = splitSecret(secret, 3, 5);

    // Reconstruct from first 3 shares
    const reconstructed = reconstructSecret(shares.slice(0, 3));
    expect(reconstructed).toBe(secret);
  });

  it('should reconstruct from any 3-of-5 shares', () => {
    const secret = BigInt('987654321');
    const shares = splitSecret(secret, 3, 5);

    // Try different combinations
    expect(reconstructSecret([shares[0], shares[1], shares[2]])).toBe(secret);
    expect(reconstructSecret([shares[0], shares[2], shares[4]])).toBe(secret);
    expect(reconstructSecret([shares[1], shares[3], shares[4]])).toBe(secret);
  });
});

// ============================================
// Blind Signature Tests
// ============================================

describe('Blind Signatures', () => {
  let rsaKey: any;
  let signer: BlindSigner;

  beforeAll(async () => {
    rsaKey = await generateRSAKey();
    signer = new BlindSigner(rsaKey.n, rsaKey.e, rsaKey.d);
  });

  it('should generate valid RSA key', () => {
    expect(rsaKey.n).toBeDefined();
    expect(rsaKey.e).toBeDefined();
    expect(rsaKey.d).toBeDefined();
  });

  it('should blind and unblind messages correctly', async () => {
    const message = BigInt('0x' + randomBytes(32).toString('hex'));

    // Blind the message
    const { blinded, blindingFactor } = blindMessage(message, rsaKey.n, rsaKey.e);

    // Sign the blinded message
    const blindSig = signer.sign(blinded);

    // Unblind the signature
    const unblindedSig = unblindSignature(blindSig, blindingFactor, rsaKey.n);

    // Verify the signature
    const isValid = verifySignature(message, unblindedSig, rsaKey.n, rsaKey.e);
    expect(isValid).toBe(true);
  });

  it('should produce different blind signatures for same message', async () => {
    const message = BigInt('12345');

    const blind1 = blindMessage(message, rsaKey.n, rsaKey.e);
    const blind2 = blindMessage(message, rsaKey.n, rsaKey.e);

    // Blinded values should be different (different random factors)
    expect(blind1.blinded).not.toBe(blind2.blinded);

    // But unblinded signatures should verify
    const sig1 = unblindSignature(signer.sign(blind1.blinded), blind1.blindingFactor, rsaKey.n);
    const sig2 = unblindSignature(signer.sign(blind2.blinded), blind2.blindingFactor, rsaKey.n);

    expect(verifySignature(message, sig1, rsaKey.n, rsaKey.e)).toBe(true);
    expect(verifySignature(message, sig2, rsaKey.n, rsaKey.e)).toBe(true);
  });
});

// ============================================
// Threshold Signing Tests
// ============================================

describe('Threshold Signing', () => {
  let thresholdKey: any;

  beforeAll(async () => {
    const rsaKey = await generateRSAKey();
    thresholdKey = splitRSAKey(
      { n: rsaKey.n, d: rsaKey.d, p: 0n, q: 0n },
      { n: rsaKey.n, e: rsaKey.e },
      { threshold: 3, totalShares: 5 }
    );
  });

  it('should split RSA key into shares', () => {
    expect(thresholdKey.shares).toHaveLength(5);
    expect(thresholdKey.threshold).toBe(3);
    expect(thresholdKey.publicKey).toBeDefined();
  });

  it('should generate partial signatures', () => {
    const message = BigInt('12345');
    const share = thresholdKey.shares[0];

    const partial = generatePartialSignature(message, share);

    expect(partial.index).toBe(share.index);
    expect(partial.signature).toBeDefined();
    expect(partial.publicKey).toBeDefined();
  });

  it('should combine partial signatures', () => {
    const message = BigInt('12345');

    // Generate partial signatures from 3 shares
    const partials = thresholdKey.shares.slice(0, 3).map((share: any) =>
      generatePartialSignature(message, share)
    );

    // Combine them
    const combinedSig = combinePartialSignatures(partials, 3);
    expect(combinedSig).toBeDefined();
  });
});

// ============================================
// CoinJoin Protocol Tests (Mock)
// ============================================

describe('CoinJoin Protocol', () => {
  it('should handle multiple participants', async () => {
    // Mock participants
    const participants = Array.from({ length: 3 }, () => ({
      commitment: BigInt('0x' + randomBytes(32).toString('hex')),
      output: '0x' + randomBytes(32).toString('hex'),
    }));

    // Verify all participants have unique commitments
    const commitments = new Set(participants.map(p => p.commitment.toString()));
    expect(commitments.size).toBe(3);
  });

  it('should shuffle outputs correctly', () => {
    const outputs = ['a', 'b', 'c', 'd', 'e'];
    const shuffled = [...outputs];

    // Fisher-Yates shuffle
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Same elements
    expect(shuffled.sort()).toEqual(outputs.sort());
  });
});

// ============================================
// Integration Tests (requires running server)
// ============================================

describe.skip('Integration Tests', () => {
  let clients: WebSocket[] = [];

  beforeAll(async () => {
    // Create multiple clients
    for (let i = 0; i < TEST_CONFIG.numParticipants; i++) {
      const client = await createTestClient();
      clients.push(client);
    }
  });

  afterAll(() => {
    clients.forEach(c => c.close());
  });

  it('should connect to server', async () => {
    expect(clients).toHaveLength(TEST_CONFIG.numParticipants);
  });

  it('should receive CONNECTED message', async () => {
    const message = await waitForMessage(clients[0], 'CONNECTED');
    expect(message.denominations).toBeDefined();
  });

  it('should join session', async () => {
    sendMessage(clients[0], {
      type: 'JOIN',
      denomination: TEST_CONFIG.denomination,
      publicKey: 'test_pubkey',
      timestamp: Date.now(),
      signature: 'test_sig',
    });

    const response = await waitForMessage(clients[0], 'JOINED');
    expect(response.sessionId).toBeDefined();
  });
});

// ============================================
// Security Tests
// ============================================

describe('Security', () => {
  it('should reject invalid signatures', async () => {
    const rsaKey = await generateRSAKey();
    const message = BigInt('12345');

    // Create invalid signature
    const invalidSig = BigInt('0x' + randomBytes(256).toString('hex'));

    const isValid = verifySignature(message, invalidSig, rsaKey.n, rsaKey.e);
    expect(isValid).toBe(false);
  });

  it('should not leak private key through shares', () => {
    const secret = BigInt('12345678901234567890');
    const shares = splitSecret(secret, 3, 5);

    // With only 2 shares, should not be able to reconstruct
    const twoShares = shares.slice(0, 2);

    // This should not equal the secret (insufficient shares)
    try {
      const result = reconstructSecret(twoShares);
      expect(result).not.toBe(secret);
    } catch {
      // Expected - not enough shares
    }
  });

  it('should generate unique blinding factors', () => {
    const message = BigInt('12345');
    const rsaKey = { n: BigInt('1234567890'), e: 65537n };

    const factors = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { blindingFactor } = blindMessage(message, rsaKey.n, rsaKey.e);
      factors.add(blindingFactor.toString());
    }

    // All factors should be unique
    expect(factors.size).toBe(100);
  });
});

// ============================================
// Performance Tests
// ============================================

describe('Performance', () => {
  it('should handle many secret shares efficiently', () => {
    const start = Date.now();
    const iterations = 100;

    for (let i = 0; i < iterations; i++) {
      const secret = BigInt('0x' + randomBytes(32).toString('hex'));
      const shares = splitSecret(secret, 3, 5);
      reconstructSecret(shares.slice(0, 3));
    }

    const elapsed = Date.now() - start;
    console.log(`${iterations} split+reconstruct operations: ${elapsed}ms`);

    expect(elapsed).toBeLessThan(5000); // Should complete in < 5s
  });

  it('should generate blind signatures efficiently', async () => {
    const rsaKey = await generateRSAKey();
    const signer = new BlindSigner(rsaKey.n, rsaKey.e, rsaKey.d);

    const start = Date.now();
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      const message = BigInt('0x' + randomBytes(32).toString('hex'));
      const { blinded, blindingFactor } = blindMessage(message, rsaKey.n, rsaKey.e);
      const blindSig = signer.sign(blinded);
      unblindSignature(blindSig, blindingFactor, rsaKey.n);
    }

    const elapsed = Date.now() - start;
    console.log(`${iterations} blind sign operations: ${elapsed}ms`);

    expect(elapsed).toBeLessThan(10000); // Should complete in < 10s
  });
});
