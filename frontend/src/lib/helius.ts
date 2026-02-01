/**
 * Helius RPC Integration
 *
 * Provides enhanced Solana RPC access via Helius infrastructure.
 * https://www.helius.dev
 *
 * Benefits:
 * - Faster transaction confirmation
 * - More reliable than public RPC
 * - Enhanced APIs (DAS, webhooks, etc.)
 * - Better rate limits
 *
 * Get your free API key at: https://dashboard.helius.dev
 */

import { Connection, Commitment } from '@solana/web3.js';

// Helius RPC endpoints
export const HELIUS_DEVNET_BASE = 'https://devnet.helius-rpc.com';
export const HELIUS_MAINNET_BASE = 'https://mainnet.helius-rpc.com';

// Helius API endpoints (for enhanced features)
export const HELIUS_API_DEVNET = 'https://api-devnet.helius.xyz/v0';
export const HELIUS_API_MAINNET = 'https://api.helius.xyz/v0';

/**
 * Network type
 */
export type HeliusNetwork = 'devnet' | 'mainnet';

/**
 * Helius configuration
 */
export interface HeliusConfig {
  apiKey: string;
  network?: HeliusNetwork;
  commitment?: Commitment;
}

/**
 * Get Helius RPC URL
 */
export function getHeliusRpcUrl(apiKey: string, network: HeliusNetwork = 'devnet'): string {
  const base = network === 'mainnet' ? HELIUS_MAINNET_BASE : HELIUS_DEVNET_BASE;
  return `${base}/?api-key=${apiKey}`;
}

/**
 * Get Helius API URL (for enhanced features)
 */
export function getHeliusApiUrl(network: HeliusNetwork = 'devnet'): string {
  return network === 'mainnet' ? HELIUS_API_MAINNET : HELIUS_API_DEVNET;
}

/**
 * Create a Solana connection using Helius RPC
 */
export function createHeliusConnection(
  apiKey: string,
  network: HeliusNetwork = 'devnet',
  commitment: Commitment = 'confirmed'
): Connection {
  const rpcUrl = getHeliusRpcUrl(apiKey, network);
  return new Connection(rpcUrl, {
    commitment,
    confirmTransactionInitialTimeout: 60000,
  });
}

/**
 * Helius Enhanced API Client
 *
 * Provides access to Helius-specific features like:
 * - Digital Asset Standard (DAS) API
 * - Enhanced transaction history
 * - Webhook management
 * - Priority fee estimation
 */
export class HeliusClient {
  private apiKey: string;
  private network: HeliusNetwork;
  private connection: Connection;
  private apiBase: string;

  constructor(config: HeliusConfig) {
    this.apiKey = config.apiKey;
    this.network = config.network ?? 'devnet';
    this.connection = createHeliusConnection(
      this.apiKey,
      this.network,
      config.commitment ?? 'confirmed'
    );
    this.apiBase = getHeliusApiUrl(this.network);
  }

  /**
   * Get the Solana connection
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get RPC URL (for external use)
   */
  getRpcUrl(): string {
    return getHeliusRpcUrl(this.apiKey, this.network);
  }

  /**
   * Get priority fee estimate for a transaction
   * Helps ensure transactions land quickly
   */
  async getPriorityFeeEstimate(
    accountKeys: string[],
    options?: { priorityLevel?: 'min' | 'low' | 'medium' | 'high' | 'veryHigh' | 'unsafeMax' }
  ): Promise<{ priorityFeeEstimate: number }> {
    const response = await fetch(`${this.apiBase}/priority-fee?api-key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountKeys,
        options: {
          priorityLevel: options?.priorityLevel ?? 'medium',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get enhanced transaction history for an address
   * More detailed than standard RPC
   */
  async getTransactionHistory(
    address: string,
    options?: { limit?: number; before?: string }
  ): Promise<any[]> {
    const params = new URLSearchParams({
      'api-key': this.apiKey,
    });

    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.before) params.append('before', options.before);

    const response = await fetch(
      `${this.apiBase}/addresses/${address}/transactions?${params}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Parse a transaction for human-readable details
   */
  async parseTransaction(signature: string): Promise<any> {
    const response = await fetch(`${this.apiBase}/transactions?api-key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactions: [signature],
      }),
    });

    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status}`);
    }

    const data = await response.json();
    return data[0];
  }

  /**
   * Get assets owned by an address (DAS API)
   */
  async getAssetsByOwner(
    owner: string,
    options?: { page?: number; limit?: number }
  ): Promise<any> {
    const rpcUrl = this.getRpcUrl();

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'helius-das',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: owner,
          page: options?.page ?? 1,
          limit: options?.limit ?? 100,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Helius RPC error: ${response.status}`);
    }

    const data = await response.json();
    return data.result;
  }
}

/**
 * Create a Helius client for devnet
 */
export function createHeliusClient(apiKey: string, network: HeliusNetwork = 'devnet'): HeliusClient {
  return new HeliusClient({ apiKey, network });
}

/**
 * Get RPC URL with Helius fallback
 *
 * If Helius API key is provided, use Helius.
 * Otherwise, fall back to public RPC.
 */
export function getRpcUrl(heliusApiKey?: string, network: HeliusNetwork = 'devnet'): string {
  if (heliusApiKey) {
    return getHeliusRpcUrl(heliusApiKey, network);
  }

  // Fallback to public RPC
  return network === 'mainnet'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com';
}

/**
 * Create connection with Helius if available
 */
export function createConnection(
  heliusApiKey?: string,
  network: HeliusNetwork = 'devnet',
  commitment: Commitment = 'confirmed'
): Connection {
  const rpcUrl = getRpcUrl(heliusApiKey, network);
  return new Connection(rpcUrl, { commitment });
}
