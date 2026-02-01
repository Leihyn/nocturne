/**
 * Light Protocol Privacy Backend
 *
 * Uses ZK Compression for efficient private transactions on Solana.
 * This replaces the expensive on-chain Poseidon hashing with Light Protocol's
 * off-chain compression and ZK proofs.
 *
 * Benefits:
 * - No compute unit issues (heavy computation is off-chain)
 * - 200x cheaper than regular SPL tokens
 * - Production-ready privacy
 */

import {
  Rpc,
  createRpc,
  LightSystemProgram,
  confirmTx,
  bn,
  compress,
  decompress,
  transfer as transferCompressed,
  defaultStateTreeLookupTables,
  getAllStateTreeInfos,
  selectMinCompressedSolAccountsForTransfer,
  buildTx,
} from '@lightprotocol/stateless.js';
import {
  createMint,
  mintTo,
  transfer,
  CompressedTokenProgram,
} from '@lightprotocol/compressed-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from '@solana/web3.js';

// ============================================
// Configuration
// ============================================

// Helius RPC endpoint with ZK compression support
// Get your API key from: https://dev.helius.xyz/
const HELIUS_API_KEY = process.env.NEXT_PUBLIC_HELIUS_API_KEY || '';
const DEVNET_RPC = HELIUS_API_KEY
  ? `https://devnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`
  : 'https://api.devnet.solana.com';

// For compression RPC, we need Helius
const COMPRESSION_RPC = HELIUS_API_KEY
  ? `https://devnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`
  : null;

export interface LightPrivacyConfig {
  rpcEndpoint?: string;
  compressionEndpoint?: string;
  proverEndpoint?: string;
}

// ============================================
// Light Protocol RPC Connection
// ============================================

let rpcConnection: Rpc | null = null;

/**
 * Initialize Light Protocol RPC connection
 * Requires Helius API key for ZK compression support
 */
export function initLightRpc(config?: LightPrivacyConfig): Rpc {
  if (rpcConnection) return rpcConnection;

  const rpc = config?.rpcEndpoint || DEVNET_RPC;
  const compression = config?.compressionEndpoint || COMPRESSION_RPC || rpc;
  const prover = config?.proverEndpoint || compression;

  if (!HELIUS_API_KEY && !config?.compressionEndpoint) {
    console.warn(
      '[LightPrivacy] No Helius API key found. Set NEXT_PUBLIC_HELIUS_API_KEY for ZK compression.'
    );
    console.warn('[LightPrivacy] Get a free key at: https://dev.helius.xyz/');
  }

  rpcConnection = createRpc(rpc, compression, prover);
  console.log('[LightPrivacy] RPC initialized');

  return rpcConnection;
}

/**
 * Get the Light Protocol RPC connection
 */
export function getLightRpc(): Rpc {
  if (!rpcConnection) {
    return initLightRpc();
  }
  return rpcConnection;
}

// ============================================
// Compressed SOL Operations (Shield/Unshield)
// ============================================

export interface ShieldResult {
  success: boolean;
  signature?: string;
  compressedBalance?: bigint;
  error?: string;
}

export interface UnshieldResult {
  success: boolean;
  signature?: string;
  recipient?: string;
  amount?: bigint;
  error?: string;
}

/**
 * Shield SOL - Convert regular SOL to compressed (private) SOL
 *
 * This compresses your SOL into a compressed account that uses
 * ZK proofs for privacy. Much cheaper than Poseidon-based privacy.
 */
export async function shieldSol(
  payer: Keypair,
  amountLamports: bigint,
): Promise<ShieldResult> {
  try {
    const rpc = getLightRpc();

    console.log(`[LightPrivacy] Shielding ${Number(amountLamports) / LAMPORTS_PER_SOL} SOL...`);

    // Use the top-level compress function which handles everything
    const txSig = await compress(
      rpc,
      payer,
      bn(amountLamports.toString()),
      payer.publicKey,
    );

    console.log(`[LightPrivacy] Shield successful: ${txSig}`);

    return {
      success: true,
      signature: txSig,
      compressedBalance: amountLamports,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[LightPrivacy] Shield failed:', error);
    return { success: false, error };
  }
}

/**
 * Unshield SOL - Convert compressed SOL back to regular SOL
 */
export async function unshieldSol(
  payer: Keypair,
  recipient: PublicKey,
  amountLamports: bigint,
): Promise<UnshieldResult> {
  try {
    const rpc = getLightRpc();

    console.log(`[LightPrivacy] Unshielding ${Number(amountLamports) / LAMPORTS_PER_SOL} SOL to ${recipient.toBase58()}...`);

    // Use the top-level decompress function which handles everything
    const txSig = await decompress(
      rpc,
      payer,
      bn(amountLamports.toString()),
      recipient,
    );

    console.log(`[LightPrivacy] Unshield successful: ${txSig}`);

    return {
      success: true,
      signature: txSig,
      recipient: recipient.toBase58(),
      amount: amountLamports,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[LightPrivacy] Unshield failed:', error);
    return { success: false, error };
  }
}

/**
 * Transfer compressed SOL privately
 */
export async function transferCompressedSol(
  payer: Keypair,
  recipient: PublicKey,
  amountLamports: bigint,
): Promise<ShieldResult> {
  try {
    const rpc = getLightRpc();

    console.log(`[LightPrivacy] Transferring ${Number(amountLamports) / LAMPORTS_PER_SOL} compressed SOL...`);

    // Use the top-level transfer function which handles everything
    const txSig = await transferCompressed(
      rpc,
      payer,
      bn(amountLamports.toString()),
      payer, // owner
      recipient,
    );

    console.log(`[LightPrivacy] Transfer successful: ${txSig}`);

    return {
      success: true,
      signature: txSig,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[LightPrivacy] Transfer failed:', error);
    return { success: false, error };
  }
}

// ============================================
// Compressed Token Operations
// ============================================

/**
 * Create a new compressed token mint
 */
export async function createCompressedMint(
  payer: Keypair,
  decimals: number = 9,
): Promise<{ mint: PublicKey; signature: string } | null> {
  try {
    const rpc = getLightRpc();

    console.log('[LightPrivacy] Creating compressed token mint...');

    const { mint, transactionSignature } = await createMint(
      rpc,
      payer,
      payer.publicKey, // mint authority
      decimals,
    );

    console.log(`[LightPrivacy] Mint created: ${mint.toBase58()}`);

    return { mint, signature: transactionSignature };
  } catch (err) {
    console.error('[LightPrivacy] Create mint failed:', err);
    return null;
  }
}

/**
 * Mint compressed tokens
 */
export async function mintCompressedTokens(
  payer: Keypair,
  mint: PublicKey,
  recipient: PublicKey,
  amount: bigint,
): Promise<string | null> {
  try {
    const rpc = getLightRpc();

    console.log(`[LightPrivacy] Minting ${amount} compressed tokens...`);

    const signature = await mintTo(
      rpc,
      payer,
      mint,
      recipient,
      payer, // mint authority
      bn(amount.toString()),
    );

    console.log(`[LightPrivacy] Mint successful: ${signature}`);

    return signature;
  } catch (err) {
    console.error('[LightPrivacy] Mint failed:', err);
    return null;
  }
}

/**
 * Transfer compressed tokens privately
 */
export async function transferCompressedTokens(
  payer: Keypair,
  mint: PublicKey,
  recipient: PublicKey,
  amount: bigint,
): Promise<string | null> {
  try {
    const rpc = getLightRpc();

    console.log(`[LightPrivacy] Transferring ${amount} compressed tokens...`);

    const signature = await transfer(
      rpc,
      payer,
      mint,
      bn(amount.toString()),
      payer, // owner
      recipient,
    );

    console.log(`[LightPrivacy] Transfer successful: ${signature}`);

    return signature;
  } catch (err) {
    console.error('[LightPrivacy] Transfer failed:', err);
    return null;
  }
}

// ============================================
// Balance Queries
// ============================================

/**
 * Get compressed SOL balance
 */
export async function getCompressedSolBalance(owner: PublicKey): Promise<bigint> {
  try {
    const rpc = getLightRpc();

    const balance = await rpc.getCompressedAccountsByOwner(owner);

    let total = BigInt(0);
    for (const account of balance.items) {
      total += BigInt(account.lamports.toString());
    }

    return total;
  } catch (err) {
    console.error('[LightPrivacy] Get balance failed:', err);
    return BigInt(0);
  }
}

/**
 * Get compressed token balance
 */
export async function getCompressedTokenBalance(
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  try {
    const rpc = getLightRpc();

    const accounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });

    let total = BigInt(0);
    for (const account of accounts.items) {
      total += BigInt(account.parsed.amount.toString());
    }

    return total;
  } catch (err) {
    console.error('[LightPrivacy] Get token balance failed:', err);
    return BigInt(0);
  }
}

// ============================================
// Wallet Adapter Integration
// ============================================

/**
 * Shield SOL using wallet adapter (browser)
 */
export async function shieldSolWithWallet(
  connection: Connection,
  publicKey: PublicKey,
  amountLamports: bigint,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
): Promise<ShieldResult> {
  try {
    const rpc = getLightRpc();

    console.log(`[LightPrivacy] Shielding ${Number(amountLamports) / LAMPORTS_PER_SOL} SOL with wallet...`);

    // Get state tree info for compression
    const stateTreeLUTPairs = defaultStateTreeLookupTables().devnet;
    const treeInfos = await getAllStateTreeInfos({ connection, stateTreeLUTPairs });
    // Pick a random tree info
    const outputStateTreeInfo = treeInfos[Math.floor(Math.random() * treeInfos.length)];

    // Build compress instruction with tree info
    const compressIx = await LightSystemProgram.compress({
      payer: publicKey,
      toAddress: publicKey,
      lamports: bn(amountLamports.toString()),
      outputStateTreeInfo,
    });

    const tx = new Transaction().add(compressIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = publicKey;

    const signedTx = await signTransaction(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize());

    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    console.log(`[LightPrivacy] Shield successful: ${signature}`);

    return {
      success: true,
      signature,
      compressedBalance: amountLamports,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[LightPrivacy] Shield failed:', error);
    return { success: false, error };
  }
}

/**
 * Unshield SOL using wallet adapter (browser)
 *
 * Decompresses compressed SOL back to regular SOL.
 * This requires fetching compressed accounts and validity proofs.
 */
export async function unshieldSolWithWallet(
  connection: Connection,
  publicKey: PublicKey,
  recipient: PublicKey,
  amountLamports: bigint,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
): Promise<UnshieldResult> {
  try {
    const rpc = getLightRpc();

    console.log(`[LightPrivacy] Unshielding ${Number(amountLamports) / LAMPORTS_PER_SOL} SOL with wallet...`);

    // 1. Fetch compressed accounts owned by the user
    const compressedAccounts = await rpc.getCompressedAccountsByOwner(publicKey);

    if (!compressedAccounts.items || compressedAccounts.items.length === 0) {
      return {
        success: false,
        error: 'No compressed accounts found. Shield some SOL first.',
      };
    }

    console.log(`[LightPrivacy] Found ${compressedAccounts.items.length} compressed accounts`);

    // 2. Select accounts with enough balance for the transfer
    const amountBN = bn(amountLamports.toString());
    const [selectedAccounts, total] = selectMinCompressedSolAccountsForTransfer(
      compressedAccounts.items,
      amountBN,
    );

    if (selectedAccounts.length === 0) {
      return {
        success: false,
        error: `Insufficient compressed balance. Have ${total.toString()} lamports, need ${amountLamports.toString()}`,
      };
    }

    console.log(`[LightPrivacy] Selected ${selectedAccounts.length} accounts with ${total.toString()} lamports`);

    // 3. Get validity proofs for the selected accounts
    const accountHashes = selectedAccounts.map(acc => bn(acc.hash));
    const validityProof = await rpc.getValidityProof(accountHashes, []);

    console.log('[LightPrivacy] Got validity proof');

    // 4. Build decompress instruction
    const decompressIx = await LightSystemProgram.decompress({
      payer: publicKey,
      inputCompressedAccounts: selectedAccounts,
      toAddress: recipient,
      lamports: amountBN,
      recentInputStateRootIndices: validityProof.rootIndices,
      recentValidityProof: validityProof.compressedProof,
    });

    // 5. Build and sign transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

    const tx = new Transaction().add(decompressIx);
    tx.recentBlockhash = blockhash;
    tx.feePayer = publicKey;

    const signedTx = await signTransaction(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize());

    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    console.log(`[LightPrivacy] Unshield successful: ${signature}`);

    return {
      success: true,
      signature,
      recipient: recipient.toBase58(),
      amount: amountLamports,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[LightPrivacy] Unshield failed:', error);
    return { success: false, error };
  }
}

// ============================================
// Check Helius API Key
// ============================================

export function hasHeliusApiKey(): boolean {
  return !!HELIUS_API_KEY;
}

export function getHeliusSignupUrl(): string {
  return 'https://dev.helius.xyz/';
}
