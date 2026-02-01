/**
 * Merkle Tree Rebuilder
 *
 * Fetches commitment leaves from on-chain and rebuilds the merkle tree
 * to compute fresh proofs. This solves the "stale root" problem where
 * a note's merkle proof becomes invalid after many deposits.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, DENOMINATION_1_SOL, getPoolState } from './program';
import { poseidonHash2, ZERO_HASHES, MERKLE_DEPTH } from './zk-crypto';

// Commitment leaf seed (must match on-chain)
const COMMITMENT_SEED = Buffer.from('commitment');

/**
 * Commitment leaf data from on-chain
 */
export interface OnChainCommitment {
  commitment: Uint8Array;
  leafIndex: number;
  timestamp: number;
}

/**
 * Fresh merkle proof computed from rebuilt tree
 */
export interface FreshMerkleProof {
  root: bigint;
  siblings: bigint[];
  pathIndices: number[];
  leafIndex: number;
}

/**
 * Derive commitment leaf PDA
 */
function getCommitmentLeafPDA(denomination: bigint, commitment: Uint8Array): PublicKey {
  const denomBytes = Buffer.alloc(8);
  denomBytes.writeBigUInt64LE(denomination);

  const [pda] = PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, denomBytes, commitment],
    PROGRAM_ID
  );
  return pda;
}

/**
 * Fetch all commitment leaves for a denomination from on-chain
 */
export async function fetchCommitmentLeaves(
  connection: Connection,
  denomination: bigint
): Promise<OnChainCommitment[]> {
  console.log(`[MerkleRebuilder] Fetching commitment leaves for ${Number(denomination) / 1e9} SOL pool...`);

  const leaves: OnChainCommitment[] = [];

  try {
    // CommitmentLeaf account size: 8 (disc) + 32 (commitment) + 8 (leaf_index) + 8 (timestamp) + 128 (encrypted_note) + 33 (amount_commitment) + 32 (range_proof_hash) + 1 (bump) = 250
    const COMMITMENT_LEAF_SIZE = 250;

    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { dataSize: COMMITMENT_LEAF_SIZE },
      ],
    });

    console.log(`[MerkleRebuilder] Found ${accounts.length} total commitment leaf accounts`);

    // Filter by denomination - verify each account's PDA matches expected denomination
    const denomBytes = Buffer.alloc(8);
    denomBytes.writeBigUInt64LE(denomination);

    for (const { pubkey, account } of accounts) {
      const data = account.data;

      // Skip discriminator (8 bytes)
      let offset = 8;

      // Read commitment (32 bytes)
      const commitment = new Uint8Array(data.slice(offset, offset + 32));
      offset += 32;

      // Verify this leaf belongs to our denomination by checking PDA
      const expectedPDA = getCommitmentLeafPDA(denomination, commitment);
      if (!pubkey.equals(expectedPDA)) {
        // This commitment belongs to a different denomination pool
        continue;
      }

      // Read leaf_index (8 bytes, u64)
      const leafIndex = Number(data.readBigUInt64LE(offset));
      offset += 8;

      // Read timestamp (8 bytes, i64)
      const timestamp = Number(data.readBigInt64LE(offset));

      leaves.push({ commitment, leafIndex, timestamp });
    }

    // Sort by leaf index (critical for correct tree reconstruction)
    leaves.sort((a, b) => a.leafIndex - b.leafIndex);

    console.log(`[MerkleRebuilder] Found ${leaves.length} leaves for ${Number(denomination) / 1e9} SOL pool`);
    if (leaves.length > 0) {
      console.log(`[MerkleRebuilder] Leaf indices range: ${leaves[0].leafIndex} to ${leaves[leaves.length - 1].leafIndex}`);
    }

    return leaves;
  } catch (err) {
    console.error('[MerkleRebuilder] Failed to fetch commitment leaves:', err);
    return [];
  }
}

/**
 * Rebuild merkle tree from commitment leaves
 * Returns the current root and ability to compute proofs
 */
export class MerkleTreeRebuilder {
  private leaves: bigint[] = [];
  private root: bigint = ZERO_HASHES[MERKLE_DEPTH];
  private filledSubtrees: bigint[] = [...ZERO_HASHES.slice(0, MERKLE_DEPTH)];
  private onChainRoot: bigint | null = null;

  /**
   * Build tree from on-chain commitment leaves
   */
  async buildFromOnChain(connection: Connection, denomination: bigint): Promise<boolean> {
    // Fetch the actual on-chain root first
    // IMPORTANT: Merkle roots are stored LITTLE-ENDIAN on-chain (via fieldToBytes)
    const poolState = await getPoolState(connection, denomination);
    if (poolState) {
      this.onChainRoot = bytesToBigIntLE(poolState.merkleRoot);
      console.log(`[MerkleRebuilder] On-chain merkle root (LE): ${this.onChainRoot.toString(16).slice(0, 16)}...`);
    }

    const onChainLeaves = await fetchCommitmentLeaves(connection, denomination);

    if (onChainLeaves.length === 0) {
      console.log('[MerkleRebuilder] No leaves found on-chain');
      return false;
    }

    // Convert commitments to bigints and insert in order
    console.log(`[MerkleRebuilder] Rebuilding tree with ${onChainLeaves.length} leaves...`);

    for (const leaf of onChainLeaves) {
      const commitmentBigInt = bytesToBigInt(leaf.commitment);
      this.insertLeaf(commitmentBigInt);
    }

    console.log(`[MerkleRebuilder] Computed root: ${this.root.toString(16).slice(0, 16)}...`);

    // Compare with on-chain root
    if (this.onChainRoot !== null) {
      if (this.root === this.onChainRoot) {
        console.log(`[MerkleRebuilder] ✓ Computed root matches on-chain root`);
      } else {
        console.warn(`[MerkleRebuilder] ⚠️ Root mismatch!`);
        console.warn(`[MerkleRebuilder]   Computed: ${this.root.toString(16)}`);
        console.warn(`[MerkleRebuilder]   On-chain: ${this.onChainRoot.toString(16)}`);

        // Debug: Check ZERO_HASHES
        // On-chain ZERO_HASHES[1] = 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864
        const expectedZeroHash1 = BigInt('0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864');
        console.log(`[MerkleRebuilder] Debug - Our ZERO_HASHES[1]: ${ZERO_HASHES[1].toString(16)}`);
        console.log(`[MerkleRebuilder] Debug - Expected ZERO_HASHES[1]: ${expectedZeroHash1.toString(16)}`);
        console.log(`[MerkleRebuilder] Debug - ZERO_HASHES match: ${ZERO_HASHES[1] === expectedZeroHash1}`);

        // Debug: Show first few leaves
        console.log(`[MerkleRebuilder] Debug - First leaf: ${this.leaves[0]?.toString(16).slice(0, 16)}...`);
        if (this.leaves.length > 1) {
          console.log(`[MerkleRebuilder] Debug - Second leaf: ${this.leaves[1]?.toString(16).slice(0, 16)}...`);
        }
      }
    }

    return true;
  }

  /**
   * Get the on-chain root (if fetched)
   */
  getOnChainRoot(): bigint | null {
    return this.onChainRoot;
  }

  /**
   * Insert a leaf into the tree
   */
  private insertLeaf(leaf: bigint): void {
    const leafIndex = this.leaves.length;
    let currentIndex = leafIndex;
    let currentHash = leaf;

    for (let i = 0; i < MERKLE_DEPTH; i++) {
      const isLeft = currentIndex % 2 === 0;

      if (isLeft) {
        this.filledSubtrees[i] = currentHash;
        currentHash = poseidonHash2(currentHash, ZERO_HASHES[i]);
      } else {
        currentHash = poseidonHash2(this.filledSubtrees[i], currentHash);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    this.root = currentHash;
    this.leaves.push(leaf);
  }

  /**
   * Get the current merkle root
   */
  getRoot(): bigint {
    return this.root;
  }

  /**
   * Get root as bytes
   */
  getRootBytes(): Uint8Array {
    return bigIntToBytes32(this.root);
  }

  /**
   * Get number of leaves
   */
  getLeafCount(): number {
    return this.leaves.length;
  }

  /**
   * Compute a fresh merkle proof for a leaf at given index
   */
  getProof(leafIndex: number): FreshMerkleProof | null {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      console.error(`[MerkleRebuilder] Invalid leaf index: ${leafIndex}, tree has ${this.leaves.length} leaves`);
      return null;
    }

    const siblings: bigint[] = [];
    const pathIndices: number[] = [];

    // Rebuild tree up to and including target leaf to compute siblings
    const tempFilledSubtrees: bigint[] = [...ZERO_HASHES.slice(0, MERKLE_DEPTH)];

    // Insert leaves one by one, tracking siblings for target leaf
    for (let i = 0; i <= leafIndex; i++) {
      let currentIndex = i;
      let currentHash = this.leaves[i];

      for (let level = 0; level < MERKLE_DEPTH; level++) {
        const isLeft = currentIndex % 2 === 0;

        if (isLeft) {
          tempFilledSubtrees[level] = currentHash;
          currentHash = poseidonHash2(currentHash, ZERO_HASHES[level]);
        } else {
          currentHash = poseidonHash2(tempFilledSubtrees[level], currentHash);
        }

        currentIndex = Math.floor(currentIndex / 2);
      }
    }

    // Now compute the actual proof path for the target leaf
    // We need to traverse from leaf to root, collecting siblings
    let currentIndex = leafIndex;

    for (let level = 0; level < MERKLE_DEPTH; level++) {
      const isLeft = currentIndex % 2 === 0;
      pathIndices.push(isLeft ? 0 : 1);

      // Get sibling
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const sibling = this.getNodeAtLevel(level, siblingIndex);
      siblings.push(sibling);

      currentIndex = Math.floor(currentIndex / 2);
    }

    // Verify the proof
    let hash = this.leaves[leafIndex];
    for (let i = 0; i < MERKLE_DEPTH; i++) {
      if (pathIndices[i] === 0) {
        hash = poseidonHash2(hash, siblings[i]);
      } else {
        hash = poseidonHash2(siblings[i], hash);
      }
    }

    if (hash !== this.root) {
      console.error('[MerkleRebuilder] Proof verification failed!');
      console.error(`[MerkleRebuilder] Computed root: ${hash.toString(16).slice(0, 16)}...`);
      console.error(`[MerkleRebuilder] Expected root: ${this.root.toString(16).slice(0, 16)}...`);
      return null;
    }

    console.log(`[MerkleRebuilder] Fresh proof computed for leaf ${leafIndex}`);
    console.log(`[MerkleRebuilder] Root: ${this.root.toString(16).slice(0, 16)}...`);

    return {
      root: this.root,
      siblings,
      pathIndices,
      leafIndex,
    };
  }

  /**
   * Get node hash at a specific level and index
   */
  private getNodeAtLevel(level: number, index: number): bigint {
    if (level === 0) {
      // Leaf level
      if (index < this.leaves.length) {
        return this.leaves[index];
      }
      return ZERO_HASHES[0];
    }

    // For higher levels, compute from children
    const leftChildIndex = index * 2;
    const rightChildIndex = index * 2 + 1;

    const leftChild = this.getNodeAtLevel(level - 1, leftChildIndex);
    const rightChild = this.getNodeAtLevel(level - 1, rightChildIndex);

    return poseidonHash2(leftChild, rightChild);
  }

  /**
   * Find a commitment in the tree and return its proof
   */
  findCommitmentAndGetProof(commitment: Uint8Array): FreshMerkleProof | null {
    const commitmentBigInt = bytesToBigInt(commitment);

    const leafIndex = this.leaves.findIndex(leaf => leaf === commitmentBigInt);

    if (leafIndex === -1) {
      console.error('[MerkleRebuilder] Commitment not found in tree');
      return null;
    }

    console.log(`[MerkleRebuilder] Found commitment at leaf index ${leafIndex}`);
    return this.getProof(leafIndex);
  }
}

/**
 * Convert bytes to bigint (big-endian) - for commitments
 * Commitments are stored big-endian on-chain
 */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert bytes to bigint (little-endian) - for merkle roots
 * Merkle roots are stored little-endian on-chain (via fieldToBytes)
 */
function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert bigint to 32-byte array (big-endian) - for commitments
 */
function bigIntToBytes32BE(num: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = num;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(temp & 0xffn);
    temp = temp >> 8n;
  }
  return bytes;
}

// Alias for backwards compatibility
const bytesToBigInt = bytesToBigIntBE;
const bigIntToBytes32 = bigIntToBytes32BE;

/**
 * Refresh a stale merkle proof by querying on-chain state
 * Returns fresh proof that uses the current merkle root
 *
 * @deprecated Use refreshMerkleProofByCommitment instead - it finds the correct on-chain index
 */
export async function refreshMerkleProof(
  connection: Connection,
  denomination: bigint,
  leafIndex: number
): Promise<FreshMerkleProof | null> {
  const rebuilder = new MerkleTreeRebuilder();

  const success = await rebuilder.buildFromOnChain(connection, denomination);
  if (!success) {
    return null;
  }

  return rebuilder.getProof(leafIndex);
}

/**
 * Refresh merkle proof by finding the commitment's actual on-chain position
 *
 * IMPORTANT: The local tree index may not match the on-chain index!
 * This function finds the commitment by value and returns the correct proof.
 *
 * @returns Fresh proof with the CORRECT on-chain leaf index, or null if not found
 */
export async function refreshMerkleProofByCommitment(
  connection: Connection,
  denomination: bigint,
  commitment: bigint
): Promise<FreshMerkleProof | null> {
  const rebuilder = new MerkleTreeRebuilder();

  const success = await rebuilder.buildFromOnChain(connection, denomination);
  if (!success) {
    console.log('[MerkleRebuilder] Failed to build tree from on-chain data');
    return null;
  }

  // Find the commitment by value in the tree
  const commitmentBytes = bigIntToBytes32(commitment);
  const proof = rebuilder.findCommitmentAndGetProof(commitmentBytes);

  if (!proof) {
    console.error('[MerkleRebuilder] Commitment not found in on-chain tree');
    console.log('[MerkleRebuilder] Looking for commitment:', commitment.toString(16).slice(0, 16) + '...');
    console.log('[MerkleRebuilder] Tree has', rebuilder.getLeafCount(), 'leaves');
    return null;
  }

  return proof;
}

/**
 * Check if a merkle root is current (matches rebuilt tree)
 */
export async function isRootCurrent(
  connection: Connection,
  denomination: bigint,
  root: Uint8Array
): Promise<boolean> {
  const rebuilder = new MerkleTreeRebuilder();

  const success = await rebuilder.buildFromOnChain(connection, denomination);
  if (!success) {
    return false;
  }

  const currentRoot = rebuilder.getRootBytes();

  for (let i = 0; i < 32; i++) {
    if (currentRoot[i] !== root[i]) {
      return false;
    }
  }

  return true;
}
