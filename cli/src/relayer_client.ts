/**
 * Relayer Client SDK
 *
 * Client library for users to interact with fee relayers.
 *
 * ## Usage
 *
 * ```typescript
 * const client = new RelayerClient('http://localhost:3000');
 *
 * // Get relayer info
 * const info = await client.getInfo();
 *
 * // Get fee quote
 * const quote = await client.getFeeQuote(10); // 10 SOL
 *
 * // Submit relayed withdrawal
 * const result = await client.submitRelayedWithdraw(
 *     signedTx,
 *     denomination,
 *     recipientAddress
 * );
 * ```
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';

// Relayer info response
export interface RelayerInfo {
    pubkey: string;
    isRegistered: boolean;
    feeBps: number;
    minFee: number;
    maxFee: number;
    supportedDenominations: number[];
    totalRelayed: number;
    pendingCount: number;
}

// Fee quote response
export interface FeeQuote {
    denomination: number;
    feeLamports: number;
    feeSol: number;
    userReceives: number;
}

// Relay result
export interface RelayResult {
    success: boolean;
    txSignature?: string;
    fee?: number;
    error?: string;
}

// Relayer endpoint
export interface RelayerEndpoint {
    url: string;
    pubkey: string;
    feeBps: number;
    reputation?: number;
}

/**
 * Client for interacting with a single relayer
 */
export class RelayerClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    }

    /**
     * Get relayer info
     */
    async getInfo(): Promise<RelayerInfo> {
        const response = await fetch(`${this.baseUrl}/info`);
        if (!response.ok) {
            throw new Error(`Failed to get relayer info: ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Get fee quote for a denomination
     */
    async getFeeQuote(denominationSol: number): Promise<FeeQuote> {
        const response = await fetch(`${this.baseUrl}/fee/${denominationSol}`);
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Failed to get fee quote: ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Check if relayer supports a denomination
     */
    async supportsDenomination(denominationSol: number): Promise<boolean> {
        try {
            await this.getFeeQuote(denominationSol);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Submit a relayed withdrawal
     *
     * @param signedTx - The transaction signed by the user (proving ownership)
     * @param denomination - Withdrawal amount in lamports
     * @param recipient - Recipient address
     */
    async submitRelayedWithdraw(
        signedTx: Transaction,
        denomination: number,
        recipient: PublicKey,
    ): Promise<RelayResult> {
        // Serialize the transaction
        const serialized = signedTx.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        });

        const request = {
            transaction: serialized.toString('base64'),
            denomination,
            userSignature: signedTx.signatures[0]?.signature
                ? Buffer.from(signedTx.signatures[0].signature).toString('base64')
                : '',
            recipient: recipient.toBase58(),
        };

        const response = await fetch(`${this.baseUrl}/relay`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });

        return response.json();
    }

    /**
     * Check health of relayer
     */
    async isHealthy(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/health`);
            return response.ok;
        } catch {
            return false;
        }
    }
}

/**
 * Client for discovering and selecting relayers
 */
export class RelayerDiscovery {
    private connection: Connection;
    private programId: PublicKey;
    private knownRelayers: RelayerEndpoint[] = [];

    constructor(
        connection: Connection,
        programId: PublicKey,
        knownRelayers: RelayerEndpoint[] = []
    ) {
        this.connection = connection;
        this.programId = programId;
        this.knownRelayers = knownRelayers;
    }

    /**
     * Get registry PDA
     */
    getRegistryPDA(): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from('relayer_registry')],
            this.programId
        );
    }

    /**
     * Get relayer PDA for a pubkey
     */
    getRelayerPDA(relayerPubkey: PublicKey): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from('relayer'), relayerPubkey.toBuffer()],
            this.programId
        );
    }

    /**
     * Add a known relayer endpoint
     */
    addRelayer(endpoint: RelayerEndpoint): void {
        this.knownRelayers.push(endpoint);
    }

    /**
     * Get all known relayers
     */
    getKnownRelayers(): RelayerEndpoint[] {
        return [...this.knownRelayers];
    }

    /**
     * Find best relayer for a denomination
     *
     * Selects based on: availability, fee, reputation
     */
    async findBestRelayer(denominationSol: number): Promise<RelayerClient | null> {
        const candidates: { endpoint: RelayerEndpoint; fee: number }[] = [];

        for (const endpoint of this.knownRelayers) {
            try {
                const client = new RelayerClient(endpoint.url);
                const quote = await client.getFeeQuote(denominationSol);
                candidates.push({ endpoint, fee: quote.feeLamports });
            } catch {
                // Relayer unavailable or doesn't support denomination
                continue;
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        // Sort by fee (lowest first), then by reputation (highest first)
        candidates.sort((a, b) => {
            if (a.fee !== b.fee) return a.fee - b.fee;
            return (b.endpoint.reputation || 0) - (a.endpoint.reputation || 0);
        });

        return new RelayerClient(candidates[0].endpoint.url);
    }

    /**
     * Get fee quotes from all relayers
     */
    async getAllFeeQuotes(denominationSol: number): Promise<Map<string, FeeQuote>> {
        const quotes = new Map<string, FeeQuote>();

        await Promise.all(
            this.knownRelayers.map(async (endpoint) => {
                try {
                    const client = new RelayerClient(endpoint.url);
                    const quote = await client.getFeeQuote(denominationSol);
                    quotes.set(endpoint.url, quote);
                } catch {
                    // Skip unavailable relayers
                }
            })
        );

        return quotes;
    }
}

/**
 * Helper to build a relayed withdrawal transaction
 */
export async function buildRelayedWithdrawTx(
    connection: Connection,
    programId: PublicKey,
    userKeypair: Keypair,
    denomination: number,
    recipient: PublicKey,
    relayerPubkey: PublicKey,
    nullifierHash: Uint8Array,
    proof: Uint8Array,
): Promise<Transaction> {
    // Build the withdrawal instruction
    // This would be the actual program instruction with ZK proof

    const tx = new Transaction();

    // The actual instruction would be added here
    // For now, return empty tx that would be filled in by the actual CLI

    // Important: The user signs this, but does NOT pay fees
    // The relayer will wrap this and pay fees

    return tx;
}

/**
 * High-level function to perform a relayed withdrawal
 */
export async function relayedWithdraw(
    connection: Connection,
    programId: PublicKey,
    userKeypair: Keypair,
    denomination: number,
    recipient: PublicKey,
    relayerUrl: string,
    nullifierHash: Uint8Array,
    proof: Uint8Array,
): Promise<RelayResult> {
    // 1. Get relayer info
    const client = new RelayerClient(relayerUrl);
    const info = await client.getInfo();

    if (!info.isRegistered) {
        throw new Error('Relayer is not registered');
    }

    // 2. Check fee quote
    const denomSol = denomination / LAMPORTS_PER_SOL;
    const quote = await client.getFeeQuote(denomSol);
    console.log(`Relayer fee: ${quote.feeSol} SOL`);
    console.log(`You will receive: ${quote.userReceives} SOL`);

    // 3. Build transaction
    const tx = await buildRelayedWithdrawTx(
        connection,
        programId,
        userKeypair,
        denomination,
        recipient,
        new PublicKey(info.pubkey),
        nullifierHash,
        proof,
    );

    // 4. Sign with user key (proves ownership)
    tx.feePayer = new PublicKey(info.pubkey); // Relayer pays fees
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.partialSign(userKeypair);

    // 5. Submit to relayer
    const result = await client.submitRelayedWithdraw(tx, denomination, recipient);

    return result;
}

// Default relayer endpoints for different networks
export const DEFAULT_RELAYERS = {
    devnet: [
        {
            url: 'http://localhost:3000',
            pubkey: '',
            feeBps: 50,
        },
    ],
    mainnet: [
        // Production relayers would be listed here
    ],
};
