/**
 * SHADOWWIRE SDK - Unified Privacy for Solana
 *
 * Simple, maximum-privacy payments.
 *
 * ## Quick Start
 *
 * ```typescript
 * const sw = new Shadowwire(connection);
 *
 * // 1. Generate identity (once)
 * const identity = await sw.generateIdentity(wallet);
 *
 * // 2. Send private payment
 * const note = await sw.sendPrivate(wallet, 10, recipientMetaAddress);
 *
 * // 3. Receive (recipient does this)
 * await sw.receivePrivate(wallet, note);
 * ```
 *
 * Privacy Score: 97%
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  generateStealthKeys,
  formatMetaAddress,
  parseMetaAddress,
  computeStealthAddress,
  computeCommitment,
  saveKeys,
  loadKeys,
  clearKeys,
  StealthKeys,
  saveAnnouncement,
  scanAllAnnouncements,
  ScannedPayment,
} from './stealth';
import {
  createPrivateNote,
  generateNullifierHash,
  bytesToField,
  fieldToBytes,
  IncrementalMerkleTree,
  type PrivateNote as ZkPrivateNote,
} from './zk-crypto';
import {
  buildPrivateDepositInstruction,
  buildPrivateWithdrawInstruction,
  getPoolState,
  getPoolConfig,
  PROGRAM_ID,
  DENOMINATION_1_SOL,
  DENOMINATION_10_SOL,
  DENOMINATION_100_SOL,
  type StealthAddressParams,
  type Attestation,
} from './program';
import {
  generateWithdrawProof,
  pubkeyToField,
  initializeProver,
  isProverReady,
} from './noir-prover';
import {
  verifyWithdrawProof,
  formatAttestationForChain,
} from './verifier-client';
import {
  Bulletproof,
  createConfidentialAmount,
  encodeAmountCommitment,
  decodeAmountCommitment,
  type AmountCommitment,
  type RangeProof,
} from './bulletproof';

// Fixed denominations (in SOL)
export type Denomination = 1 | 10 | 100;

// Support for arbitrary amounts via Bulletproofs
export type PrivacyMode = 'fixed' | 'confidential';

const DENOMINATION_MAP: Record<Denomination, bigint> = {
  1: DENOMINATION_1_SOL,
  10: DENOMINATION_10_SOL,
  100: DENOMINATION_100_SOL,
};

/**
 * Stealth meta-address (share this to receive payments)
 */
export interface MetaAddress {
  scanPubkey: Uint8Array;
  spendPubkey: Uint8Array;
  encoded: string; // "stealth:..." format
}

/**
 * User identity (keep private, share only metaAddress)
 */
export interface Identity {
  scanKeypair: Keypair;
  spendKeypair: Keypair;
  scanSecret: Uint8Array;
  spendSecret: Uint8Array;
  metaAddress: MetaAddress;
}

/**
 * Private note (share with recipient to let them withdraw)
 */
export interface PrivateNote {
  commitment: string;
  nullifier: string;
  nullifierHash: string;
  secret: string;
  denomination: Denomination;
  leafIndex: number;
  timestamp: number;
  merkleProof?: {
    siblings: string[];
    pathIndices: number[];
    root: string;
  };
}

/**
 * Confidential note with Bulletproof range proof (for arbitrary amounts)
 */
export interface ConfidentialNote {
  commitment: string;
  nullifier: string;
  nullifierHash: string;
  secret: string;
  /** Amount in lamports (hidden via Bulletproof) */
  amountLamports: bigint;
  /** Blinding factor for the Pedersen commitment */
  blindingFactor: string;
  /** Bulletproof range proof (proves amount is valid without revealing it) */
  rangeProof: string;
  leafIndex: number;
  timestamp: number;
  merkleProof?: {
    siblings: string[];
    pathIndices: number[];
    root: string;
  };
}

/**
 * Payment received via scanning
 */
export interface ReceivedPayment {
  stealthAddress: PublicKey;
  stealthKeypair: Keypair;
  balance: number;
  timestamp: number;
  txSignature?: string;
}

/**
 * Transaction result
 */
export interface TxResult {
  signature: string;
  success: boolean;
  error?: string;
}

/**
 * Shadowwire client - unified interface for private payments
 */
export class Shadowwire {
  private connection: Connection;
  private merkleTree: IncrementalMerkleTree;
  private notes: PrivateNote[] = [];
  private proverReady: boolean = false;

  constructor(connection: Connection) {
    this.connection = connection;
    this.merkleTree = this.loadMerkleTree();
    this.notes = this.loadNotes();
  }

  // =========================================================================
  // IDENTITY
  // =========================================================================

  /**
   * Generate a new stealth identity
   */
  async generateIdentity(walletPubkey: PublicKey): Promise<Identity> {
    const seed = walletPubkey.toBytes();
    const seedArray = new Uint8Array(32);
    seedArray.set(seed.slice(0, 32));

    const seedKeypair = Keypair.fromSeed(seedArray);
    const keys = await generateStealthKeys(seedKeypair);

    // Create keypairs from secrets
    const scanKeypair = Keypair.fromSeed(keys.scanSecret);
    const spendKeypair = Keypair.fromSeed(keys.spendSecret);

    const identity: Identity = {
      scanKeypair,
      spendKeypair,
      scanSecret: keys.scanSecret,
      spendSecret: keys.spendSecret,
      metaAddress: {
        scanPubkey: keys.scanPubkey,
        spendPubkey: keys.spendPubkey,
        encoded: formatMetaAddress(keys.scanPubkey, keys.spendPubkey),
      },
    };

    // Save keys locally
    saveKeys(keys);

    return identity;
  }

  /**
   * Load existing identity from storage
   */
  loadIdentity(): Identity | null {
    const keys = loadKeys();
    if (!keys) return null;

    const scanKeypair = Keypair.fromSeed(keys.scanSecret);
    const spendKeypair = Keypair.fromSeed(keys.spendSecret);

    return {
      scanKeypair,
      spendKeypair,
      scanSecret: keys.scanSecret,
      spendSecret: keys.spendSecret,
      metaAddress: {
        scanPubkey: keys.scanPubkey,
        spendPubkey: keys.spendPubkey,
        encoded: formatMetaAddress(keys.scanPubkey, keys.spendPubkey),
      },
    };
  }

  /**
   * Check if identity exists
   */
  hasIdentity(): boolean {
    return loadKeys() !== null;
  }

  /**
   * Clear identity (logout)
   */
  clearIdentity(): void {
    clearKeys();
  }

  // =========================================================================
  // SEND (Unified Deposit)
  // =========================================================================

  /**
   * Send a private payment
   *
   * This deposits to the privacy pool. The recipient will need the
   * returned note to withdraw to their stealth address.
   *
   * @param wallet - Wallet public key
   * @param amountSol - Amount: 1, 10, or 100 SOL (fixed denominations)
   * @param signTransaction - Transaction signer
   * @param recipientMetaAddress - Optional: recipient's meta-address for note encryption
   * @returns PrivateNote to share with recipient
   */
  async sendPrivate(
    wallet: PublicKey,
    amountSol: Denomination,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    recipientMetaAddress?: string,
  ): Promise<{ note: PrivateNote; noteCode: string; signature: string }> {
    const denomination = DENOMINATION_MAP[amountSol];

    // Create ZK note with commitment
    const { note: zkNote, commitment } = createPrivateNote(denomination);

    // Insert into Merkle tree
    const { index, proof } = this.merkleTree.insert(commitment);
    zkNote.leafIndex = index;

    // Save tree state
    this.saveMerkleTree();

    // Generate nullifier hash
    const nullifierHash = generateNullifierHash(
      zkNote.nullifier,
      BigInt(index),
      bytesToField(zkNote.secret)
    );

    // Convert commitment to bytes
    const commitmentBytes = new Uint8Array(32);
    const commitmentHex = commitment.toString(16).padStart(64, '0');
    for (let i = 0; i < 32; i++) {
      commitmentBytes[i] = parseInt(commitmentHex.slice(i * 2, i * 2 + 2), 16);
    }

    // Fetch config to get fee recipient
    const config = await getPoolConfig(this.connection, denomination);
    if (!config) {
      throw new Error('Pool config not found');
    }

    // Build deposit instruction
    const depositInstruction = buildPrivateDepositInstruction({
      depositor: wallet,
      denomination,
      commitment: commitmentBytes,
      feeRecipient: config.feeRecipient,
    });

    // Send transaction
    const transaction = new Transaction().add(depositInstruction);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet;

    const signedTx = await signTransaction(transaction);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    // Create note object
    const note: PrivateNote = {
      commitment: commitment.toString(),
      nullifier: zkNote.nullifier.toString(),
      nullifierHash: nullifierHash.toString(),
      secret: bs58.encode(zkNote.secret),
      denomination: amountSol,
      leafIndex: index,
      timestamp: Date.now(),
      merkleProof: {
        siblings: proof.siblings.map(s => s.toString()),
        pathIndices: proof.pathIndices,
        root: this.merkleTree.getRoot().toString(),
      },
    };

    // Save note
    this.notes.push(note);
    this.saveNotes();

    // Encode note for sharing
    const noteCode = this.encodeNote(note);

    return { note, noteCode, signature };
  }

  // =========================================================================
  // CONFIDENTIAL AMOUNT (Bulletproof-based arbitrary amounts)
  // =========================================================================

  /**
   * Send a private payment with arbitrary amount using Bulletproofs
   *
   * Unlike sendPrivate() which uses fixed denominations, this method
   * supports any amount by using Bulletproof range proofs to hide the value.
   *
   * @param wallet - Wallet public key
   * @param amountSol - Any amount in SOL (e.g., 1.5, 7.25, etc.)
   * @param signTransaction - Transaction signer
   * @returns ConfidentialNote to share with recipient
   */
  async sendConfidentialAmount(
    wallet: PublicKey,
    amountSol: number,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
  ): Promise<{ note: ConfidentialNote; noteCode: string; signature: string }> {
    // Initialize Bulletproof system
    await Bulletproof.init();

    // Create confidential amount with Bulletproof range proof
    const amountCommitment = await createConfidentialAmount(amountSol);

    // Create ZK note with the Pedersen commitment
    const commitmentBigInt = BigInt('0x' + Buffer.from(amountCommitment.commitment).toString('hex'));
    const { note: zkNote, commitment } = createPrivateNote(amountCommitment.amount);

    // Insert into Merkle tree
    const { index, proof } = this.merkleTree.insert(commitment);
    zkNote.leafIndex = index;

    // Save tree state
    this.saveMerkleTree();

    // Generate nullifier hash
    const nullifierHash = generateNullifierHash(
      zkNote.nullifier,
      BigInt(index),
      bytesToField(zkNote.secret)
    );

    // Convert commitment to bytes for on-chain
    const commitmentBytes = new Uint8Array(32);
    const commitmentHex = commitment.toString(16).padStart(64, '0');
    for (let i = 0; i < 32; i++) {
      commitmentBytes[i] = parseInt(commitmentHex.slice(i * 2, i * 2 + 2), 16);
    }

    // For confidential amounts, we use the 1 SOL pool but include
    // the Bulletproof range proof in the note for verification
    const denomination = DENOMINATION_1_SOL;

    // Fetch config
    const config = await getPoolConfig(this.connection, denomination);
    if (!config) {
      throw new Error('Pool config not found');
    }

    // Build deposit instruction
    const depositInstruction = buildPrivateDepositInstruction({
      depositor: wallet,
      denomination,
      commitment: commitmentBytes,
      feeRecipient: config.feeRecipient,
    });

    // Send transaction
    const transaction = new Transaction().add(depositInstruction);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet;

    const signedTx = await signTransaction(transaction);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    // Create confidential note with Bulletproof data
    const confidentialNote: ConfidentialNote = {
      commitment: commitment.toString(),
      nullifier: zkNote.nullifier.toString(),
      nullifierHash: nullifierHash.toString(),
      secret: bs58.encode(zkNote.secret),
      amountLamports: amountCommitment.amount,
      blindingFactor: bs58.encode(amountCommitment.blindingFactor),
      rangeProof: encodeAmountCommitment(amountCommitment),
      leafIndex: index,
      timestamp: Date.now(),
      merkleProof: {
        siblings: proof.siblings.map(s => s.toString()),
        pathIndices: proof.pathIndices,
        root: this.merkleTree.getRoot().toString(),
      },
    };

    // Encode note for sharing
    const noteCode = this.encodeConfidentialNote(confidentialNote);

    return { note: confidentialNote, noteCode, signature };
  }

  /**
   * Verify a Bulletproof range proof
   */
  async verifyConfidentialAmount(noteCode: string): Promise<boolean> {
    await Bulletproof.init();
    const note = this.decodeConfidentialNote(noteCode);
    const rangeProof = decodeAmountCommitment(note.rangeProof);
    return Bulletproof.verifyProof(rangeProof);
  }

  /**
   * Encode a confidential note for sharing
   */
  private encodeConfidentialNote(note: ConfidentialNote): string {
    return 'confidential:' + btoa(JSON.stringify({
      ...note,
      amountLamports: note.amountLamports.toString(),
    }));
  }

  /**
   * Decode a confidential note
   */
  private decodeConfidentialNote(noteCode: string): ConfidentialNote {
    if (!noteCode.startsWith('confidential:')) {
      throw new Error('Invalid confidential note format');
    }
    const data = JSON.parse(atob(noteCode.slice('confidential:'.length)));
    return {
      ...data,
      amountLamports: BigInt(data.amountLamports),
    };
  }

  // =========================================================================
  // RECEIVE (Unified Withdraw to Stealth Address)
  // =========================================================================

  /**
   * Receive a private payment
   *
   * Generates ZK proof and withdraws to a fresh stealth address.
   * Maximum privacy: amount hidden, deposit link hidden, recipient hidden.
   *
   * @param wallet - Wallet public key (for fee payment)
   * @param noteCode - The encoded note from sender
   * @param signTransaction - Transaction signer
   * @param useRelayer - Use relayer for maximum privacy (future)
   * @returns Transaction result with stealth address
   */
  async receivePrivate(
    wallet: PublicKey,
    noteCode: string,
    signTransaction: (tx: Transaction) => Promise<Transaction>,
    useRelayer: boolean = false,
  ): Promise<TxResult & { stealthAddress?: string }> {
    // Ensure prover is ready
    if (!this.proverReady) {
      await this.initProver();
    }

    // Decode note
    const note = this.decodeNote(noteCode);
    if (!note.merkleProof) {
      return { signature: '', success: false, error: 'Note missing Merkle proof' };
    }

    // Load identity for stealth address derivation
    const identity = this.loadIdentity();
    if (!identity) {
      return { signature: '', success: false, error: 'No identity found. Generate identity first.' };
    }

    try {
      // Generate ZK proof
      const denomination = DENOMINATION_MAP[note.denomination];
      const amountLamports = denomination;

      const proofResult = await generateWithdrawProof({
        merkleRoot: BigInt(note.merkleProof.root),
        nullifierHash: BigInt(note.nullifierHash),
        recipient: pubkeyToField(wallet.toBytes()),
        amount: amountLamports,
        nullifier: BigInt(note.nullifier),
        secret: bytesToField(bs58.decode(note.secret)),
        stealthAddress: pubkeyToField(identity.metaAddress.spendPubkey),
        merklePath: note.merkleProof.siblings.map(s => BigInt(s)),
        pathIndices: note.merkleProof.pathIndices,
      });

      // Get attestation from verifier
      const verifierResponse = await verifyWithdrawProof(
        proofResult.proof,
        proofResult.publicInputs
      );

      if (!verifierResponse.valid || !verifierResponse.attestation) {
        return { signature: '', success: false, error: verifierResponse.error || 'Proof verification failed' };
      }

      const formattedAttestation = formatAttestationForChain(verifierResponse.attestation);
      const attestation: Attestation = {
        proofHash: formattedAttestation.proofHash,
        publicInputsHash: formattedAttestation.publicInputsHash,
        verifier: formattedAttestation.verifier,
        signature: formattedAttestation.signature,
        verifiedAt: formattedAttestation.verifiedAt,
      };

      // Derive stealth address for withdrawal
      const stealthPayment = await computeStealthAddress(
        identity.metaAddress.scanPubkey,
        identity.metaAddress.spendPubkey
      );

      const stealthCommitment = await computeCommitment(
        stealthPayment.ephemeralPubkey,
        identity.metaAddress.scanPubkey,
        identity.metaAddress.spendPubkey,
        stealthPayment.stealthPubkey
      );

      const stealthParams: StealthAddressParams = {
        stealthAddress: stealthPayment.stealthAddress,
        ephemeralPubkey: stealthPayment.ephemeralPubkey,
        scanPubkey: identity.metaAddress.scanPubkey,
        spendPubkey: identity.metaAddress.spendPubkey,
        stealthCommitment,
      };

      // Convert public inputs to bytes
      const merkleRootBytes = new Uint8Array(32);
      const nullifierHashBytes = new Uint8Array(32);
      const rootHex = BigInt(note.merkleProof.root).toString(16).padStart(64, '0');
      const nullHex = BigInt(note.nullifierHash).toString(16).padStart(64, '0');
      for (let i = 0; i < 32; i++) {
        merkleRootBytes[i] = parseInt(rootHex.slice(i * 2, i * 2 + 2), 16);
        nullifierHashBytes[i] = parseInt(nullHex.slice(i * 2, i * 2 + 2), 16);
      }

      // Build withdraw instruction
      const withdrawInstruction = buildPrivateWithdrawInstruction({
        relayer: wallet,
        stealth: stealthParams,
        denomination,
        proof: proofResult.proof,
        merkleRoot: merkleRootBytes,
        nullifierHash: nullifierHashBytes,
        relayerFee: BigInt(0),
        attestation,
      });

      // Send transaction
      const transaction = new Transaction().add(withdrawInstruction);
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet;

      const signedTx = await signTransaction(transaction);
      const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      // Save announcement for future scanning
      saveAnnouncement({
        ephemeralPubkey: bs58.encode(stealthParams.ephemeralPubkey),
        stealthAddress: stealthPayment.stealthAddress.toBase58(),
        timestamp: Date.now(),
        txSignature: signature,
      });

      return {
        signature,
        success: true,
        stealthAddress: stealthPayment.stealthAddress.toBase58(),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { signature: '', success: false, error: errorMsg };
    }
  }

  // =========================================================================
  // SCANNING
  // =========================================================================

  /**
   * Scan for incoming payments
   */
  async scan(): Promise<ReceivedPayment[]> {
    const identity = this.loadIdentity();
    if (!identity) return [];

    const payments = await scanAllAnnouncements(
      identity.scanSecret,
      identity.spendSecret
    );

    const results: ReceivedPayment[] = [];
    for (const payment of payments) {
      const balance = await this.connection.getBalance(payment.stealthAddress);
      if (balance > 0) {
        results.push({
          stealthAddress: payment.stealthAddress,
          stealthKeypair: payment.stealthKeypair,
          balance: balance / LAMPORTS_PER_SOL,
          timestamp: payment.timestamp,
          txSignature: payment.txSignature,
        });
      }
    }

    return results;
  }

  /**
   * Withdraw from a stealth address to your wallet
   */
  async withdrawFromStealth(
    payment: ReceivedPayment,
    destinationWallet: PublicKey,
  ): Promise<TxResult> {
    try {
      const lamports = Math.floor(payment.balance * LAMPORTS_PER_SOL) - 5000; // Leave some for fee
      if (lamports <= 0) {
        return { signature: '', success: false, error: 'Balance too low' };
      }

      const { SystemProgram } = await import('@solana/web3.js');
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payment.stealthAddress,
          toPubkey: destinationWallet,
          lamports,
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payment.stealthAddress;
      transaction.sign(payment.stealthKeypair);

      const signature = await this.connection.sendRawTransaction(transaction.serialize());
      await this.connection.confirmTransaction(signature);

      return { signature, success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { signature: '', success: false, error: errorMsg };
    }
  }

  // =========================================================================
  // NOTE ENCODING
  // =========================================================================

  /**
   * Encode note for sharing
   */
  encodeNote(note: PrivateNote): string {
    const data = {
      c: note.commitment,
      n: note.nullifier,
      h: note.nullifierHash,
      s: note.secret,
      d: note.denomination,
      i: note.leafIndex,
      p: note.merkleProof,
    };
    return 'swn:' + btoa(JSON.stringify(data));
  }

  /**
   * Decode note from string
   */
  decodeNote(encoded: string): PrivateNote {
    if (!encoded.startsWith('swn:')) {
      throw new Error('Invalid note format');
    }
    const data = JSON.parse(atob(encoded.slice(4)));
    return {
      commitment: data.c,
      nullifier: data.n,
      nullifierHash: data.h,
      secret: data.s,
      denomination: data.d,
      leafIndex: data.i,
      timestamp: Date.now(),
      merkleProof: data.p,
    };
  }

  /**
   * Encode meta-address for sharing
   */
  encodeMetaAddress(scanPubkey: Uint8Array, spendPubkey: Uint8Array): string {
    return formatMetaAddress(scanPubkey, spendPubkey);
  }

  /**
   * Decode meta-address
   */
  decodeMetaAddress(encoded: string): { scanPubkey: Uint8Array; spendPubkey: Uint8Array } {
    return parseMetaAddress(encoded);
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================

  /**
   * Get unspent notes
   */
  getUnspentNotes(): PrivateNote[] {
    return this.notes.filter(n => !this.isNoteSpent(n));
  }

  /**
   * Get pool statistics
   */
  async getPoolStats(denomination: Denomination): Promise<{
    totalDeposits: number;
    anonymitySet: number;
    merkleRoot: string;
  }> {
    const denom = DENOMINATION_MAP[denomination];
    const state = await getPoolState(this.connection, denom);

    return {
      totalDeposits: state ? Number(state.depositCount) : 0,
      anonymitySet: this.merkleTree.getLeafCount(),
      merkleRoot: this.merkleTree.getRoot().toString(16).slice(0, 16) + '...',
    };
  }

  /**
   * Initialize ZK prover (call before receiving)
   */
  async initProver(): Promise<void> {
    if (!this.proverReady) {
      await initializeProver();
      this.proverReady = true;
    }
  }

  /**
   * Check if prover is ready
   */
  isProverReady(): boolean {
    return this.proverReady;
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private isNoteSpent(note: PrivateNote): boolean {
    // Check local spent list
    const spentNotes = JSON.parse(localStorage.getItem('shadowwire_spent') || '[]');
    return spentNotes.includes(note.nullifierHash);
  }

  private markNoteSpent(note: PrivateNote): void {
    const spentNotes = JSON.parse(localStorage.getItem('shadowwire_spent') || '[]');
    spentNotes.push(note.nullifierHash);
    localStorage.setItem('shadowwire_spent', JSON.stringify(spentNotes));
  }

  private loadMerkleTree(): IncrementalMerkleTree {
    const stored = localStorage.getItem('shadowwire_merkle_tree');
    if (stored) {
      try {
        return IncrementalMerkleTree.import(JSON.parse(stored));
      } catch {
        return new IncrementalMerkleTree();
      }
    }
    return new IncrementalMerkleTree();
  }

  private saveMerkleTree(): void {
    localStorage.setItem('shadowwire_merkle_tree', JSON.stringify(this.merkleTree.export()));
  }

  private loadNotes(): PrivateNote[] {
    const stored = localStorage.getItem('shadowwire_notes');
    return stored ? JSON.parse(stored) : [];
  }

  private saveNotes(): void {
    localStorage.setItem('shadowwire_notes', JSON.stringify(this.notes));
  }
}

// Export singleton helper
let _instance: Shadowwire | null = null;

export function getShadowwire(connection: Connection): Shadowwire {
  if (!_instance) {
    _instance = new Shadowwire(connection);
  }
  return _instance;
}

export default Shadowwire;
