/**
 * Native Stealth Transfers
 *
 * Uses System Program + Memo to make stealth transfers look like regular transfers.
 * No StealthSol program fingerprint visible on-chain.
 *
 * Transaction appears as:
 * - SystemProgram.transfer (like any SOL transfer)
 * - MemoProgram.memo (like any memo/note)
 *
 * Observer cannot distinguish from millions of daily normal transfers.
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    TransactionInstruction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import * as ed from '@noble/ed25519';

// Memo Program ID (official Solana Memo Program)
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Domain separator for commitments
const COMMITMENT_DOMAIN = 'stealthsol_native_v1';

/**
 * Announcement data structure (64 bytes)
 * Packed into memo field
 */
export interface NativeAnnouncement {
    ephemeralPubkey: Uint8Array;  // 32 bytes
    commitment: Uint8Array;        // 32 bytes
}

/**
 * Encode announcement for memo
 */
export function encodeAnnouncement(announcement: NativeAnnouncement): Buffer {
    return Buffer.concat([
        Buffer.from(announcement.ephemeralPubkey),
        Buffer.from(announcement.commitment),
    ]);
}

/**
 * Decode announcement from memo
 */
export function decodeAnnouncement(memoData: Buffer): NativeAnnouncement {
    if (memoData.length !== 64) {
        throw new Error(`Invalid memo length: ${memoData.length}, expected 64`);
    }
    return {
        ephemeralPubkey: new Uint8Array(memoData.slice(0, 32)),
        commitment: new Uint8Array(memoData.slice(32, 64)),
    };
}

/**
 * Compute commitment hash
 * commitment = SHA256(domain || ephemeral || scan || spend || stealth)
 */
export function computeCommitment(
    ephemeralPubkey: Uint8Array,
    scanPubkey: Uint8Array,
    spendPubkey: Uint8Array,
    stealthAddress: Uint8Array,
): Uint8Array {
    const data = Buffer.concat([
        Buffer.from(COMMITMENT_DOMAIN),
        Buffer.from(ephemeralPubkey),
        Buffer.from(scanPubkey),
        Buffer.from(spendPubkey),
        Buffer.from(stealthAddress),
    ]);
    return sha256(data);
}

/**
 * Derive stealth address using DKSAP
 *
 * @param scanPubkey - Recipient's scan public key
 * @param spendPubkey - Recipient's spend public key
 * @returns { stealthAddress, ephemeralKeypair, sharedSecret }
 */
export async function deriveStealthAddress(
    scanPubkey: Uint8Array,
    spendPubkey: Uint8Array,
): Promise<{
    stealthAddress: PublicKey;
    ephemeralKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };
    sharedSecret: Uint8Array;
}> {
    // Generate ephemeral keypair
    const ephemeralPrivate = ed.utils.randomPrivateKey();
    const ephemeralPublic = await ed.getPublicKey(ephemeralPrivate);

    // Compute shared secret: ECDH(ephemeral_private, scan_public)
    const sharedSecret = await ed.getSharedSecret(ephemeralPrivate, scanPubkey);

    // Derive stealth public key: spend_public + H(shared_secret) * G
    const hashInput = Buffer.concat([
        Buffer.from('stealthsol_derive_v1'),
        Buffer.from(sharedSecret),
    ]);
    const scalar = sha256(hashInput);

    // Add to spend pubkey (simplified - actual impl needs proper curve math)
    // For demo, we hash to get deterministic address
    const stealthBytes = sha256(Buffer.concat([
        Buffer.from(spendPubkey),
        scalar,
    ]));

    return {
        stealthAddress: new PublicKey(stealthBytes),
        ephemeralKeypair: {
            publicKey: ephemeralPublic,
            privateKey: ephemeralPrivate,
        },
        sharedSecret,
    };
}

/**
 * Send SOL to a stealth address using native System Program + Memo
 *
 * Transaction fingerprint:
 * - Program 1: SystemProgram (11111111111111111111111111111111)
 * - Program 2: Memo (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)
 *
 * Looks like any normal transfer with a note!
 */
export async function nativeStealthSend(
    connection: Connection,
    sender: Keypair,
    scanPubkey: Uint8Array,
    spendPubkey: Uint8Array,
    amountLamports: number,
): Promise<{
    signature: string;
    stealthAddress: PublicKey;
    ephemeralPubkey: Uint8Array;
}> {
    // 1. Derive stealth address
    const { stealthAddress, ephemeralKeypair } = await deriveStealthAddress(
        scanPubkey,
        spendPubkey,
    );

    // 2. Compute commitment
    const commitment = computeCommitment(
        ephemeralKeypair.publicKey,
        scanPubkey,
        spendPubkey,
        stealthAddress.toBytes(),
    );

    // 3. Create announcement
    const announcement: NativeAnnouncement = {
        ephemeralPubkey: ephemeralKeypair.publicKey,
        commitment,
    };
    const memoData = encodeAnnouncement(announcement);

    // 4. Build transaction (System Transfer + Memo)
    const tx = new Transaction().add(
        // Regular SOL transfer - looks like any transfer
        SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: stealthAddress,
            lamports: amountLamports,
        }),
        // Memo with announcement - looks like any memo
        new TransactionInstruction({
            keys: [],
            programId: MEMO_PROGRAM_ID,
            data: memoData,
        }),
    );

    // 5. Send transaction
    const signature = await sendAndConfirmTransaction(connection, tx, [sender]);

    return {
        signature,
        stealthAddress,
        ephemeralPubkey: ephemeralKeypair.publicKey,
    };
}

/**
 * Scan for stealth payments in native transactions
 *
 * Looks for transactions with:
 * - SystemProgram.transfer
 * - Memo with 64-byte announcement
 */
export async function scanNativePayments(
    connection: Connection,
    scanPrivateKey: Uint8Array,
    spendPubkey: Uint8Array,
    signatures: string[],
): Promise<Array<{
    signature: string;
    stealthAddress: PublicKey;
    amount: number;
    ephemeralPubkey: Uint8Array;
}>> {
    const payments: Array<{
        signature: string;
        stealthAddress: PublicKey;
        amount: number;
        ephemeralPubkey: Uint8Array;
    }> = [];

    const scanPubkey = await ed.getPublicKey(scanPrivateKey);

    for (const sig of signatures) {
        try {
            const tx = await connection.getTransaction(sig, {
                maxSupportedTransactionVersion: 0,
            });

            if (!tx?.meta || !tx.transaction.message) continue;

            // Look for Memo instruction with 64 bytes
            const message = tx.transaction.message;
            // @ts-ignore - accessing compiled instructions
            const instructions = message.compiledInstructions || [];

            for (const ix of instructions) {
                // @ts-ignore
                const programId = message.staticAccountKeys[ix.programIdIndex];
                if (programId?.equals(MEMO_PROGRAM_ID) && ix.data?.length === 64) {
                    const memoData = Buffer.from(ix.data);
                    const announcement = decodeAnnouncement(memoData);

                    // Try to derive stealth address
                    const sharedSecret = await ed.getSharedSecret(
                        scanPrivateKey,
                        announcement.ephemeralPubkey,
                    );

                    const hashInput = Buffer.concat([
                        Buffer.from('stealthsol_derive_v1'),
                        Buffer.from(sharedSecret),
                    ]);
                    const scalar = sha256(hashInput);
                    const expectedStealth = sha256(Buffer.concat([
                        Buffer.from(spendPubkey),
                        scalar,
                    ]));

                    // Check commitment
                    const expectedCommitment = computeCommitment(
                        announcement.ephemeralPubkey,
                        scanPubkey,
                        spendPubkey,
                        expectedStealth,
                    );

                    if (Buffer.from(announcement.commitment).equals(Buffer.from(expectedCommitment))) {
                        // Found a payment!
                        const stealthAddress = new PublicKey(expectedStealth);

                        // Get amount from balance change
                        const postBalances = tx.meta.postBalances;
                        const preBalances = tx.meta.preBalances;
                        // @ts-ignore
                        const accountIndex = message.staticAccountKeys.findIndex(
                            (key: PublicKey) => key.equals(stealthAddress)
                        );
                        const amount = accountIndex >= 0
                            ? postBalances[accountIndex] - preBalances[accountIndex]
                            : 0;

                        payments.push({
                            signature: sig,
                            stealthAddress,
                            amount,
                            ephemeralPubkey: announcement.ephemeralPubkey,
                        });
                    }
                }
            }
        } catch (e) {
            // Skip failed transactions
            continue;
        }
    }

    return payments;
}

/**
 * Example usage
 */
export async function example() {
    const connection = new Connection('https://api.devnet.solana.com');
    const sender = Keypair.generate();

    // Recipient's meta-address (normally fetched from registry)
    const scanPubkey = new Uint8Array(32); // Replace with real
    const spendPubkey = new Uint8Array(32); // Replace with real

    // Send 0.1 SOL privately
    const result = await nativeStealthSend(
        connection,
        sender,
        scanPubkey,
        spendPubkey,
        0.1 * LAMPORTS_PER_SOL,
    );

    console.log('Stealth payment sent!');
    console.log('Signature:', result.signature);
    console.log('Stealth address:', result.stealthAddress.toBase58());

    // Transaction looks like:
    // Program: System Program (transfer)
    // Program: Memo Program (note)
    //
    // NO StealthSol program visible!
}
