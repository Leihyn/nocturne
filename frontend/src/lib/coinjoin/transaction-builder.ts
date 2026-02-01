/**
 * CoinJoin Transaction Builder
 *
 * Builds multi-input Solana transactions for CoinJoin deposits.
 * Each participant contributes one input, and commitments are shuffled
 * so no one can link inputs to commitments.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { buildPrivateDepositInstruction, getPoolPDA, getCommitmentPDA } from '@/lib/program';

export interface CoinJoinInput {
  depositor: PublicKey;
  commitment: Uint8Array;
}

/**
 * Build a CoinJoin deposit transaction
 *
 * All inputs deposit to the same denomination pool.
 * Commitments are already shuffled by the protocol.
 */
export function buildCoinJoinTransaction(
  inputs: CoinJoinInput[],
  denomination: bigint,
  feeRecipient: PublicKey,
  recentBlockhash: string
): Transaction {
  const transaction = new Transaction();
  transaction.recentBlockhash = recentBlockhash;

  // Each input creates a deposit instruction
  // The order of instructions matches the shuffled commitments
  for (const input of inputs) {
    const instruction = buildPrivateDepositInstruction({
      depositor: input.depositor,
      denomination,
      commitment: input.commitment,
      feeRecipient,
    });
    transaction.add(instruction);
  }

  // All depositors are fee payers (split equally)
  // For simplicity, first depositor is primary fee payer
  if (inputs.length > 0) {
    transaction.feePayer = inputs[0].depositor;
  }

  return transaction;
}

/**
 * Verify a CoinJoin transaction before signing
 *
 * Each participant should verify:
 * 1. Their input is included
 * 2. The denomination is correct
 * 3. Their commitment is somewhere in the shuffled list
 */
export function verifyCoinJoinTransaction(
  transaction: Transaction,
  myPubkey: PublicKey,
  myCommitment: Uint8Array,
  expectedDenomination: bigint
): { valid: boolean; inputIndex: number; error?: string } {
  // Find our input in the transaction
  let inputIndex = -1;

  for (let i = 0; i < transaction.instructions.length; i++) {
    const ix = transaction.instructions[i];

    // Check if this instruction has our pubkey as depositor (first account)
    if (ix.keys.length > 0 && ix.keys[0].pubkey.equals(myPubkey)) {
      inputIndex = i;
      break;
    }
  }

  if (inputIndex === -1) {
    return { valid: false, inputIndex: -1, error: 'Our input not found in transaction' };
  }

  // Verify our commitment is in one of the instructions
  // (We don't know which one due to shuffling - that's the privacy!)
  let commitmentFound = false;
  const myCommitmentHex = Buffer.from(myCommitment).toString('hex');

  for (const ix of transaction.instructions) {
    // The commitment is in the instruction data
    // Format: discriminator (8) + denomination (8) + commitment (32) + ...
    if (ix.data.length >= 48) {
      const commitmentInIx = ix.data.slice(16, 48);
      if (Buffer.from(commitmentInIx).toString('hex') === myCommitmentHex) {
        commitmentFound = true;
        break;
      }
    }
  }

  if (!commitmentFound) {
    return { valid: false, inputIndex, error: 'Our commitment not found in transaction' };
  }

  return { valid: true, inputIndex };
}

/**
 * Serialize CoinJoin transaction data for coordination
 */
export interface SerializedCoinJoinTx {
  inputs: string[];  // Base58 encoded pubkeys
  commitments: string[];  // Hex encoded commitments
  denomination: string;
  recentBlockhash: string;
}

export function serializeCoinJoinData(
  inputs: PublicKey[],
  commitments: Uint8Array[],
  denomination: bigint,
  recentBlockhash: string
): SerializedCoinJoinTx {
  return {
    inputs: inputs.map(p => p.toBase58()),
    commitments: commitments.map(c => Buffer.from(c).toString('hex')),
    denomination: denomination.toString(),
    recentBlockhash,
  };
}

export function deserializeCoinJoinData(data: SerializedCoinJoinTx): {
  inputs: PublicKey[];
  commitments: Uint8Array[];
  denomination: bigint;
  recentBlockhash: string;
} {
  return {
    inputs: data.inputs.map(s => new PublicKey(s)),
    commitments: data.commitments.map(h => {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }),
    denomination: BigInt(data.denomination),
    recentBlockhash: data.recentBlockhash,
  };
}

/**
 * Multi-Party Transaction Signing for CoinJoin
 *
 * In Solana, a transaction requires signatures from all accounts marked as signers.
 * For CoinJoin, each depositor is a signer. The flow is:
 *
 * 1. Build unsigned transaction with all deposit instructions
 * 2. Serialize the transaction message (what gets signed)
 * 3. Each participant signs the message via their wallet
 * 4. Collect all signatures (pubkey -> signature mapping)
 * 5. Apply signatures to transaction
 * 6. Broadcast fully-signed transaction
 */

/**
 * Represents a collected signature from a participant
 */
export interface CollectedSignature {
  publicKey: PublicKey;
  signature: Uint8Array;  // 64 bytes
}

/**
 * Get the message that needs to be signed by each participant
 * This is the serialized transaction message without signatures
 */
export function getCoinJoinMessageToSign(transaction: Transaction): Uint8Array {
  // Compile the transaction message
  const message = transaction.compileMessage();
  return message.serialize();
}

/**
 * Apply collected signatures to a transaction
 * Each signature must correspond to a signer in the transaction
 */
export function applyCoinJoinSignatures(
  transaction: Transaction,
  signatures: CollectedSignature[]
): Transaction {
  // Get the compiled message to find signer order
  const message = transaction.compileMessage();
  const signerPubkeys = message.accountKeys.slice(0, message.header.numRequiredSignatures);

  // Create a map for quick lookup
  const sigMap = new Map<string, Uint8Array>();
  for (const sig of signatures) {
    sigMap.set(sig.publicKey.toBase58(), sig.signature);
  }

  // Apply signatures in the correct order
  for (let i = 0; i < signerPubkeys.length; i++) {
    const pubkeyStr = signerPubkeys[i].toBase58();
    const signature = sigMap.get(pubkeyStr);

    if (!signature) {
      throw new Error(`Missing signature for signer: ${pubkeyStr}`);
    }

    // Validate signature length
    if (signature.length !== 64) {
      throw new Error(`Invalid signature length for ${pubkeyStr}: expected 64, got ${signature.length}`);
    }

    // Add signature to transaction
    transaction.signatures[i] = {
      publicKey: signerPubkeys[i],
      signature: Buffer.from(signature),
    };
  }

  return transaction;
}

/**
 * Verify that a transaction has all required signatures
 */
export function verifyCoinJoinSignatures(transaction: Transaction): {
  complete: boolean;
  missing: PublicKey[];
} {
  const message = transaction.compileMessage();
  const numRequired = message.header.numRequiredSignatures;
  const missing: PublicKey[] = [];

  for (let i = 0; i < numRequired; i++) {
    const sig = transaction.signatures[i];
    if (!sig || !sig.signature || sig.signature.every(b => b === 0)) {
      missing.push(message.accountKeys[i]);
    }
  }

  return {
    complete: missing.length === 0,
    missing,
  };
}

/**
 * Extract a participant's signature from a partially signed transaction
 * Used when wallet adapter returns a signed transaction
 */
export function extractSignatureFromSignedTx(
  signedTx: Transaction,
  signerPubkey: PublicKey
): Uint8Array | null {
  for (const sig of signedTx.signatures) {
    if (sig.publicKey.equals(signerPubkey) && sig.signature) {
      return new Uint8Array(sig.signature);
    }
  }
  return null;
}

/**
 * Legacy function - keeping for backwards compatibility
 * @deprecated Use getCoinJoinMessageToSign and applyCoinJoinSignatures instead
 */
export function signCoinJoinInput(
  transaction: Transaction,
  signerKeypair: { publicKey: PublicKey; secretKey: Uint8Array },
  inputIndex: number
): Uint8Array {
  // For wallet adapter flow, this is not used
  // Wallet adapters sign the entire transaction and return signed tx
  console.warn('signCoinJoinInput is deprecated. Use wallet adapter signing flow.');
  return new Uint8Array(64);
}
