import { Keypair, PublicKey } from '@solana/web3.js';
import { x25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

// Stealth address utilities using proper X25519 ECDH

const DOMAIN_SEPARATOR = 'stealthsol_v1';

// Field prime for curve25519: 2^255 - 19
const P = BigInt('57896044618658097711785492504343953926634992332820282019728792003956564819949');

// Convert Ed25519 public key (Edwards y-coordinate) to X25519 public key (Montgomery u-coordinate)
// Formula: u = (1 + y) / (1 - y) mod p
function ed25519PubToX25519(ed25519Pub: Uint8Array): Uint8Array {
  // Ed25519 public key is the y-coordinate in little-endian
  let y = BigInt(0);
  for (let i = ed25519Pub.length - 1; i >= 0; i--) {
    y = (y << BigInt(8)) | BigInt(ed25519Pub[i]);
  }
  // Clear the sign bit
  y = y & ((BigInt(1) << BigInt(255)) - BigInt(1));

  // u = (1 + y) * inverse(1 - y) mod p
  const one = BigInt(1);
  const numerator = mod(one + y, P);
  const denominator = mod(one - y, P);
  const u = mod(numerator * modInverse(denominator, P), P);

  // Convert to 32-byte little-endian
  const result = new Uint8Array(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(val & BigInt(0xff));
    val = val >> BigInt(8);
  }
  return result;
}

// Convert Ed25519 private key seed to X25519 private key
// The Ed25519 private key is SHA-512(seed)[0:32] with clamping
async function ed25519PrivToX25519(seed: Uint8Array): Promise<Uint8Array> {
  const hash = await sha512(seed);
  const scalar = hash.slice(0, 32);
  // Clamp the scalar for X25519
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

// SHA-512 hash
async function sha512(data: Uint8Array): Promise<Uint8Array> {
  // Copy to avoid SharedArrayBuffer issues
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-512', copy);
  return new Uint8Array(hashBuffer);
}

// Modular arithmetic helpers
function mod(n: bigint, p: bigint): bigint {
  const result = n % p;
  return result >= 0 ? result : result + p;
}

function modInverse(a: bigint, p: bigint): bigint {
  // Extended Euclidean algorithm
  let [old_r, r] = [a, p];
  let [old_s, s] = [BigInt(1), BigInt(0)];

  while (r !== BigInt(0)) {
    const quotient = old_r / r;
    [old_r, r] = [r, old_r - quotient * r];
    [old_s, s] = [s, old_s - quotient * s];
  }

  return mod(old_s, p);
}

// Generate random 32 bytes
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// SHA-256 hash
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Copy to avoid SharedArrayBuffer issues
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(hashBuffer);
}

// Combine arrays
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export interface StealthKeys {
  scanSecret: Uint8Array;
  spendSecret: Uint8Array;
  scanPubkey: Uint8Array;
  spendPubkey: Uint8Array;
}

export interface StealthPayment {
  ephemeralPubkey: Uint8Array;
  stealthPubkey: Uint8Array;
  stealthAddress: PublicKey;
}

// Generate stealth keys from a Solana keypair
export async function generateStealthKeys(seedKeypair: Keypair): Promise<StealthKeys> {
  const seed = seedKeypair.secretKey.slice(0, 32);

  // Derive scan and spend secrets deterministically
  const scanSeed = await sha256(concat(new TextEncoder().encode('scan:'), seed));
  const spendSeed = await sha256(concat(new TextEncoder().encode('spend:'), seed));

  // Create keypairs from seeds
  const scanKeypair = Keypair.fromSeed(scanSeed);
  const spendKeypair = Keypair.fromSeed(spendSeed);

  return {
    scanSecret: scanSeed,
    spendSecret: spendSeed,
    scanPubkey: scanKeypair.publicKey.toBytes(),
    spendPubkey: spendKeypair.publicKey.toBytes(),
  };
}

// Format meta-address for sharing
export function formatMetaAddress(scanPubkey: Uint8Array, spendPubkey: Uint8Array): string {
  const combined = concat(scanPubkey, spendPubkey);
  return `stealth:${bs58.encode(combined)}`;
}

// Parse meta-address
export function parseMetaAddress(metaAddress: string): { scanPubkey: Uint8Array; spendPubkey: Uint8Array } {
  const encoded = metaAddress.startsWith('stealth:')
    ? metaAddress.slice(8)
    : metaAddress;

  const bytes = bs58.decode(encoded);
  if (bytes.length !== 64) {
    throw new Error('Invalid meta-address length');
  }

  return {
    scanPubkey: bytes.slice(0, 32),
    spendPubkey: bytes.slice(32, 64),
  };
}

// Compute stealth address for sending
export async function computeStealthAddress(
  scanPubkey: Uint8Array,
  spendPubkey: Uint8Array
): Promise<StealthPayment> {
  // Generate ephemeral keypair
  const ephemeralKeypair = Keypair.generate();
  const ephemeralPubkey = ephemeralKeypair.publicKey.toBytes();
  const ephemeralSecret = ephemeralKeypair.secretKey.slice(0, 32);

  // Convert Ed25519 keys to X25519 for ECDH
  const ephemeralX25519Priv = await ed25519PrivToX25519(ephemeralSecret);
  const scanX25519Pub = ed25519PubToX25519(scanPubkey);

  // Compute shared secret using X25519 ECDH
  // Sender: shared = X25519(ephemeral_priv, scan_pub)
  const ecdhSecret = x25519.getSharedSecret(ephemeralX25519Priv, scanX25519Pub);

  // Hash the ECDH result with domain separator
  const sharedSecret = await sha256(concat(
    new TextEncoder().encode(DOMAIN_SEPARATOR),
    ecdhSecret
  ));

  // Derive stealth address: hash(shared_secret || spend_pubkey)
  const stealthSeed = await sha256(concat(sharedSecret, spendPubkey));
  const stealthKeypair = Keypair.fromSeed(stealthSeed);

  return {
    ephemeralPubkey,
    stealthPubkey: stealthKeypair.publicKey.toBytes(),
    stealthAddress: stealthKeypair.publicKey,
  };
}

// Compute commitment hash
export async function computeCommitment(
  ephemeralPubkey: Uint8Array,
  scanPubkey: Uint8Array,
  spendPubkey: Uint8Array,
  stealthPubkey: Uint8Array
): Promise<Uint8Array> {
  const data = concat(
    new TextEncoder().encode('stealthsol_commitment_v1'),
    ephemeralPubkey,
    scanPubkey,
    spendPubkey,
    stealthPubkey
  );
  return sha256(data);
}

// Save keys to localStorage (encrypted in production)
export function saveKeys(keys: StealthKeys): void {
  const data = {
    scanSecret: bs58.encode(keys.scanSecret),
    spendSecret: bs58.encode(keys.spendSecret),
    scanPubkey: bs58.encode(keys.scanPubkey),
    spendPubkey: bs58.encode(keys.spendPubkey),
  };
  localStorage.setItem('stealthsol_keys', JSON.stringify(data));
}

// Load keys from localStorage
export function loadKeys(): StealthKeys | null {
  const stored = localStorage.getItem('stealthsol_keys');
  if (!stored) return null;

  try {
    const data = JSON.parse(stored);
    return {
      scanSecret: bs58.decode(data.scanSecret),
      spendSecret: bs58.decode(data.spendSecret),
      scanPubkey: bs58.decode(data.scanPubkey),
      spendPubkey: bs58.decode(data.spendPubkey),
    };
  } catch {
    return null;
  }
}

// Clear keys
export function clearKeys(): void {
  localStorage.removeItem('stealthsol_keys');
}

// Check if keys exist
export function hasKeys(): boolean {
  return localStorage.getItem('stealthsol_keys') !== null;
}

// ============== Announcement System ==============

export interface Announcement {
  ephemeralPubkey: string; // base58 encoded
  stealthAddress: string;  // base58 encoded
  timestamp: number;
  txSignature?: string;
}

// Save an announcement (called by sender after successful tx)
export function saveAnnouncement(announcement: Announcement): void {
  const stored = localStorage.getItem('stealthsol_announcements');
  const announcements: Announcement[] = stored ? JSON.parse(stored) : [];
  announcements.push(announcement);
  localStorage.setItem('stealthsol_announcements', JSON.stringify(announcements));
}

// Get all announcements
export function getAnnouncements(): Announcement[] {
  const stored = localStorage.getItem('stealthsol_announcements');
  return stored ? JSON.parse(stored) : [];
}

// Clear announcements
export function clearAnnouncements(): void {
  localStorage.removeItem('stealthsol_announcements');
}

// ============== Scanning for Payments ==============

export interface ScannedPayment {
  stealthAddress: PublicKey;
  stealthKeypair: Keypair;
  ephemeralPubkey: Uint8Array;
  timestamp: number;
  txSignature?: string;
}

// Check if an announcement is for this recipient and derive the stealth keypair
export async function scanAnnouncement(
  announcement: Announcement,
  scanSecret: Uint8Array,
  spendSecret: Uint8Array
): Promise<ScannedPayment | null> {
  try {
    const ephemeralPubkey = bs58.decode(announcement.ephemeralPubkey);

    // Convert Ed25519 keys to X25519 for ECDH
    const scanX25519Priv = await ed25519PrivToX25519(scanSecret);
    const ephemeralX25519Pub = ed25519PubToX25519(ephemeralPubkey);

    // Compute shared secret using X25519 ECDH
    // Recipient: shared = X25519(scan_priv, ephemeral_pub)
    // This equals what sender computed: X25519(ephemeral_priv, scan_pub)
    const ecdhSecret = x25519.getSharedSecret(scanX25519Priv, ephemeralX25519Pub);

    // Hash the ECDH result with domain separator
    const sharedSecret = await sha256(concat(
      new TextEncoder().encode(DOMAIN_SEPARATOR),
      ecdhSecret
    ));

    // Derive stealth keypair: hash(shared_secret || spend_pubkey)
    const spendKeypair = Keypair.fromSeed(spendSecret);
    const stealthSeed = await sha256(concat(sharedSecret, spendKeypair.publicKey.toBytes()));
    const stealthKeypair = Keypair.fromSeed(stealthSeed);

    // Check if this matches the announced stealth address
    if (stealthKeypair.publicKey.toBase58() === announcement.stealthAddress) {
      return {
        stealthAddress: stealthKeypair.publicKey,
        stealthKeypair,
        ephemeralPubkey,
        timestamp: announcement.timestamp,
        txSignature: announcement.txSignature,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// Scan all announcements for payments to this recipient
export async function scanAllAnnouncements(
  scanSecret: Uint8Array,
  spendSecret: Uint8Array
): Promise<ScannedPayment[]> {
  const announcements = getAnnouncements();
  const payments: ScannedPayment[] = [];

  for (const announcement of announcements) {
    const payment = await scanAnnouncement(announcement, scanSecret, spendSecret);
    if (payment) {
      payments.push(payment);
    }
  }

  return payments;
}
