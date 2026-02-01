/**
 * Fee Relayer Service
 *
 * Off-chain service that relays transactions for users, hiding their identity.
 *
 * ## How It Works
 *
 * 1. User signs a withdrawal tx but has no SOL for fees
 * 2. User submits signed tx to relayer
 * 3. Relayer wraps tx and pays network fees
 * 4. Relayer receives fee from withdrawal amount
 * 5. User gets: withdrawal - relayer_fee
 *
 * ## Privacy Guarantee
 *
 * Without relayer: "Alice withdrew from pool" (Alice visible as fee payer)
 * With relayer: "Relayer submitted withdrawal" (Alice hidden!)
 *
 * Run: npx ts-node scripts/relayer-service.ts
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
    TransactionInstruction,
    ComputeBudgetProgram,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as http from 'http';

// Configuration
const CONFIG = {
    // RPC endpoint
    rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',

    // Program ID
    programId: new PublicKey('6mKNcFyg2qKuobBkket5tVHKE9178N2CkRonkzkprDrp'),

    // HTTP server port
    port: parseInt(process.env.PORT || '3000'),

    // Fee configuration
    feeBps: 50, // 0.5%
    minFee: 10000, // 10,000 lamports (~$0.001)
    maxFee: 100_000_000, // 0.1 SOL max

    // Supported denominations (lamports)
    denominations: [
        1 * LAMPORTS_PER_SOL,   // 1 SOL
        10 * LAMPORTS_PER_SOL,  // 10 SOL
        100 * LAMPORTS_PER_SOL, // 100 SOL
    ],

    // Rate limiting
    maxRequestsPerMinute: 10,

    // Stake amount
    stakeAmount: 1 * LAMPORTS_PER_SOL,
};

// Relay request from user
interface RelayRequest {
    // The serialized transaction to relay (base64)
    transaction: string;
    // Denomination of the withdrawal
    denomination: number;
    // Signature from user proving ownership
    userSignature: string;
    // Recipient address
    recipient: string;
}

// Relay response
interface RelayResponse {
    success: boolean;
    txSignature?: string;
    fee?: number;
    error?: string;
}

// Pending relay tracking
interface PendingRelay {
    txHash: string;
    denomination: number;
    requestedAt: number;
    recipient: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
}

class RelayerService {
    private connection: Connection;
    private relayerKeypair: Keypair;
    private pendingRelays: Map<string, PendingRelay> = new Map();
    private requestCounts: Map<string, number[]> = new Map();
    private isRegistered: boolean = false;

    constructor() {
        this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');

        // Load relayer keypair
        const keypairPath = process.env.RELAYER_KEYPAIR || './relayer-keypair.json';
        if (fs.existsSync(keypairPath)) {
            const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
            this.relayerKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
        } else {
            console.log('Generating new relayer keypair...');
            this.relayerKeypair = Keypair.generate();
            fs.writeFileSync(keypairPath, JSON.stringify(Array.from(this.relayerKeypair.secretKey)));
        }

        console.log('Relayer pubkey:', this.relayerKeypair.publicKey.toBase58());
    }

    /**
     * Calculate fee for a given denomination
     */
    calculateFee(denomination: number): number {
        const percentageFee = Math.floor((denomination * CONFIG.feeBps) / 10000);
        const fee = Math.max(percentageFee, CONFIG.minFee);
        return Math.min(fee, CONFIG.maxFee);
    }

    /**
     * Check if denomination is supported
     */
    supportsDenomination(denomination: number): boolean {
        return CONFIG.denominations.includes(denomination);
    }

    /**
     * Rate limiting check
     */
    isRateLimited(ip: string): boolean {
        const now = Date.now();
        const minute = 60 * 1000;

        let requests = this.requestCounts.get(ip) || [];
        // Remove old requests
        requests = requests.filter(t => now - t < minute);
        this.requestCounts.set(ip, requests);

        return requests.length >= CONFIG.maxRequestsPerMinute;
    }

    /**
     * Record a request for rate limiting
     */
    recordRequest(ip: string): void {
        const requests = this.requestCounts.get(ip) || [];
        requests.push(Date.now());
        this.requestCounts.set(ip, requests);
    }

    /**
     * Get relayer PDA
     */
    getRelayerPDA(): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from('relayer'), this.relayerKeypair.publicKey.toBuffer()],
            CONFIG.programId
        );
    }

    /**
     * Get relayer stake PDA
     */
    getRelayerStakePDA(): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from('relayer_stake'), this.relayerKeypair.publicKey.toBuffer()],
            CONFIG.programId
        );
    }

    /**
     * Get relayer registry PDA
     */
    getRegistryPDA(): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from('relayer_registry')],
            CONFIG.programId
        );
    }

    /**
     * Register as a relayer on-chain
     */
    async register(): Promise<void> {
        console.log('Registering as relayer...');

        const [registryPDA] = this.getRegistryPDA();
        const [relayerPDA] = this.getRelayerPDA();
        const [stakePDA] = this.getRelayerStakePDA();

        // Check if already registered
        try {
            await this.connection.getAccountInfo(relayerPDA);
            console.log('Already registered as relayer');
            this.isRegistered = true;
            return;
        } catch {
            // Not registered, continue
        }

        // Build registration instruction
        // Note: This would use the actual program IDL
        console.log('Building registration transaction...');
        console.log('Registry PDA:', registryPDA.toBase58());
        console.log('Relayer PDA:', relayerPDA.toBase58());
        console.log('Stake PDA:', stakePDA.toBase58());

        // Calculate supported denominations bitmask
        let denomBitmask = 0;
        if (CONFIG.denominations.includes(1 * LAMPORTS_PER_SOL)) denomBitmask |= 1;
        if (CONFIG.denominations.includes(10 * LAMPORTS_PER_SOL)) denomBitmask |= 2;
        if (CONFIG.denominations.includes(100 * LAMPORTS_PER_SOL)) denomBitmask |= 4;

        console.log(`Fee: ${CONFIG.feeBps} bps`);
        console.log(`Min fee: ${CONFIG.minFee} lamports`);
        console.log(`Max fee: ${CONFIG.maxFee} lamports`);
        console.log(`Stake: ${CONFIG.stakeAmount / LAMPORTS_PER_SOL} SOL`);
        console.log(`Supported denominations: ${denomBitmask}`);

        // In production, this would call the actual program
        // For now, just mark as registered
        this.isRegistered = true;
        console.log('Relayer registered (simulated)');
    }

    /**
     * Process a relay request
     */
    async processRelay(request: RelayRequest): Promise<RelayResponse> {
        try {
            // Validate denomination
            if (!this.supportsDenomination(request.denomination)) {
                return {
                    success: false,
                    error: `Unsupported denomination: ${request.denomination / LAMPORTS_PER_SOL} SOL`,
                };
            }

            // Calculate fee
            const fee = this.calculateFee(request.denomination);

            // Decode the transaction
            const txBuffer = Buffer.from(request.transaction, 'base64');
            const userTx = Transaction.from(txBuffer);

            // Verify the transaction is a valid withdrawal
            // In production, verify the instruction data matches expected withdrawal

            // Create wrapper transaction
            const wrapperTx = new Transaction();

            // Add compute budget for complex transaction
            wrapperTx.add(
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: 400000,
                })
            );

            // Add the user's transaction instructions
            userTx.instructions.forEach(ix => {
                wrapperTx.add(ix);
            });

            // Get recent blockhash
            const { blockhash } = await this.connection.getLatestBlockhash();
            wrapperTx.recentBlockhash = blockhash;
            wrapperTx.feePayer = this.relayerKeypair.publicKey;

            // Sign with relayer key
            wrapperTx.sign(this.relayerKeypair);

            // Submit transaction
            const signature = await sendAndConfirmTransaction(
                this.connection,
                wrapperTx,
                [this.relayerKeypair],
                { commitment: 'confirmed' }
            );

            console.log(`Relay completed: ${signature}`);
            console.log(`Fee earned: ${fee / LAMPORTS_PER_SOL} SOL`);

            // Track completed relay
            const txHash = Buffer.from(userTx.signature!).toString('hex');
            this.pendingRelays.set(txHash, {
                txHash,
                denomination: request.denomination,
                requestedAt: Date.now(),
                recipient: request.recipient,
                status: 'completed',
            });

            return {
                success: true,
                txSignature: signature,
                fee,
            };

        } catch (error: any) {
            console.error('Relay failed:', error);
            return {
                success: false,
                error: error.message || 'Unknown error',
            };
        }
    }

    /**
     * Get relayer stats
     */
    getStats() {
        const completed = Array.from(this.pendingRelays.values())
            .filter(r => r.status === 'completed');

        return {
            pubkey: this.relayerKeypair.publicKey.toBase58(),
            isRegistered: this.isRegistered,
            feeBps: CONFIG.feeBps,
            minFee: CONFIG.minFee,
            maxFee: CONFIG.maxFee,
            supportedDenominations: CONFIG.denominations.map(d => d / LAMPORTS_PER_SOL),
            totalRelayed: completed.length,
            pendingCount: this.pendingRelays.size - completed.length,
        };
    }

    /**
     * Start HTTP server
     */
    startServer(): void {
        const server = http.createServer(async (req, res) => {
            // CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            const ip = req.socket.remoteAddress || 'unknown';

            // Rate limiting
            if (this.isRateLimited(ip)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Rate limited' }));
                return;
            }

            this.recordRequest(ip);

            try {
                // GET /info - Get relayer info
                if (req.method === 'GET' && req.url === '/info') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(this.getStats()));
                    return;
                }

                // GET /fee/:denomination - Get fee quote
                if (req.method === 'GET' && req.url?.startsWith('/fee/')) {
                    const denom = parseInt(req.url.split('/')[2]) * LAMPORTS_PER_SOL;
                    if (!this.supportsDenomination(denom)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Unsupported denomination' }));
                        return;
                    }
                    const fee = this.calculateFee(denom);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        denomination: denom / LAMPORTS_PER_SOL,
                        feeLamports: fee,
                        feeSol: fee / LAMPORTS_PER_SOL,
                        userReceives: (denom - fee) / LAMPORTS_PER_SOL,
                    }));
                    return;
                }

                // POST /relay - Submit relay request
                if (req.method === 'POST' && req.url === '/relay') {
                    let body = '';
                    req.on('data', chunk => { body += chunk; });
                    req.on('end', async () => {
                        try {
                            const request: RelayRequest = JSON.parse(body);
                            const response = await this.processRelay(request);
                            res.writeHead(response.success ? 200 : 400, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify(response));
                        } catch (e: any) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: e.message }));
                        }
                    });
                    return;
                }

                // GET /health - Health check
                if (req.method === 'GET' && req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
                    return;
                }

                // 404 for everything else
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));

            } catch (e: any) {
                console.error('Server error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        });

        server.listen(CONFIG.port, () => {
            console.log(`Relayer service listening on port ${CONFIG.port}`);
            console.log('');
            console.log('Endpoints:');
            console.log(`  GET  /info      - Relayer info and stats`);
            console.log(`  GET  /fee/:sol  - Fee quote (e.g., /fee/10 for 10 SOL)`);
            console.log(`  POST /relay     - Submit relay request`);
            console.log(`  GET  /health    - Health check`);
        });
    }

    /**
     * Run the relayer service
     */
    async run(): Promise<void> {
        console.log('Starting Fee Relayer Service...');
        console.log('RPC:', CONFIG.rpcUrl);
        console.log('Program:', CONFIG.programId.toBase58());
        console.log('');

        // Check balance
        const balance = await this.connection.getBalance(this.relayerKeypair.publicKey);
        console.log(`Relayer balance: ${balance / LAMPORTS_PER_SOL} SOL`);

        if (balance < CONFIG.stakeAmount + LAMPORTS_PER_SOL) {
            console.warn(`WARNING: Low balance. Need ${(CONFIG.stakeAmount + LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL} SOL for stake + fees`);
            console.warn(`Fund address: ${this.relayerKeypair.publicKey.toBase58()}`);
        }

        // Register as relayer
        await this.register();

        // Start HTTP server
        this.startServer();
    }
}

// Main
const relayer = new RelayerService();
relayer.run().catch(console.error);
