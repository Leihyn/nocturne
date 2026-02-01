pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

/**
 * StealthSol Withdrawal Circuit
 *
 * Proves knowledge of a valid deposit without revealing which one.
 *
 * Public Inputs:
 *   - merkleRoot: Current root of the commitment Merkle tree
 *   - nullifierHash: Hash of nullifier (prevents double-spend)
 *   - recipient: Address receiving the withdrawal
 *   - amount: Amount being withdrawn (must match deposit)
 *
 * Private Inputs:
 *   - nullifier: Secret nullifier chosen at deposit time
 *   - secret: Secret value chosen at deposit time
 *   - pathElements: Merkle proof siblings
 *   - pathIndices: Merkle proof path (0 = left, 1 = right)
 */

/**
 * Compute Poseidon hash of commitment
 * commitment = Poseidon(nullifier, secret, amount, recipient)
 */
template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal input amount;
    signal input recipient;
    signal output commitment;
    signal output nullifierHash;

    // Compute commitment
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== amount;
    commitmentHasher.inputs[3] <== recipient;
    commitment <== commitmentHasher.out;

    // Compute nullifier hash (public, used to prevent double-spend)
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash <== nullifierHasher.out;
}

/**
 * Verify a Merkle proof
 * Proves that a leaf exists in a Merkle tree with given root
 */
template MerkleTreeVerifier(depth) {
    signal input leaf;
    signal input root;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Compute root from leaf and path
    component hashers[depth];

    signal computedPath[depth + 1];
    signal left[depth];
    signal right[depth];

    computedPath[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // Ensure pathIndices are binary (0 or 1)
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // Select left/right based on path index
        // If pathIndices[i] == 0: hash(computedPath[i], pathElements[i])
        // If pathIndices[i] == 1: hash(pathElements[i], computedPath[i])

        hashers[i] = Poseidon(2);

        // left = pathIndices[i] == 0 ? computedPath[i] : pathElements[i]
        // right = pathIndices[i] == 0 ? pathElements[i] : computedPath[i]
        left[i] <== computedPath[i] + pathIndices[i] * (pathElements[i] - computedPath[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (computedPath[i] - pathElements[i]);

        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        computedPath[i + 1] <== hashers[i].out;
    }

    // Verify computed root matches expected root
    root === computedPath[depth];
}

/**
 * Main withdrawal circuit
 */
template Withdraw(merkleDepth) {
    // Public inputs
    signal input merkleRoot;
    signal input nullifierHash;
    signal input recipient;
    signal input amount;

    // Private inputs
    signal input nullifier;
    signal input secret;
    signal input pathElements[merkleDepth];
    signal input pathIndices[merkleDepth];

    // 1. Compute commitment and nullifier hash
    component hasher = CommitmentHasher();
    hasher.nullifier <== nullifier;
    hasher.secret <== secret;
    hasher.amount <== amount;
    hasher.recipient <== recipient;

    // 2. Verify nullifier hash matches public input
    nullifierHash === hasher.nullifierHash;

    // 3. Verify Merkle proof
    component merkleVerifier = MerkleTreeVerifier(merkleDepth);
    merkleVerifier.leaf <== hasher.commitment;
    merkleVerifier.root <== merkleRoot;
    for (var i = 0; i < merkleDepth; i++) {
        merkleVerifier.pathElements[i] <== pathElements[i];
        merkleVerifier.pathIndices[i] <== pathIndices[i];
    }

    // 4. Verify amount is positive (prevent zero-value exploits)
    component amountCheck = IsZero();
    amountCheck.in <== amount;
    amountCheck.out === 0;  // amount != 0
}

// Instantiate main circuit with depth 8 (256 deposits per pool, fits Solana compute budget)
component main {public [merkleRoot, nullifierHash, recipient, amount]} = Withdraw(8);
