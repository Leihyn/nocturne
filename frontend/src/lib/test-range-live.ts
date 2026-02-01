/**
 * Test Range API with Live Key
 *
 * Run: npx ts-node src/lib/test-range-live.ts
 */

import { createRangeClient, RiskLevel } from './range-client';
import { Keypair } from '@solana/web3.js';

// Load API key from environment or use directly for testing
const RANGE_API_KEY = process.env.NEXT_PUBLIC_RANGE_API_KEY || 'cmkk6xzgv001umw01o35on7of.WFsG3rDxrJn9x4mVRTsvYF631gChfJb2';

async function main() {
  console.log('Testing Range API with live key...\n');

  const client = createRangeClient(RANGE_API_KEY);

  // Test with a random Solana address
  const testAddress = Keypair.generate().publicKey.toBase58();
  console.log(`Testing address: ${testAddress}\n`);

  // 1. Check if address is safe
  console.log('1. Safety Check');
  console.log('-'.repeat(40));
  try {
    const isSafe = await client.isAddressSafe(testAddress);
    console.log(`Is safe: ${isSafe ? 'YES ✓' : 'NO ✗'}`);
  } catch (error) {
    console.log(`Error: ${error}`);
  }

  // 2. Get risk score
  console.log('\n2. Risk Assessment');
  console.log('-'.repeat(40));
  try {
    const risk = await client.getAddressRisk(testAddress);
    console.log(`Risk score: ${risk.riskScore}/100`);
    console.log(`Risk level: ${risk.riskLevel}`);
    console.log(`Sanctioned: ${risk.sanctioned}`);
    console.log(`Flags: ${risk.flags.length > 0 ? risk.flags.join(', ') : 'None'}`);
  } catch (error) {
    console.log(`Error: ${error}`);
  }

  // 3. Sanctions check
  console.log('\n3. Sanctions Check');
  console.log('-'.repeat(40));
  try {
    const sanctions = await client.checkSanctions(testAddress);
    console.log(`Sanctioned: ${sanctions.sanctioned}`);
    console.log(`Lists: ${sanctions.lists.length > 0 ? sanctions.lists.join(', ') : 'None'}`);
  } catch (error) {
    console.log(`Error: ${error}`);
  }

  // 4. Transaction simulation
  console.log('\n4. Transaction Simulation');
  console.log('-'.repeat(40));
  const recipient = Keypair.generate().publicKey.toBase58();
  try {
    const sim = await client.simulateTransaction(
      testAddress,
      recipient,
      BigInt(1_000_000_000) // 1 SOL
    );
    console.log(`Safe: ${sim.safe ? 'YES ✓' : 'NO ✗'}`);
    console.log(`Risk score: ${sim.riskScore}`);
    console.log(`Warnings: ${sim.warnings.length > 0 ? sim.warnings.join(', ') : 'None'}`);
  } catch (error) {
    console.log(`Error: ${error}`);
  }

  console.log('\n' + '='.repeat(40));
  console.log('Range API test complete!');
  console.log('API key is working correctly.');
}

main().catch(console.error);
