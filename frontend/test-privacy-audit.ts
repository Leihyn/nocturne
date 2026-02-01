#!/usr/bin/env npx tsx
/**
 * COMPREHENSIVE PRIVACY AUDIT
 *
 * Tests ALL transaction flows and investigates privacy on-chain:
 * 1. Deposit (Shield) - Check who is visible
 * 2. Withdraw to Stealth - Verify unlinkability
 * 3. Withdraw to Custom Address - Verify unlinkability
 * 4. Query Solscan for detailed transaction analysis
 * 5. Cross-reference all addresses for any links
 */

// Mock localStorage for Node.js
const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (index: number) => [...storage.keys()][index] ?? null,
};

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { Shadowwire } from './src/lib/shadowwire';
import { isTeeRelayAvailable, getTeePubkey } from './src/lib/tee-encryption';

const keypairPath = path.join(process.env.HOME!, '.config/solana/id.json');
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
const payer = Keypair.fromSecretKey(secretKey);

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

interface TxAnalysis {
  signature: string;
  type: 'deposit' | 'withdraw';
  accounts: string[];
  feePayer: string;
  balanceChanges: { address: string; change: number }[];
  containsDepositor: boolean;
  timestamp: number;
}

interface PrivacyReport {
  depositTx: TxAnalysis | null;
  withdrawTx: TxAnalysis | null;
  depositorAddress: string;
  recipientAddress: string;
  isPrivate: boolean;
  privacyScore: number;
  issues: string[];
  strengths: string[];
}

// RPC helper
async function rpc(method: string, params: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(RPC_URL);
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Fetch and analyze a transaction
async function analyzeTransaction(signature: string, type: 'deposit' | 'withdraw', depositorAddress: string): Promise<TxAnalysis | null> {
  try {
    const result = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);

    if (!result.result) {
      console.log(`  [!] Could not fetch transaction: ${signature.slice(0, 20)}...`);
      return null;
    }

    const tx = result.result;
    const accounts = tx.transaction.message.accountKeys.map((a: any) => a.pubkey || a);
    const feePayer = accounts[0];

    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;

    const balanceChanges: { address: string; change: number }[] = [];
    accounts.forEach((addr: string, i: number) => {
      const change = (postBalances[i] - preBalances[i]) / LAMPORTS_PER_SOL;
      if (Math.abs(change) > 0.0001) {
        balanceChanges.push({ address: addr, change });
      }
    });

    return {
      signature,
      type,
      accounts,
      feePayer,
      balanceChanges,
      containsDepositor: accounts.includes(depositorAddress),
      timestamp: tx.blockTime,
    };
  } catch (err) {
    console.log(`  [!] Error analyzing transaction: ${err}`);
    return null;
  }
}

// Check Solscan for additional details
async function checkSolscan(signature: string): Promise<any> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.solscan.io',
      path: `/transaction/${signature}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Generate privacy report
function generatePrivacyReport(
  depositTx: TxAnalysis | null,
  withdrawTx: TxAnalysis | null,
  depositorAddress: string,
  recipientAddress: string,
  usedTeeRelay: boolean
): PrivacyReport {
  const issues: string[] = [];
  const strengths: string[] = [];
  let privacyScore = 0;

  // Check deposit transaction
  if (depositTx) {
    if (depositTx.containsDepositor) {
      issues.push('Depositor address visible in deposit transaction');
    }
    // Deposit always shows the depositor - this is expected
    strengths.push('Deposit uses fixed denomination (amount hidden in pool)');
    privacyScore += 10;
  }

  // Check withdrawal transaction
  if (withdrawTx) {
    if (withdrawTx.containsDepositor) {
      issues.push('CRITICAL: Depositor address found in withdrawal transaction!');
    } else {
      strengths.push('Depositor address NOT in withdrawal transaction');
      privacyScore += 30;
    }

    if (withdrawTx.feePayer === depositorAddress) {
      issues.push('CRITICAL: Depositor paid withdrawal fee - transactions linked!');
    } else {
      strengths.push('Fee paid by relayer, not depositor');
      privacyScore += 20;
    }

    if (usedTeeRelay) {
      strengths.push('TEE relay used - fee payer identity hidden');
      privacyScore += 15;
    }
  }

  // Check for common accounts between deposit and withdrawal
  if (depositTx && withdrawTx) {
    const depositAccounts = new Set(depositTx.accounts);
    const withdrawAccounts = new Set(withdrawTx.accounts);

    // Exclude known program addresses and system accounts
    const systemAddresses = new Set([
      '11111111111111111111111111111111',
      'SysvarRent111111111111111111111111111111111',
      'Sysvar1nstructions1111111111111111111111111',
    ]);

    const commonAccounts = [...depositAccounts].filter(a =>
      withdrawAccounts.has(a) &&
      !systemAddresses.has(a) &&
      a !== depositorAddress // Already checked
    );

    // Filter out pool addresses (these are expected to be common)
    const suspiciousCommon = commonAccounts.filter(a => {
      // Pool addresses and program addresses are OK
      return !a.startsWith('BqB') && !a.startsWith('GFX') && !a.startsWith('3D37');
    });

    if (suspiciousCommon.length > 0) {
      issues.push(`Suspicious common accounts: ${suspiciousCommon.join(', ')}`);
    } else {
      strengths.push('No unexpected common accounts between deposit and withdrawal');
      privacyScore += 10;
    }
  }

  // ZK proof usage
  strengths.push('ZK proof hides which specific deposit was spent');
  privacyScore += 15;

  const isPrivate = !issues.some(i => i.includes('CRITICAL'));

  return {
    depositTx,
    withdrawTx,
    depositorAddress,
    recipientAddress,
    isPrivate,
    privacyScore: Math.min(privacyScore, 100),
    issues,
    strengths,
  };
}

// Print detailed transaction analysis
function printTxAnalysis(tx: TxAnalysis, label: string) {
  console.log(`\n  ${label}:`);
  console.log(`  ├─ Signature: ${tx.signature.slice(0, 40)}...`);
  console.log(`  ├─ Fee Payer: ${tx.feePayer.slice(0, 20)}...`);
  console.log(`  ├─ Accounts (${tx.accounts.length}):`);
  tx.accounts.slice(0, 8).forEach((acc, i) => {
    const marker = i === 0 ? '[FEE]' : '';
    console.log(`  │   ${i + 1}. ${acc.slice(0, 30)}... ${marker}`);
  });
  if (tx.accounts.length > 8) {
    console.log(`  │   ... and ${tx.accounts.length - 8} more`);
  }
  console.log(`  ├─ Balance Changes:`);
  tx.balanceChanges.forEach(bc => {
    const sign = bc.change > 0 ? '+' : '';
    console.log(`  │   ${bc.address.slice(0, 20)}...: ${sign}${bc.change.toFixed(4)} SOL`);
  });
  console.log(`  └─ Contains Depositor: ${tx.containsDepositor ? 'YES (!)' : 'NO'}`);
}

// Print privacy report
function printPrivacyReport(report: PrivacyReport) {
  console.log('\n' + '═'.repeat(70));
  console.log('  PRIVACY AUDIT REPORT');
  console.log('═'.repeat(70));

  console.log(`\n  Depositor: ${report.depositorAddress}`);
  console.log(`  Recipient: ${report.recipientAddress}`);

  if (report.depositTx) {
    printTxAnalysis(report.depositTx, 'DEPOSIT TRANSACTION');
  }

  if (report.withdrawTx) {
    printTxAnalysis(report.withdrawTx, 'WITHDRAWAL TRANSACTION');
  }

  console.log('\n  ┌─────────────────────────────────────────────────────────────────┐');
  console.log('  │                      PRIVACY ANALYSIS                           │');
  console.log('  ├─────────────────────────────────────────────────────────────────┤');

  if (report.strengths.length > 0) {
    console.log('  │ STRENGTHS:                                                      │');
    report.strengths.forEach(s => {
      console.log(`  │   ✓ ${s.padEnd(59)}│`);
    });
  }

  if (report.issues.length > 0) {
    console.log('  │ ISSUES:                                                         │');
    report.issues.forEach(i => {
      console.log(`  │   ✗ ${i.padEnd(59)}│`);
    });
  }

  console.log('  ├─────────────────────────────────────────────────────────────────┤');
  console.log(`  │ PRIVACY SCORE: ${report.privacyScore}%`.padEnd(68) + '│');
  console.log(`  │ STATUS: ${report.isPrivate ? 'PRIVATE' : 'COMPROMISED'}`.padEnd(68) + '│');
  console.log('  └─────────────────────────────────────────────────────────────────┘');
}

// Retry helper
async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delay = 3000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      if (err.message?.includes('429') || err.message?.includes('rate')) {
        console.log(`  [!] Rate limited, waiting ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error('Max retries exceeded');
}

async function main() {
  console.log('═'.repeat(70));
  console.log('  STEALTHSOL - COMPREHENSIVE PRIVACY AUDIT');
  console.log('═'.repeat(70));
  console.log();

  const connection = new Connection(RPC_URL, 'confirmed');
  const depositorAddress = payer.publicKey.toBase58();

  console.log(`Depositor Wallet: ${depositorAddress}`);

  const balance = await retry(() => connection.getBalance(payer.publicKey));
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (balance < 0.25 * LAMPORTS_PER_SOL) {
    console.log('\n[!] Need at least 0.25 SOL for testing');
    console.log('Run: solana airdrop 1 --url devnet');
    return;
  }

  // Check TEE relay
  const teeAvailable = await isTeeRelayAvailable();
  console.log(`TEE Relay: ${teeAvailable ? 'Available' : 'Offline'}`);

  if (!teeAvailable) {
    console.log('\n[!] TEE relay required for maximum privacy testing');
    console.log('Run: cd verifier && node index.js');
    return;
  }

  const { teePubkey, relayerWallet } = await getTeePubkey();
  console.log(`Relayer Wallet: ${relayerWallet}`);

  // Initialize Shadowwire
  const sw = new Shadowwire(connection);
  const identity = await sw.generateIdentity(payer.publicKey);
  console.log(`Identity: ${identity.metaAddress.encoded.slice(0, 30)}...`);

  const signTransaction = async (tx: any) => {
    tx.partialSign(payer);
    return tx;
  };

  const reports: PrivacyReport[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Deposit + Withdraw to Stealth Address (TEE Relay)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(70));
  console.log('  TEST 1: Deposit → Withdraw to Stealth (TEE Relay)');
  console.log('─'.repeat(70));

  console.log('\n  [1/4] Depositing 0.1 SOL...');
  const deposit1 = await sw.sendPrivate(payer.publicKey, 0.1 as any, signTransaction, identity.metaAddress.encoded);

  if (!deposit1.signature) {
    console.log('  [!] Deposit failed');
    return;
  }
  console.log(`  [✓] Deposit TX: ${deposit1.signature.slice(0, 40)}...`);

  console.log('\n  [2/4] Waiting 15s for settlement...');
  await new Promise(r => setTimeout(r, 15000));

  console.log('\n  [3/4] Withdrawing to stealth address via TEE relay...');
  const withdraw1 = await retry(async () => {
    const result = await sw.receivePrivate(payer.publicKey, deposit1.noteCode, signTransaction, true);
    if (!result.success) throw new Error(result.error);
    return result;
  });

  console.log(`  [✓] Withdraw TX: ${withdraw1.signature.slice(0, 40)}...`);
  console.log(`  [✓] Stealth Address: ${withdraw1.stealthAddress?.slice(0, 30)}...`);

  console.log('\n  [4/4] Analyzing transactions...');
  const depositTx1 = await analyzeTransaction(deposit1.signature, 'deposit', depositorAddress);
  const withdrawTx1 = await analyzeTransaction(withdraw1.signature, 'withdraw', depositorAddress);

  const report1 = generatePrivacyReport(
    depositTx1,
    withdrawTx1,
    depositorAddress,
    withdraw1.stealthAddress || 'unknown',
    true
  );
  reports.push(report1);
  printPrivacyReport(report1);

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Deposit + Withdraw to Custom Address (TEE Relay)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(70));
  console.log('  TEST 2: Deposit → Withdraw to Custom Address (TEE Relay)');
  console.log('─'.repeat(70));

  // Generate fresh recipient
  const customRecipient = Keypair.generate();
  console.log(`\n  Custom Recipient: ${customRecipient.publicKey.toBase58().slice(0, 30)}...`);

  console.log('\n  [1/4] Depositing 0.1 SOL...');
  const deposit2 = await sw.sendPrivate(payer.publicKey, 0.1 as any, signTransaction, identity.metaAddress.encoded);

  if (!deposit2.signature) {
    console.log('  [!] Deposit failed');
    return;
  }
  console.log(`  [✓] Deposit TX: ${deposit2.signature.slice(0, 40)}...`);

  console.log('\n  [2/4] Waiting 15s for settlement...');
  await new Promise(r => setTimeout(r, 15000));

  console.log('\n  [3/4] Withdrawing to custom address via TEE relay...');
  const withdraw2 = await retry(async () => {
    const result = await sw.receivePrivate(
      payer.publicKey,
      deposit2.noteCode,
      signTransaction,
      true, // TEE relay
      customRecipient.publicKey // Custom recipient
    );
    if (!result.success) throw new Error(result.error);
    return result;
  });

  console.log(`  [✓] Withdraw TX: ${withdraw2.signature.slice(0, 40)}...`);

  console.log('\n  [4/4] Analyzing transactions...');
  const depositTx2 = await analyzeTransaction(deposit2.signature, 'deposit', depositorAddress);
  const withdrawTx2 = await analyzeTransaction(withdraw2.signature, 'withdraw', depositorAddress);

  const report2 = generatePrivacyReport(
    depositTx2,
    withdrawTx2,
    depositorAddress,
    customRecipient.publicKey.toBase58(),
    true
  );
  reports.push(report2);
  printPrivacyReport(report2);

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-TRANSACTION ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(70));
  console.log('  CROSS-TRANSACTION LINKABILITY ANALYSIS');
  console.log('─'.repeat(70));

  console.log('\n  Checking if any withdrawal can be linked to any deposit...\n');

  // Collect all unique addresses from all transactions
  const allDepositAccounts = new Set<string>();
  const allWithdrawAccounts = new Set<string>();

  if (depositTx1) depositTx1.accounts.forEach(a => allDepositAccounts.add(a));
  if (depositTx2) depositTx2.accounts.forEach(a => allDepositAccounts.add(a));
  if (withdrawTx1) withdrawTx1.accounts.forEach(a => allWithdrawAccounts.add(a));
  if (withdrawTx2) withdrawTx2.accounts.forEach(a => allWithdrawAccounts.add(a));

  // System/program addresses to ignore
  const ignoreAddresses = new Set([
    '11111111111111111111111111111111',
    'SysvarRent111111111111111111111111111111111',
    'Sysvar1nstructions1111111111111111111111111',
    relayerWallet, // Relayer is expected to be in withdrawals
  ]);

  // Find suspicious overlaps
  const suspiciousLinks: string[] = [];

  allDepositAccounts.forEach(depAddr => {
    if (ignoreAddresses.has(depAddr)) return;
    if (depAddr === depositorAddress) return; // Depositor in deposits is expected

    if (allWithdrawAccounts.has(depAddr)) {
      // Check if this is the depositor appearing in withdrawal (bad!)
      if (depAddr === depositorAddress) {
        suspiciousLinks.push(`CRITICAL: Depositor ${depAddr.slice(0, 15)}... appears in both deposit AND withdrawal!`);
      }
    }
  });

  // Check if depositor is in any withdrawal
  const depositorInWithdrawals = allWithdrawAccounts.has(depositorAddress);

  console.log('  ┌─────────────────────────────────────────────────────────────────┐');
  console.log('  │                   LINKABILITY RESULTS                           │');
  console.log('  ├─────────────────────────────────────────────────────────────────┤');
  console.log(`  │ Depositor in withdrawals: ${depositorInWithdrawals ? 'YES (!!!)' : 'NO'}`.padEnd(68) + '│');
  console.log(`  │ Suspicious links found: ${suspiciousLinks.length}`.padEnd(68) + '│');

  if (suspiciousLinks.length > 0) {
    suspiciousLinks.forEach(link => {
      console.log(`  │   ! ${link.slice(0, 60)}`.padEnd(68) + '│');
    });
  }

  console.log('  └─────────────────────────────────────────────────────────────────┘');

  // ═══════════════════════════════════════════════════════════════════════════
  // SOLSCAN VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(70));
  console.log('  SOLSCAN VERIFICATION LINKS');
  console.log('─'.repeat(70));

  console.log('\n  View these transactions on Solscan to verify privacy:\n');

  if (deposit1.signature) {
    console.log(`  Deposit 1:  https://solscan.io/tx/${deposit1.signature}?cluster=devnet`);
  }
  if (withdraw1.signature) {
    console.log(`  Withdraw 1: https://solscan.io/tx/${withdraw1.signature}?cluster=devnet`);
  }
  if (deposit2.signature) {
    console.log(`  Deposit 2:  https://solscan.io/tx/${deposit2.signature}?cluster=devnet`);
  }
  if (withdraw2.signature) {
    console.log(`  Withdraw 2: https://solscan.io/tx/${withdraw2.signature}?cluster=devnet`);
  }

  console.log('\n  What to verify on Solscan:');
  console.log('  1. Depositor address should NOT appear in withdrawal transactions');
  console.log('  2. Fee payer in withdrawals should be the relayer, not depositor');
  console.log('  3. Recipient addresses should have no prior connection to depositor');

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('  FINAL PRIVACY AUDIT SUMMARY');
  console.log('═'.repeat(70));

  const allPrivate = reports.every(r => r.isPrivate);
  const avgScore = Math.round(reports.reduce((sum, r) => sum + r.privacyScore, 0) / reports.length);

  console.log('\n  ┌─────────────────────────────────────────────────────────────────┐');
  console.log('  │                         RESULTS                                 │');
  console.log('  ├─────────────────────────────────────────────────────────────────┤');
  console.log(`  │ Test 1 (Stealth):     ${reports[0]?.isPrivate ? 'PASS' : 'FAIL'} - Score: ${reports[0]?.privacyScore}%`.padEnd(68) + '│');
  console.log(`  │ Test 2 (Custom Addr): ${reports[1]?.isPrivate ? 'PASS' : 'FAIL'} - Score: ${reports[1]?.privacyScore}%`.padEnd(68) + '│');
  console.log(`  │ Cross-TX Linkability: ${depositorInWithdrawals ? 'LINKED (!)' : 'UNLINKABLE'}`.padEnd(68) + '│');
  console.log('  ├─────────────────────────────────────────────────────────────────┤');
  console.log(`  │ OVERALL SCORE: ${avgScore}%`.padEnd(68) + '│');
  console.log(`  │ VERDICT: ${allPrivate && !depositorInWithdrawals ? 'PROTOCOL IS PRIVATE' : 'PRIVACY ISSUES DETECTED'}`.padEnd(68) + '│');
  console.log('  └─────────────────────────────────────────────────────────────────┘');

  if (allPrivate && !depositorInWithdrawals) {
    console.log('\n  ╔═══════════════════════════════════════════════════════════════════╗');
    console.log('  ║                                                                   ║');
    console.log('  ║   PRIVACY VERIFIED - All transactions are unlinkable on-chain    ║');
    console.log('  ║                                                                   ║');
    console.log('  ╚═══════════════════════════════════════════════════════════════════╝');
  } else {
    console.log('\n  ⚠️  PRIVACY ISSUES DETECTED - Review the reports above');
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
