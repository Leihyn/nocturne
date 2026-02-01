/**
 * Distributed CoinJoin Server
 *
 * A coordinator node that participates in a distributed CoinJoin network.
 * This server:
 * - Accepts client connections for CoinJoin sessions
 * - Coordinates with other coordinator nodes
 * - Uses threshold RSA for distributed blind signatures
 *
 * Run multiple instances of this server to create a decentralized network.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import {
  CoordinatorNetwork,
  CoordinatorConfig,
  performDKG,
  createCoordinatorNetwork,
} from './coordinator-network.js';
import { KeyShare } from '../threshold-rsa.js';
import { BlindSigner } from '../blind-sig.js';
import { loadConfigFromEnv as loadTorConfig, getTorProxyUrl } from '../tor-support.js';
import type { ClientMessage, ServerMessage, CoinJoinSession } from '../types.js';

// ============================================
// Configuration
// ============================================

export interface DistributedServerConfig {
  // Server settings
  port: number;
  host: string;

  // Coordinator network
  nodeId: string;
  peerUrls: string[];

  // Session settings
  minParticipants: number;
  maxParticipants: number;
  sessionTimeoutMs: number;

  // Supported denominations (in lamports)
  denominations: bigint[];

  // Security
  requireTor: boolean;
  rateLimitPerMinute: number;
}

const DEFAULT_CONFIG: DistributedServerConfig = {
  port: 8080,
  host: '0.0.0.0',
  nodeId: '',
  peerUrls: [],
  minParticipants: 3,
  maxParticipants: 10,
  sessionTimeoutMs: 120000,
  denominations: [
    1_000_000_000n,   // 1 SOL
    10_000_000_000n,  // 10 SOL
    100_000_000_000n, // 100 SOL
  ],
  requireTor: false,
  rateLimitPerMinute: 30,
};

// ============================================
// Distributed Server
// ============================================

export class DistributedCoinJoinServer {
  private config: DistributedServerConfig;
  private wss: WebSocketServer | null = null;
  private network: CoordinatorNetwork | null = null;
  private keyShare: KeyShare | null = null;
  private signer: BlindSigner | null = null;

  // Client sessions
  private clients: Map<WebSocket, ClientState> = new Map();
  private sessions: Map<string, LocalSession> = new Map();

  // Rate limiting
  private rateLimits: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(config: Partial<DistributedServerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (!this.config.nodeId) {
      this.config.nodeId = `node-${randomBytes(8).toString('hex')}`;
    }
  }

  /**
   * Initialize the server with a key share
   */
  async initialize(keyShare: KeyShare): Promise<void> {
    this.keyShare = keyShare;

    // Create coordinator network
    this.network = new CoordinatorNetwork({
      nodeId: this.config.nodeId,
      nodeUrl: `ws://${this.config.host}:${this.config.port}`,
      peers: this.config.peerUrls,
      threshold: {
        threshold: 3,
        totalShares: 5,
      },
    });

    this.network.setKeyShare(keyShare);

    // Set up network event handlers
    this.network.onSessionReady = (sessionId) => {
      this.handleNetworkSessionReady(sessionId);
    };

    this.network.onSignatureComplete = (sessionId, signatures) => {
      this.handleNetworkSignatureComplete(sessionId, signatures);
    };

    // Connect to peers
    if (this.config.peerUrls.length > 0) {
      await this.network.connectToPeers();
    }

    console.log(`Coordinator ${this.config.nodeId} initialized`);
    console.log(`Key share index: ${keyShare.index}`);
    console.log(`Peers: ${this.config.peerUrls.length}`);
  }

  /**
   * Start the WebSocket server
   */
  start(): void {
    this.wss = new WebSocketServer({
      port: this.config.port,
      host: this.config.host,
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    console.log(`\nDistributed CoinJoin Server started`);
    console.log(`Node ID: ${this.config.nodeId}`);
    console.log(`Listening on ws://${this.config.host}:${this.config.port}`);
    console.log(`Supported denominations: ${this.config.denominations.map(d => `${d / 1_000_000_000n} SOL`).join(', ')}`);

    // Broadcast key share sync
    if (this.network) {
      this.network.broadcastKeyShareSync();
    }
  }

  /**
   * Handle new client connection
   */
  private handleConnection(ws: WebSocket, req: any): void {
    const clientIp = req.socket.remoteAddress || 'unknown';

    // Check Tor requirement
    if (this.config.requireTor) {
      const host = req.headers?.host || '';
      if (!host.endsWith('.onion')) {
        ws.close(1008, 'Tor connection required');
        return;
      }
    }

    // Rate limiting
    if (!this.checkRateLimit(clientIp)) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    // Initialize client state
    const clientState: ClientState = {
      ws,
      ip: clientIp,
      connectedAt: Date.now(),
      sessionId: null,
      blindedCommitment: null,
    };
    this.clients.set(ws, clientState);

    console.log(`Client connected from ${clientIp}`);

    // Set up message handler
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(ws, message);
      } catch (err) {
        console.error('Failed to parse client message:', err);
        this.sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      this.handleClientDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error(`Client error:`, err.message);
    });

    // Send welcome message
    this.send(ws, {
      type: 'CONNECTED',
      nodeId: this.config.nodeId,
      denominations: this.config.denominations.map(d => d.toString()),
      minParticipants: this.config.minParticipants,
      networkStatus: this.network?.getNetworkStatus(),
    });
  }

  /**
   * Handle client message
   */
  private handleClientMessage(ws: WebSocket, message: ClientMessage): void {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (message.type) {
      case 'JOIN':
        this.handleJoin(ws, client, message);
        break;

      case 'COMMITMENT':
        this.handleCommitment(ws, client, message);
        break;

      case 'OUTPUT':
        this.handleOutput(ws, client, message);
        break;

      case 'LEAVE':
        this.handleLeave(ws, client);
        break;

      default:
        this.sendError(ws, `Unknown message type`);
    }
  }

  /**
   * Handle JOIN message
   */
  private handleJoin(ws: WebSocket, client: ClientState, message: any): void {
    const denomination = BigInt(message.denomination);

    // Validate denomination
    if (!this.config.denominations.includes(denomination)) {
      this.sendError(ws, 'Invalid denomination');
      return;
    }

    // Find or create session for this denomination
    let session = this.findOpenSession(denomination);
    if (!session) {
      session = this.createSession(denomination);
    }

    // Add client to session
    client.sessionId = session.id;
    session.clients.add(ws);

    this.send(ws, {
      type: 'JOINED',
      sessionId: session.id,
      participantCount: session.clients.size,
      minParticipants: this.config.minParticipants,
      publicKey: this.keyShare?.publicKey ? {
        n: this.keyShare.publicKey.n.toString(),
        e: this.keyShare.publicKey.e.toString(),
      } : null,
    });

    // Broadcast participant count update
    this.broadcastToSession(session.id, {
      type: 'PARTICIPANT_UPDATE',
      count: session.clients.size,
      required: this.config.minParticipants,
    });

    console.log(`Client joined session ${session.id} (${session.clients.size}/${this.config.minParticipants})`);
  }

  /**
   * Handle COMMITMENT message (blinded commitment)
   */
  private handleCommitment(ws: WebSocket, client: ClientState, message: any): void {
    if (!client.sessionId) {
      this.sendError(ws, 'Not in a session');
      return;
    }

    const session = this.sessions.get(client.sessionId);
    if (!session) {
      this.sendError(ws, 'Session not found');
      return;
    }

    client.blindedCommitment = message.blindedCommitment;
    session.commitments.set(ws, message.blindedCommitment);

    console.log(`Received commitment for session ${session.id} (${session.commitments.size}/${session.clients.size})`);

    // Check if we have enough commitments
    if (session.commitments.size >= this.config.minParticipants &&
        session.commitments.size === session.clients.size) {
      this.initiateDistributedSigning(session);
    }
  }

  /**
   * Handle OUTPUT message (unblinded output)
   */
  private handleOutput(ws: WebSocket, client: ClientState, message: any): void {
    if (!client.sessionId) {
      this.sendError(ws, 'Not in a session');
      return;
    }

    const session = this.sessions.get(client.sessionId);
    if (!session || session.status !== 'outputs') {
      this.sendError(ws, 'Session not accepting outputs');
      return;
    }

    session.outputs.set(message.output, message.signature);

    console.log(`Received output for session ${session.id} (${session.outputs.size}/${session.clients.size})`);

    // Check if we have all outputs
    if (session.outputs.size === session.clients.size) {
      this.buildTransaction(session);
    }
  }

  /**
   * Handle client leave
   */
  private handleLeave(ws: WebSocket, client: ClientState): void {
    this.removeClientFromSession(ws, client);
  }

  /**
   * Handle client disconnect
   */
  private handleClientDisconnect(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (client) {
      this.removeClientFromSession(ws, client);
    }
    this.clients.delete(ws);
    console.log('Client disconnected');
  }

  /**
   * Remove client from session
   */
  private removeClientFromSession(ws: WebSocket, client: ClientState): void {
    if (!client.sessionId) return;

    const session = this.sessions.get(client.sessionId);
    if (session) {
      session.clients.delete(ws);
      session.commitments.delete(ws);

      if (session.clients.size === 0) {
        this.sessions.delete(client.sessionId);
        console.log(`Session ${client.sessionId} closed (empty)`);
      } else {
        this.broadcastToSession(client.sessionId, {
          type: 'PARTICIPANT_UPDATE',
          count: session.clients.size,
          required: this.config.minParticipants,
        });
      }
    }

    client.sessionId = null;
  }

  // ============================================
  // Session Management
  // ============================================

  private findOpenSession(denomination: bigint): LocalSession | null {
    for (const session of this.sessions.values()) {
      if (session.denomination === denomination &&
          session.status === 'joining' &&
          session.clients.size < this.config.maxParticipants) {
        return session;
      }
    }
    return null;
  }

  private createSession(denomination: bigint): LocalSession {
    const session: LocalSession = {
      id: randomBytes(16).toString('hex'),
      denomination,
      clients: new Set(),
      commitments: new Map(),
      signatures: new Map(),
      outputs: new Map(),
      status: 'joining',
      createdAt: Date.now(),
    };

    this.sessions.set(session.id, session);
    console.log(`Created session ${session.id} for ${denomination / 1_000_000_000n} SOL`);

    // Set session timeout
    setTimeout(() => {
      if (session.status === 'joining') {
        this.cancelSession(session.id, 'Session timeout');
      }
    }, this.config.sessionTimeoutMs);

    return session;
  }

  private cancelSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'cancelled';
    this.broadcastToSession(sessionId, {
      type: 'SESSION_CANCELLED',
      reason,
    });

    this.sessions.delete(sessionId);
    console.log(`Session ${sessionId} cancelled: ${reason}`);
  }

  // ============================================
  // Distributed Signing
  // ============================================

  private initiateDistributedSigning(session: LocalSession): void {
    if (!this.network) {
      console.error('Network not initialized');
      return;
    }

    session.status = 'signing';
    console.log(`Initiating distributed signing for session ${session.id}`);

    // Collect all blinded commitments
    const participants = Array.from(session.commitments.values());

    // Propose session to coordinator network
    const networkSessionId = this.network.proposeSession(session.denomination, participants);

    // Store mapping
    session.networkSessionId = networkSessionId;
  }

  private handleNetworkSessionReady(networkSessionId: string): void {
    // Find local session
    for (const session of this.sessions.values()) {
      if (session.networkSessionId === networkSessionId) {
        this.performDistributedSigning(session);
        break;
      }
    }
  }

  private async performDistributedSigning(session: LocalSession): Promise<void> {
    if (!this.network || !this.keyShare) return;

    console.log(`Starting distributed signing for session ${session.id}`);

    // Request partial signatures for each commitment
    let index = 0;
    for (const [_, blindedCommitment] of session.commitments) {
      const blindedMessage = BigInt('0x' + blindedCommitment);
      this.network.requestPartialSignature(session.networkSessionId!, blindedMessage, index);
      index++;
    }
  }

  private handleNetworkSignatureComplete(networkSessionId: string, signatures: bigint[]): void {
    // Find local session
    for (const session of this.sessions.values()) {
      if (session.networkSessionId === networkSessionId) {
        this.deliverSignatures(session, signatures);
        break;
      }
    }
  }

  private deliverSignatures(session: LocalSession, signatures: bigint[]): void {
    session.status = 'outputs';

    // Send signatures to clients
    let index = 0;
    for (const [ws, _] of session.commitments) {
      const signature = signatures[index];
      this.send(ws, {
        type: 'SIGNATURE',
        signature: signature.toString(),
      });
      index++;
    }

    console.log(`Delivered ${signatures.length} signatures for session ${session.id}`);

    // Broadcast transition to output phase
    this.broadcastToSession(session.id, {
      type: 'OUTPUT_PHASE',
      timeout: 30000,
    });
  }

  // ============================================
  // Transaction Building
  // ============================================

  private buildTransaction(session: LocalSession): void {
    console.log(`Building transaction for session ${session.id}`);
    session.status = 'building';

    // Collect all outputs
    const outputs = Array.from(session.outputs.entries()).map(([output, sig]) => ({
      output,
      signature: sig,
    }));

    // Shuffle outputs (coordinator cannot link inputs to outputs)
    this.shuffleArray(outputs);

    // Broadcast the unsigned transaction
    this.broadcastToSession(session.id, {
      type: 'TRANSACTION_READY',
      outputs: outputs.map(o => o.output),
      // In production, this would include the actual transaction data
    });

    console.log(`Transaction ready with ${outputs.length} outputs`);
    session.status = 'complete';
  }

  private shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  // ============================================
  // Utility Functions
  // ============================================

  private send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string): void {
    this.send(ws, { type: 'ERROR', error });
  }

  private broadcastToSession(sessionId: string, message: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const ws of session.clients) {
      this.send(ws, message);
    }
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    let limit = this.rateLimits.get(ip);

    if (!limit || now > limit.resetAt) {
      limit = { count: 0, resetAt: now + 60000 };
      this.rateLimits.set(ip, limit);
    }

    limit.count++;
    return limit.count <= this.config.rateLimitPerMinute;
  }

  /**
   * Get server status
   */
  getStatus(): {
    nodeId: string;
    clients: number;
    sessions: number;
    networkStatus: any;
  } {
    return {
      nodeId: this.config.nodeId,
      clients: this.clients.size,
      sessions: this.sessions.size,
      networkStatus: this.network?.getNetworkStatus(),
    };
  }

  /**
   * Shutdown the server
   */
  shutdown(): void {
    this.network?.shutdown();
    this.wss?.close();
    console.log('Server shutdown complete');
  }
}

// ============================================
// Types
// ============================================

interface ClientState {
  ws: WebSocket;
  ip: string;
  connectedAt: number;
  sessionId: string | null;
  blindedCommitment: string | null;
}

interface LocalSession {
  id: string;
  denomination: bigint;
  clients: Set<WebSocket>;
  commitments: Map<WebSocket, string>;
  signatures: Map<WebSocket, string>;
  outputs: Map<string, string>;  // output -> signature
  status: 'joining' | 'signing' | 'outputs' | 'building' | 'complete' | 'cancelled';
  createdAt: number;
  networkSessionId?: string;
}

// ============================================
// CLI Entry Point
// ============================================

async function main() {
  const nodeId = process.env.NODE_ID || `node-${randomBytes(4).toString('hex')}`;
  const port = parseInt(process.env.PORT || '8080');
  const peers = (process.env.PEERS || '').split(',').filter(p => p.trim());

  console.log('Starting Distributed CoinJoin Coordinator...');
  console.log(`Node ID: ${nodeId}`);
  console.log(`Port: ${port}`);
  console.log(`Peers: ${peers.length > 0 ? peers.join(', ') : 'none'}`);

  // Perform DKG or load existing key share
  const keyShareIndex = parseInt(process.env.KEY_SHARE_INDEX || '1');

  // In production, key shares would be loaded from secure storage
  // For demo, we generate them on startup
  const dkgResult = await performDKG(
    [nodeId, ...peers],
    { threshold: 3, totalShares: 5 }
  );

  const keyShare = dkgResult.shares[keyShareIndex - 1];

  // Create and start server
  const server = new DistributedCoinJoinServer({
    port,
    nodeId,
    peerUrls: peers,
    requireTor: process.env.REQUIRE_TOR === 'true',
  });

  await server.initialize(keyShare);
  server.start();

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.shutdown();
    process.exit(0);
  });
}

// Run if executed directly
if (process.argv[1]?.endsWith('distributed-server.ts') ||
    process.argv[1]?.endsWith('distributed-server.js')) {
  main().catch(console.error);
}

export { main as startDistributedServer };
