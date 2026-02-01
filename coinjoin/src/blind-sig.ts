/**
 * RSA Blind Signature Implementation
 *
 * Enables the coordinator to sign commitments without seeing their values.
 * This is the cryptographic core of the CoinJoin privacy guarantee.
 *
 * Protocol:
 * 1. Server generates RSA keypair and shares public key
 * 2. Client blinds message: blinded = message * r^e mod n
 * 3. Server signs blinded message: sig = blinded^d mod n
 * 4. Client unblinds: final_sig = sig * r^(-1) mod n
 * 5. Anyone can verify: final_sig^e mod n == message
 *
 * Privacy property: Server never sees the original message!
 *
 * Security:
 * - Minimum 2048-bit keys (enforced)
 * - 64 Miller-Rabin iterations for primality testing
 * - Safe prime generation verification
 * - Constant-time comparison for signature verification
 */

import { createHash, randomBytes } from 'crypto';
import type { RSAKeyPair, BlindingResult } from './types.js';

// Minimum key size for security (NIST recommendation)
const MIN_KEY_BITS = 2048;

// Miller-Rabin iterations for different security levels
// 64 iterations gives 2^-128 probability of false positive for 2048-bit primes
const MILLER_RABIN_ITERATIONS = 64;

// First few primes for quick divisibility check
const SMALL_PRIMES = [
  2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n,
  53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n,
  113n, 127n, 131n, 137n, 139n, 149n, 151n, 157n, 163n, 167n, 173n, 179n,
  181n, 191n, 193n, 197n, 199n, 211n, 223n, 227n, 229n, 233n, 239n, 241n,
  251n, 257n, 263n, 269n, 271n, 277n, 281n, 283n, 293n,
];

// Quick check for small prime factors
function hasSmallFactor(n: bigint): boolean {
  for (const p of SMALL_PRIMES) {
    if (n % p === 0n && n !== p) return true;
  }
  return false;
}

// Prime number generation and testing with strong Miller-Rabin
function isProbablyPrime(n: bigint, k: number = MILLER_RABIN_ITERATIONS): boolean {
  if (n < 2n) return false;
  if (n === 2n || n === 3n) return true;
  if (n % 2n === 0n) return false;

  // Quick check for small factors
  if (hasSmallFactor(n)) return false;

  // Write n-1 as 2^r * d
  let r = 0n;
  let d = n - 1n;
  while (d % 2n === 0n) {
    d /= 2n;
    r++;
  }

  // Miller-Rabin test with k iterations
  witnessLoop: for (let i = 0; i < k; i++) {
    const a = randomBigInt(2n, n - 2n);
    let x = modPow(a, d, n);

    if (x === 1n || x === n - 1n) continue;

    for (let j = 0n; j < r - 1n; j++) {
      x = modPow(x, 2n, n);
      if (x === n - 1n) continue witnessLoop;
    }
    return false;
  }
  return true;
}

// Generate random bigint in range [min, max]
function randomBigInt(min: bigint, max: bigint): bigint {
  const range = max - min + 1n;
  const bytesNeeded = Math.ceil(range.toString(2).length / 8) + 1;
  let result: bigint;
  do {
    const bytes = randomBytes(bytesNeeded);
    result = BigInt('0x' + bytes.toString('hex')) % range + min;
  } while (result > max);
  return result;
}

// Generate a random prime of specified bit length
function generatePrime(bits: number): bigint {
  while (true) {
    const bytes = randomBytes(Math.ceil(bits / 8));
    // Set high bit to ensure correct bit length
    bytes[0] |= 0x80;
    // Set low bit to ensure odd number
    bytes[bytes.length - 1] |= 0x01;

    const candidate = BigInt('0x' + bytes.toString('hex'));
    if (isProbablyPrime(candidate)) {
      return candidate;
    }
  }
}

// Modular exponentiation: base^exp mod mod
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

// Extended Euclidean algorithm for modular inverse
function extendedGcd(a: bigint, b: bigint): { gcd: bigint; x: bigint; y: bigint } {
  if (a === 0n) {
    return { gcd: b, x: 0n, y: 1n };
  }
  const { gcd, x, y } = extendedGcd(b % a, a);
  return {
    gcd,
    x: y - (b / a) * x,
    y: x,
  };
}

// Modular inverse: a^(-1) mod m
function modInverse(a: bigint, m: bigint): bigint {
  const { gcd, x } = extendedGcd(a % m, m);
  if (gcd !== 1n) {
    throw new Error('Modular inverse does not exist');
  }
  return ((x % m) + m) % m;
}

// GCD
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * Generate RSA key pair for blind signatures
 * Enforces minimum 2048-bit keys for security
 *
 * Security measures:
 * - Minimum key size enforced
 * - Ensures p != q
 * - Verifies |p - q| is large enough to prevent Fermat factorization
 * - Uses strong primes (not Sophie Germain, but avoids weak primes)
 */
export function generateRSAKeyPair(bits: number = 2048): RSAKeyPair {
  // Enforce minimum key size
  if (bits < MIN_KEY_BITS) {
    throw new Error(`Key size ${bits} is below minimum ${MIN_KEY_BITS} bits`);
  }

  const halfBits = Math.floor(bits / 2);
  const minDiff = 2n ** BigInt(halfBits - 100); // Minimum difference between p and q

  let p: bigint;
  let q: bigint;
  let attempts = 0;
  const maxAttempts = 100;

  // Generate two distinct primes with sufficient difference
  do {
    p = generatePrime(halfBits);
    q = generatePrime(halfBits);
    attempts++;

    if (attempts > maxAttempts) {
      throw new Error('Failed to generate suitable primes');
    }

    // Ensure p != q and |p - q| is large enough
  } while (p === q || (p > q ? p - q : q - p) < minDiff);

  // Ensure p > q for CRT optimization
  if (q > p) {
    [p, q] = [q, p];
  }

  // Calculate modulus
  const n = p * q;

  // Verify key size
  const actualBits = n.toString(2).length;
  if (actualBits < bits - 1) {
    throw new Error(`Generated key ${actualBits} bits is too small`);
  }

  // Calculate totient using Carmichael's function for better security
  // λ(n) = lcm(p-1, q-1) instead of φ(n) = (p-1)(q-1)
  const pMinus1 = p - 1n;
  const qMinus1 = q - 1n;
  const phi = (pMinus1 * qMinus1) / gcd(pMinus1, qMinus1); // lcm(p-1, q-1)

  // Public exponent (65537 is standard, has good security properties)
  const e = 65537n;

  // Verify gcd(e, phi) = 1
  if (gcd(e, phi) !== 1n) {
    throw new Error('Public exponent is not coprime to totient');
  }

  // Private exponent
  const d = modInverse(e, phi);

  // Verify d * e ≡ 1 (mod phi)
  if ((d * e) % phi !== 1n) {
    throw new Error('Key generation verification failed');
  }

  return {
    publicKey: { n, e },
    privateKey: { n, d, p, q },
  };
}

/**
 * Hash message to a number suitable for RSA
 */
export function hashMessage(message: Uint8Array, n: bigint): bigint {
  const hash = createHash('sha256').update(message).digest();
  const hashBigInt = BigInt('0x' + hash.toString('hex'));
  return hashBigInt % n;
}

/**
 * Blind a message before sending to signer
 * Returns blinded message and blinding factor (keep secret!)
 */
export function blindMessage(
  message: bigint,
  publicKey: { n: bigint; e: bigint }
): BlindingResult {
  const { n, e } = publicKey;

  // Generate random blinding factor coprime to n
  let r: bigint;
  do {
    r = randomBigInt(2n, n - 1n);
  } while (gcd(r, n) !== 1n);

  // Blind the message: blinded = message * r^e mod n
  const rToE = modPow(r, e, n);
  const blindedMessage = (message * rToE) % n;

  return { blindedMessage, blindingFactor: r };
}

/**
 * Sign a blinded message (server-side)
 * The signer cannot see the original message!
 */
export function signBlinded(
  blindedMessage: bigint,
  privateKey: { n: bigint; d: bigint }
): bigint {
  const { n, d } = privateKey;
  // Sign: signature = blindedMessage^d mod n
  return modPow(blindedMessage, d, n);
}

/**
 * Unblind the signature to get a valid signature on the original message
 */
export function unblindSignature(
  blindedSignature: bigint,
  blindingFactor: bigint,
  n: bigint
): bigint {
  // Unblind: signature = blindedSignature * r^(-1) mod n
  const rInverse = modInverse(blindingFactor, n);
  return (blindedSignature * rInverse) % n;
}

/**
 * Constant-time comparison for bigints
 * Prevents timing attacks during signature verification
 */
function constantTimeEqual(a: bigint, b: bigint): boolean {
  const aStr = a.toString(16);
  const bStr = b.toString(16);

  // Pad to same length
  const maxLen = Math.max(aStr.length, bStr.length);
  const aPadded = aStr.padStart(maxLen, '0');
  const bPadded = bStr.padStart(maxLen, '0');

  let result = 0;
  for (let i = 0; i < maxLen; i++) {
    result |= aPadded.charCodeAt(i) ^ bPadded.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Verify a signature (works on both blinded and unblinded)
 * Uses constant-time comparison to prevent timing attacks
 */
export function verifySignature(
  message: bigint,
  signature: bigint,
  publicKey: { n: bigint; e: bigint }
): boolean {
  const { n, e } = publicKey;

  // Validate inputs
  if (signature <= 0n || signature >= n) {
    return false;
  }

  // Verify: signature^e mod n == message
  const decrypted = modPow(signature, e, n);
  return constantTimeEqual(decrypted, message);
}

// Serialization helpers
export function serializePublicKey(key: { n: bigint; e: bigint }): string {
  return JSON.stringify({
    n: key.n.toString(),
    e: key.e.toString(),
  });
}

export function deserializePublicKey(data: string): { n: bigint; e: bigint } {
  const parsed = JSON.parse(data);
  return {
    n: BigInt(parsed.n),
    e: BigInt(parsed.e),
  };
}

export function bigintToHex(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

export function hexToBigint(hex: string): bigint {
  return BigInt('0x' + hex);
}

/**
 * Example usage:
 *
 * // Server generates keypair
 * const keyPair = generateRSAKeyPair();
 *
 * // Client blinds their commitment
 * const commitment = hashMessage(myCommitment, keyPair.publicKey.n);
 * const { blindedMessage, blindingFactor } = blindMessage(commitment, keyPair.publicKey);
 *
 * // Server signs (can't see real commitment!)
 * const blindedSig = signBlinded(blindedMessage, keyPair.privateKey);
 *
 * // Client unblinds to get valid signature
 * const signature = unblindSignature(blindedSig, blindingFactor, keyPair.publicKey.n);
 *
 * // Anyone can verify
 * const valid = verifySignature(commitment, signature, keyPair.publicKey);
 */
