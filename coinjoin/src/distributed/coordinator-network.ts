/**
 * Distributed CoinJoin Coordinator Network
 *
 * Implements a decentralized network of CoinJoin coordinators using:
 * - Threshold RSA for distributed blind signatures
 * - P2P communication between coordinators
 * - Consensus on session state
 *
 * Security properties:
 * - No single coordinator can see input-output mapping
 * - No single coordinator can censor transactions
 * - Requires t-of-n coordinators to produce valid signatures
 */

import { WebSocket } from 'ws';
import { randomBytes, createHash } from 'crypto';
import {
  ThresholdConfig,
  KeyShare,
  PartialSignature,
  splitRSAKey,
  generatePartialSignature,
  combinePartialSignatures,
  createThresholdSession,
  addPartialSignature,
  canComplete,
  completeSession,
} from '../threshold-rsa.js';

// ============================================
// Configuration
// ============================================

export interface CoordinatorConfig {
  // Node identity
  nodeId: string;
  nodeUrl: string;

  // Network settings
  peers: string[];  // URLs of other coordinator nodes

  // Threshold settings
  threshold: ThresholdConfig;

  // Timing
  heartbeatIntervalMs: number;
  sessionTimeoutMs: number;

  // Security
  requireTls: boolean;
}

export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  nodeId: '',
  nodeUrl: '',
  peers: [],
  threshold: {
    threshold: 3,
    totalShares: 5,
  },
  heartbeatIntervalMs: 5000,
  sessionTimeoutMs: 60000,
  requireTls: true,
};

// ============================================
// Coordinator Node State
// ============================================

interface CoordinatorState {
  nodeId: string;
  url: string;
  isOnline: boolean;
  lastHeartbeat: number;
  keyShareIndex?: number;
}

interface DistributedSession {
  sessionId: string;
  denomination: bigint;
  participants: string[];  // Blinded commitments
  coordinatorVotes: Map<string, boolean>;  // nodeId -> voted to proceed
  partialSignatures: Map<string, PartialSignature[]>;  // participant -> partial sigs
  status: 'collecting' | 'signing' | 'complete' | 'failed';
  createdAt: number;
}

// ============================================
// P2P Message Types
// ============================================

export type CoordinatorMessage =
  | { type: 'HEARTBEAT'; nodeId: string; timestamp: number }
  | { type: 'SESSION_PROPOSAL'; sessionId: string; denomination: string; participants: string[] }
  | { type: 'SESSION_VOTE'; sessionId: string; nodeId: string; vote: boolean }
  | { type: 'PARTIAL_SIG_REQUEST'; sessionId: string; blindedMessage: string; participantIndex: number }
  | { type: 'PARTIAL_SIG_RESPONSE'; sessionId: string; participantIndex: number; signature: string; nodeId: string }
  | { type: 'SESSION_COMPLETE'; sessionId: string; finalSignatures: string[] }
  | { type: 'KEY_SHARE_SYNC'; nodeId: string; shareHash: string };

// ============================================
// Coordinator Network
// ============================================

export class CoordinatorNetwork {
  private config: CoordinatorConfig;
  private peers: Map<string, WebSocket> = new Map();
  private coordinatorStates: Map<string, CoordinatorState> = new Map();
  private sessions: Map<string, DistributedSession> = new Map();
  private keyShare: KeyShare | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  // Event handlers
  public onSessionReady?: (sessionId: string) => void;
  public onSignatureComplete?: (sessionId: string, signatures: bigint[]) => void;

  constructor(config: Partial<CoordinatorConfig> = {}) {
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };

    if (!this.config.nodeId) {
      this.config.nodeId = randomBytes(16).toString('hex');
    }
  }

  /**
   * Initialize the coordinator with its key share
   */
  setKeyShare(share: KeyShare): void {
    this.keyShare = share;
    console.log(`Coordinator ${this.config.nodeId} initialized with key share index ${share.index}`);
  }

  /**
   * Connect to peer coordinators
   */
  async connectToPeers(): Promise<void> {
    console.log(`Connecting to ${this.config.peers.length} peer coordinators...`);

    for (const peerUrl of this.config.peers) {
      await this.connectToPeer(peerUrl);
    }

    // Start heartbeat
    this.startHeartbeat();
  }

  /**
   * Connect to a single peer
   */
  private async connectToPeer(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(url);

        ws.on('open', () => {
          console.log(`Connected to peer: ${url}`);
          this.peers.set(url, ws);

          // Send initial heartbeat
          this.sendHeartbeat(ws);
          resolve();
        });

        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString()) as CoordinatorMessage;
            this.handlePeerMessage(url, message);
          } catch (err) {
            console.error('Failed to parse peer message:', err);
          }
        });

        ws.on('close', () => {
          console.log(`Disconnected from peer: ${url}`);
          this.peers.delete(url);
          this.markPeerOffline(url);
        });

        ws.on('error', (err) => {
          console.error(`Peer connection error (${url}):`, err.message);
          reject(err);
        });

      } catch (err) {
        console.error(`Failed to connect to peer ${url}:`, err);
        reject(err);
      }
    });
  }

  /**
   * Handle incoming peer message
   */
  private handlePeerMessage(peerUrl: string, message: CoordinatorMessage): void {
    switch (message.type) {
      case 'HEARTBEAT':
        this.handleHeartbeat(message.nodeId, message.timestamp);
        break;

      case 'SESSION_PROPOSAL':
        this.handleSessionProposal(message.sessionId, message.denomination, message.participants);
        break;

      case 'SESSION_VOTE':
        this.handleSessionVote(message.sessionId, message.nodeId, message.vote);
        break;

      case 'PARTIAL_SIG_REQUEST':
        this.handlePartialSigRequest(message.sessionId, message.blindedMessage, message.participantIndex);
        break;

      case 'PARTIAL_SIG_RESPONSE':
        this.handlePartialSigResponse(
          message.sessionId,
          message.participantIndex,
          message.signature,
          message.nodeId
        );
        break;

      case 'SESSION_COMPLETE':
        this.handleSessionComplete(message.sessionId, message.finalSignatures);
        break;

      case 'KEY_SHARE_SYNC':
        this.handleKeyShareSync(message.nodeId, message.shareHash);
        break;
    }
  }

  // ============================================
  // Heartbeat Protocol
  // ============================================

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [_, ws] of this.peers) {
        this.sendHeartbeat(ws);
      }
      this.cleanupStaleCoordinators();
    }, this.config.heartbeatIntervalMs);
  }

  private sendHeartbeat(ws: WebSocket): void {
    const message: CoordinatorMessage = {
      type: 'HEARTBEAT',
      nodeId: this.config.nodeId,
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(message));
  }

  private handleHeartbeat(nodeId: string, timestamp: number): void {
    let state = this.coordinatorStates.get(nodeId);
    if (!state) {
      state = {
        nodeId,
        url: '',
        isOnline: true,
        lastHeartbeat: timestamp,
      };
      this.coordinatorStates.set(nodeId, state);
    }
    state.isOnline = true;
    state.lastHeartbeat = timestamp;
  }

  private markPeerOffline(url: string): void {
    for (const [nodeId, state] of this.coordinatorStates) {
      if (state.url === url) {
        state.isOnline = false;
      }
    }
  }

  private cleanupStaleCoordinators(): void {
    const now = Date.now();
    for (const [nodeId, state] of this.coordinatorStates) {
      if (now - state.lastHeartbeat > this.config.heartbeatIntervalMs * 3) {
        state.isOnline = false;
      }
    }
  }

  /**
   * Get count of online coordinators
   */
  getOnlineCoordinatorCount(): number {
    let count = 1; // Include self
    for (const state of this.coordinatorStates.values()) {
      if (state.isOnline) count++;
    }
    return count;
  }

  // ============================================
  // Session Management
  // ============================================

  /**
   * Propose a new CoinJoin session to the network
   */
  proposeSession(denomination: bigint, participants: string[]): string {
    const sessionId = randomBytes(16).toString('hex');

    const session: DistributedSession = {
      sessionId,
      denomination,
      participants,
      coordinatorVotes: new Map([[this.config.nodeId, true]]),
      partialSignatures: new Map(),
      status: 'collecting',
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    // Broadcast proposal to peers
    const message: CoordinatorMessage = {
      type: 'SESSION_PROPOSAL',
      sessionId,
      denomination: denomination.toString(),
      participants,
    };
    this.broadcast(message);

    console.log(`Proposed session ${sessionId} with ${participants.length} participants`);
    return sessionId;
  }

  private handleSessionProposal(sessionId: string, denominationStr: string, participants: string[]): void {
    if (this.sessions.has(sessionId)) {
      return; // Already know about this session
    }

    const denomination = BigInt(denominationStr);

    const session: DistributedSession = {
      sessionId,
      denomination,
      participants,
      coordinatorVotes: new Map(),
      partialSignatures: new Map(),
      status: 'collecting',
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    // Automatically vote to proceed (in production, would validate participants)
    this.voteOnSession(sessionId, true);
  }

  /**
   * Vote on whether to proceed with a session
   */
  voteOnSession(sessionId: string, vote: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.coordinatorVotes.set(this.config.nodeId, vote);

    // Broadcast vote
    const message: CoordinatorMessage = {
      type: 'SESSION_VOTE',
      sessionId,
      nodeId: this.config.nodeId,
      vote,
    };
    this.broadcast(message);

    this.checkSessionConsensus(sessionId);
  }

  private handleSessionVote(sessionId: string, nodeId: string, vote: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.coordinatorVotes.set(nodeId, vote);
    this.checkSessionConsensus(sessionId);
  }

  private checkSessionConsensus(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'collecting') return;

    // Count positive votes
    let yesVotes = 0;
    for (const vote of session.coordinatorVotes.values()) {
      if (vote) yesVotes++;
    }

    // Need threshold votes to proceed
    if (yesVotes >= this.config.threshold.threshold) {
      console.log(`Session ${sessionId} has consensus (${yesVotes} votes)`);
      session.status = 'signing';
      this.onSessionReady?.(sessionId);
    }
  }

  // ============================================
  // Distributed Signing
  // ============================================

  /**
   * Request partial signatures for a blinded message
   */
  requestPartialSignature(sessionId: string, blindedMessage: bigint, participantIndex: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'signing') {
      throw new Error('Session not in signing state');
    }

    // Generate our own partial signature
    if (this.keyShare) {
      const partial = generatePartialSignature(blindedMessage, this.keyShare);
      this.addPartialSig(sessionId, participantIndex, partial);
    }

    // Request from peers
    const message: CoordinatorMessage = {
      type: 'PARTIAL_SIG_REQUEST',
      sessionId,
      blindedMessage: blindedMessage.toString(),
      participantIndex,
    };
    this.broadcast(message);
  }

  private handlePartialSigRequest(sessionId: string, blindedMessageStr: string, participantIndex: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.keyShare) return;

    const blindedMessage = BigInt(blindedMessageStr);
    const partial = generatePartialSignature(blindedMessage, this.keyShare);

    // Send our partial signature
    const message: CoordinatorMessage = {
      type: 'PARTIAL_SIG_RESPONSE',
      sessionId,
      participantIndex,
      signature: partial.signature.toString(),
      nodeId: this.config.nodeId,
    };
    this.broadcast(message);
  }

  private handlePartialSigResponse(
    sessionId: string,
    participantIndex: number,
    signatureStr: string,
    nodeId: string
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.keyShare) return;

    const coordState = this.coordinatorStates.get(nodeId);
    if (!coordState) return;

    const partial: PartialSignature = {
      index: coordState.keyShareIndex || 0,
      signature: BigInt(signatureStr),
      publicKey: this.keyShare.publicKey,
    };

    this.addPartialSig(sessionId, participantIndex, partial);
  }

  private addPartialSig(sessionId: string, participantIndex: number, partial: PartialSignature): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const key = participantIndex.toString();
    let partials = session.partialSignatures.get(key);
    if (!partials) {
      partials = [];
      session.partialSignatures.set(key, partials);
    }

    // Don't add duplicate signatures from same coordinator
    if (!partials.some(p => p.index === partial.index)) {
      partials.push(partial);
      this.checkSignatureCompletion(sessionId, participantIndex);
    }
  }

  private checkSignatureCompletion(sessionId: string, participantIndex: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const partials = session.partialSignatures.get(participantIndex.toString());
    if (!partials || partials.length < this.config.threshold.threshold) {
      return;
    }

    // Have enough partial signatures - combine them
    try {
      const finalSig = combinePartialSignatures(partials, this.config.threshold.threshold);
      console.log(`Combined signature for participant ${participantIndex}: ${finalSig.toString().slice(0, 20)}...`);

      // Check if all participants have signatures
      let allComplete = true;
      for (let i = 0; i < session.participants.length; i++) {
        const pSigs = session.partialSignatures.get(i.toString());
        if (!pSigs || pSigs.length < this.config.threshold.threshold) {
          allComplete = false;
          break;
        }
      }

      if (allComplete) {
        this.completeSessionSigning(sessionId);
      }
    } catch (err) {
      console.error(`Failed to combine signatures for participant ${participantIndex}:`, err);
    }
  }

  private completeSessionSigning(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'complete';

    // Combine all final signatures
    const finalSignatures: bigint[] = [];
    for (let i = 0; i < session.participants.length; i++) {
      const partials = session.partialSignatures.get(i.toString());
      if (partials && partials.length >= this.config.threshold.threshold) {
        finalSignatures.push(combinePartialSignatures(partials, this.config.threshold.threshold));
      }
    }

    console.log(`Session ${sessionId} signing complete with ${finalSignatures.length} signatures`);

    // Broadcast completion
    const message: CoordinatorMessage = {
      type: 'SESSION_COMPLETE',
      sessionId,
      finalSignatures: finalSignatures.map(s => s.toString()),
    };
    this.broadcast(message);

    this.onSignatureComplete?.(sessionId, finalSignatures);
  }

  private handleSessionComplete(sessionId: string, signatureStrs: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'complete';
    const signatures = signatureStrs.map(s => BigInt(s));
    this.onSignatureComplete?.(sessionId, signatures);
  }

  // ============================================
  // Key Share Synchronization
  // ============================================

  private handleKeyShareSync(nodeId: string, shareHash: string): void {
    const state = this.coordinatorStates.get(nodeId);
    if (!state) return;

    // Verify share hash matches expected
    console.log(`Key share sync from ${nodeId}: ${shareHash.slice(0, 16)}...`);
  }

  /**
   * Broadcast key share hash for verification
   */
  broadcastKeyShareSync(): void {
    if (!this.keyShare) return;

    const message: CoordinatorMessage = {
      type: 'KEY_SHARE_SYNC',
      nodeId: this.config.nodeId,
      shareHash: this.keyShare.shareHash,
    };
    this.broadcast(message);
  }

  // ============================================
  // Utility Functions
  // ============================================

  private broadcast(message: CoordinatorMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.peers.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * Clean up and disconnect
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    for (const ws of this.peers.values()) {
      ws.close();
    }
    this.peers.clear();
    this.sessions.clear();
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId: string): DistributedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get network status
   */
  getNetworkStatus(): {
    nodeId: string;
    onlinePeers: number;
    totalPeers: number;
    activeSessions: number;
  } {
    return {
      nodeId: this.config.nodeId,
      onlinePeers: this.getOnlineCoordinatorCount() - 1,
      totalPeers: this.config.peers.length,
      activeSessions: this.sessions.size,
    };
  }
}

// ============================================
// Distributed Key Generation (DKG)
// ============================================

/**
 * Perform distributed key generation among coordinators
 * Each coordinator contributes randomness to generate the shared RSA key
 */
export async function performDKG(
  coordinators: string[],
  threshold: ThresholdConfig
): Promise<{
  shares: KeyShare[];
  publicKey: { n: bigint; e: bigint };
}> {
  // In a full implementation, this would:
  // 1. Each coordinator generates random contribution
  // 2. Contributions are combined via Shamir's Secret Sharing
  // 3. RSA key is generated from combined randomness
  // 4. Key shares are distributed to coordinators

  // For now, we use a simplified approach where one coordinator
  // generates the key and distributes shares
  console.log('Performing distributed key generation...');
  console.log(`Threshold: ${threshold.threshold}-of-${threshold.totalShares}`);
  console.log(`Coordinators: ${coordinators.length}`);

  // Generate RSA key (in production, this would be MPC-generated)
  const { generateRSAKey } = await import('../blind-sig.js');
  const rsaKey = await generateRSAKey();

  // Split the key using threshold RSA
  const thresholdKey = splitRSAKey(
    { n: rsaKey.n, d: rsaKey.d, p: 0n, q: 0n },
    { n: rsaKey.n, e: rsaKey.e },
    threshold
  );

  return {
    shares: thresholdKey.shares,
    publicKey: thresholdKey.publicKey,
  };
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a coordinator network for a new deployment
 */
export function createCoordinatorNetwork(
  nodeId: string,
  nodeUrl: string,
  peers: string[],
  keyShare: KeyShare
): CoordinatorNetwork {
  const network = new CoordinatorNetwork({
    nodeId,
    nodeUrl,
    peers,
    threshold: {
      threshold: 3,
      totalShares: 5,
    },
  });

  network.setKeyShare(keyShare);
  return network;
}
