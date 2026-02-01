/**
 * Test Range Compliance Integration
 *
 * This script demonstrates:
 * 1. Enabling compliance mode (test mode for devnet)
 * 2. Pre-screening addresses before transactions
 * 3. Generating compliance reports for auditors
 * 4. Using view keys for selective disclosure
 *
 * Run: npx ts-node test-compliance.ts
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Veil, { RiskLevel, type ComplianceTransaction } from './veil';

// Devnet connection
const DEVNET_RPC = 'https://api.devnet.solana.com';

async function main() {
  console.log('='.repeat(60));
  console.log('StealthSol + Range Compliance Demo');
  console.log('='.repeat(60));

  // Setup connection
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  const veil = new Veil(connection, DEVNET_RPC);

  // Generate test keypair (would be funded wallet in production)
  const testKeypair = Keypair.generate();
  veil.initWithKeypair(testKeypair);

  console.log('\n1. Enable Compliance Mode');
  console.log('-'.repeat(40));

  // Enable compliance in TEST MODE (no API key needed for devnet)
  const enabled = veil.enableCompliance(); // No API key = test mode
  console.log(`Compliance enabled: ${enabled}`);
  console.log('Mode: TEST (mock data for devnet)');

  console.log('\n2. Screen Addresses');
  console.log('-'.repeat(40));

  // Test normal address (should pass)
  const normalAddress = Keypair.generate().publicKey;
  console.log(`\nScreening normal address: ${normalAddress.toBase58().slice(0, 20)}...`);

  const isNormalSafe = await veil.screenAddress(normalAddress);
  console.log(`Safe to transact: ${isNormalSafe ? 'YES ✓' : 'NO ✗'}`);

  // Get detailed risk info
  const normalRisk = await veil.getAddressRisk(normalAddress);
  if (normalRisk) {
    console.log(`Risk score: ${normalRisk.riskScore}/100`);
    console.log(`Risk level: ${normalRisk.riskLevel}`);
    console.log(`Sanctioned: ${normalRisk.sanctioned}`);
  }

  // Test "sanctioned" address (will be blocked in test mode)
  const sanctionedAddress = 'SANCTIONED111111111111111111111111111111111';
  console.log(`\nScreening sanctioned address: ${sanctionedAddress.slice(0, 20)}...`);

  const isSanctionedSafe = await veil.screenAddress(sanctionedAddress);
  console.log(`Safe to transact: ${isSanctionedSafe ? 'YES ✓' : 'NO ✗'}`);

  const sanctions = await veil.checkSanctions(sanctionedAddress);
  if (sanctions) {
    console.log(`Sanctioned: ${sanctions.sanctioned}`);
    console.log(`Lists: ${sanctions.lists.join(', ') || 'None'}`);
  }

  console.log('\n3. Compliant Private Send');
  console.log('-'.repeat(40));

  // This would work with a funded wallet
  console.log('Attempting compliant private send (will fail - no funds in test)...');

  const sendResult = await veil.sendPrivateCompliant(1.0, normalAddress);
  console.log(`Success: ${sendResult.success}`);
  console.log(`Compliance checked: ${sendResult.complianceChecked}`);
  if (!sendResult.success) {
    console.log(`Reason: ${sendResult.error}`);
  }

  console.log('\n4. Generate Compliance Report');
  console.log('-'.repeat(40));

  // Create mock transaction history (would come from view key scanning)
  const mockTransactions: ComplianceTransaction[] = [
    {
      id: 'tx1',
      timestamp: Date.now() - 86400000, // 1 day ago
      type: 'deposit',
      amount: BigInt(1 * LAMPORTS_PER_SOL),
      riskScore: 5,
    },
    {
      id: 'tx2',
      timestamp: Date.now() - 43200000, // 12 hours ago
      type: 'withdrawal',
      amount: BigInt(1 * LAMPORTS_PER_SOL),
      counterparty: normalAddress.toBase58(),
      riskScore: 8,
    },
  ];

  const periodStart = Date.now() - 7 * 86400000; // 7 days ago
  const periodEnd = Date.now();

  const report = await veil.generateComplianceReport(
    mockTransactions,
    periodStart,
    periodEnd,
  );

  if (report) {
    console.log('\nCompliance Report Generated:');
    console.log(`  Wallet: ${report.walletAddress.slice(0, 20)}...`);
    console.log(`  Period: ${new Date(report.reportPeriod.start).toLocaleDateString()} - ${new Date(report.reportPeriod.end).toLocaleDateString()}`);
    console.log(`  Total transactions: ${report.summary.totalTransactions}`);
    console.log(`  Total volume: ${Number(report.summary.totalVolume) / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Risk assessment: ${report.summary.riskAssessment}`);
    console.log(`  Attestation ID: ${report.attestation || 'None'}`);

    // Verify attestation
    if (report.attestation) {
      const isValid = await veil.verifyComplianceAttestation(report.attestation);
      console.log(`  Attestation valid: ${isValid ? 'YES ✓' : 'NO ✗'}`);
    }
  }

  console.log('\n5. View Keys Integration');
  console.log('-'.repeat(40));
  console.log('View keys allow selective disclosure to auditors:');
  console.log('  • Set view key: on-chain instruction (see view_key.rs)');
  console.log('  • Auditor scans with view key: sees transactions');
  console.log('  • Auditor generates compliance report: shares with regulator');
  console.log('  • Privacy preserved: spending key never shared');

  console.log('\n' + '='.repeat(60));
  console.log('DEMO COMPLETE');
  console.log('='.repeat(60));
  console.log('\nFor production:');
  console.log('1. Get API key from https://app.range.org');
  console.log('2. Call veil.enableCompliance(apiKey) with real key');
  console.log('3. All screening will use live Range API');
}

main().catch(console.error);
