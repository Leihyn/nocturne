/**
 * Convert Verification Key to On-Chain Format
 *
 * Converts the Circom/snarkjs verification_key.json to the borsh-serialized
 * format that the Solana program expects.
 *
 * The on-chain VerificationKey structure:
 * - alpha: [u8; 64] - G1 point
 * - beta: [u8; 128] - G2 point
 * - gamma: [u8; 128] - G2 point
 * - delta: [u8; 128] - G2 point
 * - ic: Vec<[u8; 64]> - Array of G1 points
 */

import fs from 'fs';
import path from 'path';

// ============================================
// BN254 Point Encoding
// ============================================

/**
 * Convert a decimal string to a 32-byte big-endian buffer
 */
function decimalToBytes32(decimalStr) {
  let hex = BigInt(decimalStr).toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * Encode a G1 point (x, y) as 64 bytes
 * Format: x (32 bytes BE) || y (32 bytes BE)
 */
function encodeG1Point(point) {
  if (point.length < 2) {
    throw new Error('Invalid G1 point');
  }

  const x = decimalToBytes32(point[0]);
  const y = decimalToBytes32(point[1]);

  return Buffer.concat([x, y]);
}

/**
 * Encode a G2 point as 128 bytes
 * G2 points have coordinates in Fp2 (pairs of field elements)
 * Format: x_c1 || x_c0 || y_c1 || y_c0 (each 32 bytes BE)
 *
 * Note: snarkjs uses [c0, c1] order, but BN254 expects [c1, c0]
 */
function encodeG2Point(point) {
  if (point.length < 2 || point[0].length < 2 || point[1].length < 2) {
    throw new Error('Invalid G2 point');
  }

  // point[0] = x coordinate (Fp2) = [x_c0, x_c1]
  // point[1] = y coordinate (Fp2) = [y_c0, y_c1]

  // For BN254 pairing, we need: x_c1 || x_c0 || y_c1 || y_c0
  const x_c0 = decimalToBytes32(point[0][0]);
  const x_c1 = decimalToBytes32(point[0][1]);
  const y_c0 = decimalToBytes32(point[1][0]);
  const y_c1 = decimalToBytes32(point[1][1]);

  // BN254 expects imaginary part first
  return Buffer.concat([x_c1, x_c0, y_c1, y_c0]);
}

/**
 * Borsh-serialize a verification key
 *
 * Borsh format:
 * - alpha: [u8; 64] (fixed array, no length prefix)
 * - beta: [u8; 128] (fixed array)
 * - gamma: [u8; 128] (fixed array)
 * - delta: [u8; 128] (fixed array)
 * - ic: Vec<[u8; 64]> (length as u32 LE, then elements)
 */
function serializeVerificationKey(vk) {
  const alpha = encodeG1Point(vk.vk_alpha_1);
  const beta = encodeG2Point(vk.vk_beta_2);
  const gamma = encodeG2Point(vk.vk_gamma_2);
  const delta = encodeG2Point(vk.vk_delta_2);

  // Encode IC points
  const icPoints = vk.IC.map(point => encodeG1Point(point));

  // IC length as u32 LE
  const icLengthBuffer = Buffer.alloc(4);
  icLengthBuffer.writeUInt32LE(icPoints.length, 0);

  // Concatenate all parts
  return Buffer.concat([
    alpha,
    beta,
    gamma,
    delta,
    icLengthBuffer,
    ...icPoints,
  ]);
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('Verification Key Converter');
  console.log('='.repeat(60));

  // Read verification key
  const vkPath = path.join(process.cwd(), '../circuits/build/withdraw/verification_key.json');
  console.log(`\nReading: ${vkPath}`);

  const vk = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));

  console.log(`\nVerification Key Info:`);
  console.log(`  Protocol: ${vk.protocol}`);
  console.log(`  Curve: ${vk.curve}`);
  console.log(`  Public Inputs: ${vk.nPublic}`);
  console.log(`  IC Points: ${vk.IC.length}`);

  // Serialize
  console.log(`\nSerializing to borsh format...`);
  const serialized = serializeVerificationKey(vk);

  console.log(`\nSerialized Size: ${serialized.length} bytes`);
  console.log(`  Alpha (G1): 64 bytes`);
  console.log(`  Beta (G2): 128 bytes`);
  console.log(`  Gamma (G2): 128 bytes`);
  console.log(`  Delta (G2): 128 bytes`);
  console.log(`  IC length: 4 bytes`);
  console.log(`  IC points: ${vk.IC.length} x 64 = ${vk.IC.length * 64} bytes`);
  console.log(`  Total: ${64 + 128 * 3 + 4 + vk.IC.length * 64} bytes`);

  // Save as binary
  const outputPath = path.join(process.cwd(), '../circuits/build/withdraw/verification_key.bin');
  fs.writeFileSync(outputPath, serialized);
  console.log(`\nSaved: ${outputPath}`);

  // Save as JSON array (for JavaScript/TypeScript usage)
  const outputJsonPath = path.join(process.cwd(), '../circuits/build/withdraw/verification_key_bytes.json');
  fs.writeFileSync(outputJsonPath, JSON.stringify(Array.from(serialized), null, 2));
  console.log(`Saved: ${outputJsonPath}`);

  // Also save as base64 for easy transport
  const outputBase64Path = path.join(process.cwd(), '../circuits/build/withdraw/verification_key.b64');
  fs.writeFileSync(outputBase64Path, serialized.toString('base64'));
  console.log(`Saved: ${outputBase64Path}`);

  // Print first few bytes for verification
  console.log(`\nFirst 64 bytes (alpha G1 point):`);
  console.log(`  ${serialized.slice(0, 32).toString('hex')}`);
  console.log(`  ${serialized.slice(32, 64).toString('hex')}`);

  console.log('\n' + '='.repeat(60));
  console.log('VERIFICATION KEY READY FOR ON-CHAIN STORAGE');
  console.log('='.repeat(60));
}

main().catch(console.error);
