/**
 * Test script for MagicBlock TEE Integration
 *
 * Run with: npx ts-node src/lib/test-tee.ts
 * Or import and call testTeeIntegration() from browser console
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Veil } from './veil';
import { isTeeAvailable, getTeeStatus } from './magicblock-tee';

const DEVNET_RPC = 'https://api.devnet.solana.com';

export async function testTeeIntegration() {
  console.log('=== MagicBlock TEE Integration Test ===\n');

  // 1. Check TEE availability
  console.log('1. Checking TEE availability...');
  const available = await isTeeAvailable();
  console.log(`   TEE available: ${available}`);

  if (available) {
    const status = await getTeeStatus();
    console.log(`   Validator: ${status.validator || 'Unknown'}`);
    console.log(`   Delegation Program: ${status.delegationProgram || 'Unknown'}`);
    console.log(`   Permission Program: ${status.permissionProgram || 'Unknown'}`);
  }

  // 2. Create test wallet
  console.log('\n2. Creating test wallet...');
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  const testWallet = Keypair.generate();
  console.log(`   Wallet: ${testWallet.publicKey.toBase58()}`);

  // 3. Request airdrop
  console.log('\n3. Requesting airdrop...');
  try {
    const sig = await connection.requestAirdrop(testWallet.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    console.log(`   Airdrop successful: ${sig}`);
  } catch (e) {
    console.log(`   Airdrop failed (may need manual funding): ${e}`);
  }

  const balance = await connection.getBalance(testWallet.publicKey);
  console.log(`   Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // 4. Initialize Veil SDK
  console.log('\n4. Initializing Veil SDK...');
  const veil = new Veil(connection, DEVNET_RPC);
  veil.initWithKeypair(testWallet);
  console.log(`   SDK initialized`);

  // 5. Enable TEE mode
  console.log('\n5. Enabling TEE mode...');
  const teeEnabled = await veil.enableTeeMode();
  console.log(`   TEE mode enabled: ${teeEnabled}`);

  if (!teeEnabled) {
    console.log('\n   TEE not available. Testing standard deposit instead...');

    // Test standard deposit
    if (balance >= LAMPORTS_PER_SOL) {
      console.log('\n6. Testing standard deposit (1 SOL)...');
      const result = await veil.sendPrivate(1.0);
      console.log(`   Result: ${JSON.stringify(result, null, 2)}`);
    } else {
      console.log('\n   Insufficient balance for deposit test');
    }

    return { success: true, teeUsed: false };
  }

  // 6. Test TEE deposit (requires wallet signature)
  console.log('\n6. TEE deposit requires wallet signature...');
  console.log('   In browser: Use veil.sendPrivateTee(1.0, signMessage)');
  console.log('   The signMessage function comes from your wallet adapter');

  // For programmatic testing with a keypair:
  const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
    // In a real scenario, this would be wallet.signMessage
    // For testing, we simulate with the keypair
    const { sign } = await import('@noble/ed25519');
    return await sign(message, testWallet.secretKey.slice(0, 32));
  };

  if (balance >= LAMPORTS_PER_SOL) {
    console.log('\n7. Testing TEE deposit (1 SOL)...');
    try {
      const result = await veil.sendPrivateTee(1.0, signMessage);
      console.log(`   Result: ${JSON.stringify(result, null, 2)}`);
      console.log(`   Used TEE: ${result.usedTee}`);

      if (result.commitment) {
        console.log(`   Commitment: ${Buffer.from(result.commitment).toString('hex').slice(0, 16)}...`);
      }

      return { success: result.success, teeUsed: result.usedTee };
    } catch (e) {
      console.log(`   TEE deposit failed: ${e}`);
      return { success: false, teeUsed: false, error: String(e) };
    }
  } else {
    console.log('\n   Insufficient balance for deposit test');
    console.log('   Fund the wallet and try again');
    return { success: false, teeUsed: false, error: 'Insufficient balance' };
  }
}

// Export for use in browser console
if (typeof window !== 'undefined') {
  (window as any).testTeeIntegration = testTeeIntegration;
}

// CLI execution
if (typeof require !== 'undefined' && require.main === module) {
  testTeeIntegration()
    .then(result => {
      console.log('\n=== Test Complete ===');
      console.log(result);
    })
    .catch(console.error);
}
