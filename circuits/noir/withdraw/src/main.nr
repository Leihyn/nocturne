// StealthSol Withdrawal Circuit
//
// Proves that:
// 1. The user knows the preimage of a commitment in the Merkle tree
// 2. The nullifier hash is correctly derived (prevents double-spend)
// 3. The commitment exists at the specified position in the tree
//
// Public inputs: merkle_root, nullifier_hash, recipient, amount
// Private inputs: nullifier, secret, stealth_address, merkle_path, path_indices
//
// This enables withdrawals without revealing which deposit is being spent!

use std::hash::poseidon;

// Merkle tree depth (2^10 = 1,024 notes per pool)
// Reduced from 20 to fit Solana compute budget
global MERKLE_DEPTH: u32 = 10;

// Poseidon hash for 2 inputs
fn poseidon_hash_2(left: Field, right: Field) -> Field {
    poseidon::bn254::hash_2([left, right])
}

// Poseidon hash for 4 inputs
fn poseidon_hash_4(inputs: [Field; 4]) -> Field {
    poseidon::bn254::hash_4(inputs)
}

// Compute Merkle root from leaf and path
fn compute_merkle_root(
    leaf: Field,
    path: [Field; 10],
    path_indices: [u1; 10],
) -> Field {
    let mut current = leaf;

    for i in 0..10 {
        let sibling = path[i];
        let index = path_indices[i];

        // If index is 0, current is on the left
        // If index is 1, current is on the right
        let (left, right) = if index == 0 {
            (current, sibling)
        } else {
            (sibling, current)
        };

        current = poseidon_hash_2(left, right);
    }

    current
}

// Main withdrawal circuit
fn main(
    // Public inputs (visible on-chain)
    merkle_root: pub Field,      // Current tree root
    nullifier_hash: pub Field,   // Prevents double-spend
    recipient: pub Field,        // Where to send funds (can be any address)
    amount: pub Field,           // Amount to withdraw

    // Private inputs (hidden from everyone)
    nullifier: Field,
    secret: Field,
    stealth_address: Field,      // Original recipient stealth address
    merkle_path: [Field; 10],    // Sibling hashes from leaf to root
    path_indices: [u1; 10],      // Position indicators (0=left, 1=right)
) {
    // Constraint 1: Nullifier hash is correctly computed
    // nullifier_hash = Poseidon(nullifier, 0)
    // The 0 is a domain separator to distinguish from other hashes
    let computed_nullifier_hash = poseidon_hash_2(nullifier, 0);
    assert(computed_nullifier_hash == nullifier_hash);

    // Constraint 2: Commitment was correctly formed
    let commitment = poseidon_hash_4([nullifier, secret, amount, stealth_address]);

    // Constraint 3: Commitment exists in the Merkle tree
    let computed_root = compute_merkle_root(commitment, merkle_path, path_indices);
    assert(computed_root == merkle_root);

    // Constraint 4: Amount must be positive
    let amount_u64 = amount as u64;
    assert(amount_u64 > 0);

    // Note: recipient is a public input but not constrained here
    // The smart contract will send funds to this address
    // This allows the user to withdraw to ANY address they choose
}

// Test with a simple 3-level tree for faster testing
#[test]
fn test_withdrawal_basic() {
    // Create a sample note
    let nullifier: Field = 0x1234;
    let secret: Field = 0x5678;
    let amount: Field = 1000000000;
    let stealth_address: Field = 0xabcd;

    // Compute commitment
    let commitment = poseidon_hash_4([nullifier, secret, amount, stealth_address]);

    // Compute nullifier hash
    let nullifier_hash = poseidon_hash_2(nullifier, 0);

    // Build a simple Merkle tree path (all zeros for siblings)
    let mut merkle_path: [Field; 10] = [0; 10];
    let mut path_indices: [u1; 10] = [0; 10];

    // Compute expected root
    let mut current = commitment;
    for i in 0..10 {
        current = poseidon_hash_2(current, 0);
    }
    let merkle_root = current;

    // Test recipient
    let recipient: Field = 0xdeadbeef;

    // This should pass
    main(
        merkle_root,
        nullifier_hash,
        recipient,
        amount,
        nullifier,
        secret,
        stealth_address,
        merkle_path,
        path_indices
    );
}
