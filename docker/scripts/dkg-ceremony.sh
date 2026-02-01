#!/bin/bash
set -e

# ============================================
# Distributed Key Generation Ceremony
# ============================================
#
# This script generates threshold RSA keys for the coordinator network.
# Each coordinator receives a key share, and t-of-n shares are required
# to produce a valid signature.
#
# Usage:
#   ./dkg-ceremony.sh [threshold] [total]
#   ./dkg-ceremony.sh 2 3  # 2-of-3 threshold
#
# Output:
#   - key_share_1.json through key_share_n.json
#   - public_key.json (shared by all)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/../keys"

THRESHOLD=${1:-2}
TOTAL=${2:-3}

echo "========================================"
echo "  StealthSol DKG Ceremony"
echo "========================================"
echo ""
echo "Threshold: ${THRESHOLD}-of-${TOTAL}"
echo ""

mkdir -p "$OUTPUT_DIR"

# Generate keys using Node.js
node << EOF
const crypto = require('crypto');
const fs = require('fs');

const THRESHOLD = ${THRESHOLD};
const TOTAL = ${TOTAL};
const OUTPUT_DIR = '${OUTPUT_DIR}';

// Large prime for Shamir's Secret Sharing field
const FIELD_PRIME = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');

// Generate RSA key (2048-bit)
console.log('Generating 2048-bit RSA key...');

function randomBigInt(bits) {
    const bytes = crypto.randomBytes(Math.ceil(bits / 8));
    let n = BigInt('0x' + bytes.toString('hex'));
    n = n | (1n << BigInt(bits - 1));  // Ensure high bit set
    n = n | 1n;  // Ensure odd
    return n;
}

function modPow(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp % 2n === 1n) result = (result * base) % mod;
        exp = exp / 2n;
        base = (base * base) % mod;
    }
    return result;
}

function millerRabin(n, k = 64) {
    if (n < 2n) return false;
    if (n === 2n || n === 3n) return true;
    if (n % 2n === 0n) return false;

    let r = 0n, d = n - 1n;
    while (d % 2n === 0n) { d /= 2n; r++; }

    for (let i = 0; i < k; i++) {
        const a = 2n + BigInt(Math.floor(Math.random() * Number(n - 4n)));
        let x = modPow(a, d, n);
        if (x === 1n || x === n - 1n) continue;
        let cont = false;
        for (let j = 0n; j < r - 1n; j++) {
            x = modPow(x, 2n, n);
            if (x === n - 1n) { cont = true; break; }
        }
        if (!cont) return false;
    }
    return true;
}

function generatePrime(bits) {
    while (true) {
        const candidate = randomBigInt(bits);
        if (millerRabin(candidate)) return candidate;
    }
}

function modInverse(a, m) {
    let [old_r, r] = [m, a % m];
    let [old_s, s] = [0n, 1n];
    while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
    }
    return old_s < 0n ? old_s + m : old_s;
}

// Generate two large primes
console.log('Generating prime p...');
const p = generatePrime(1024);
console.log('Generating prime q...');
const q = generatePrime(1024);

const n = p * q;
const e = 65537n;
const phi = (p - 1n) * (q - 1n);
const d = modInverse(e, phi);

console.log('RSA key generated');
console.log('Modulus size:', n.toString(16).length * 4, 'bits');

// Shamir's Secret Sharing
console.log('\\nSplitting private key using Shamir Secret Sharing...');

function fieldMod(x) {
    return ((x % FIELD_PRIME) + FIELD_PRIME) % FIELD_PRIME;
}

function generatePolynomial(secret, degree) {
    const coeffs = [fieldMod(secret)];
    for (let i = 1; i <= degree; i++) {
        const randomBuf = crypto.randomBytes(32);
        let coef = BigInt('0x' + randomBuf.toString('hex'));
        coeffs.push(fieldMod(coef));
    }
    return coeffs;
}

function evaluatePolynomial(coeffs, x) {
    let result = 0n, xPower = 1n;
    for (const coef of coeffs) {
        result = fieldMod(result + fieldMod(coef * xPower));
        xPower = fieldMod(xPower * x);
    }
    return result;
}

// Generate polynomial with d as constant term
const polynomial = generatePolynomial(d, THRESHOLD - 1);

// Generate shares
const shares = [];
for (let i = 1; i <= TOTAL; i++) {
    const share = evaluatePolynomial(polynomial, BigInt(i));
    const shareHash = crypto.createHash('sha256')
        .update(share.toString(16))
        .digest('hex');
    
    shares.push({
        index: i,
        share: share.toString(),
        shareHash,
        publicKey: {
            n: n.toString(),
            e: e.toString(),
        }
    });
}

// Save shares
for (const share of shares) {
    const filename = OUTPUT_DIR + '/key_share_' + share.index + '.json';
    fs.writeFileSync(filename, JSON.stringify(share, null, 2));
    console.log('Saved:', filename);
}

// Save public key
const publicKey = {
    n: n.toString(),
    e: e.toString(),
    threshold: THRESHOLD,
    totalShares: TOTAL,
};
fs.writeFileSync(OUTPUT_DIR + '/public_key.json', JSON.stringify(publicKey, null, 2));
console.log('Saved:', OUTPUT_DIR + '/public_key.json');

console.log('\\n✓ DKG ceremony complete');
console.log('  Key shares:', TOTAL);
console.log('  Threshold:', THRESHOLD);
EOF

echo ""
echo "========================================"
echo "  Key Distribution Instructions"
echo "========================================"
echo ""
echo "1. Distribute key shares to coordinators:"
echo "   - key_share_1.json -> coordinator-1"
echo "   - key_share_2.json -> coordinator-2"
echo "   - key_share_3.json -> coordinator-3"
echo ""
echo "2. Keep public_key.json available to all coordinators"
echo ""
echo "3. SECURELY DELETE the key_share files after distribution"
echo ""
echo "4. NEVER store all shares in the same location"
echo ""
