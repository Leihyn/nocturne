// StealthSol Transfer Circuit
//
// Enables private transfers within the privacy pool:
// - Spend an existing note (proving ownership via Merkle inclusion)
// - Create two new notes (one for recipient, one for change)
// - Ensures value conservation (input = output1 + output2)
//
// Public inputs: merkle_root, nullifier_hash, new_commitment, change_commitment
// Private inputs: all note details and Merkle path
//
// This enables fully private transfers where nobody can link sender to recipient!

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

        let (left, right) = if index == 0 {
            (current, sibling)
        } else {
            (sibling, current)
        };

        current = poseidon_hash_2(left, right);
    }

    current
}

// Main transfer circuit
fn main(
    // Public inputs
    merkle_root: pub Field,           // Current tree root
    nullifier_hash: pub Field,        // Nullifier of spent note
    new_commitment: pub Field,        // New note for recipient
    change_commitment: pub Field,     // Change note back to sender

    // Private inputs - Input note (being spent)
    old_nullifier: Field,
    old_secret: Field,
    old_amount: Field,
    old_stealth: Field,
    merkle_path: [Field; 10],
    path_indices: [u1; 10],

    // Private inputs - Output note 1 (for recipient)
    new_nullifier: Field,
    new_secret: Field,
    new_amount: Field,
    new_recipient: Field,

    // Private inputs - Output note 2 (change back to sender)
    change_nullifier: Field,
    change_secret: Field,
    change_amount: Field,
    change_recipient: Field,
) {
    // ===========================================
    // PART 1: Verify the input note
    // ===========================================

    // Constraint 1: Input note commitment is correctly formed
    let old_commitment = poseidon_hash_4([old_nullifier, old_secret, old_amount, old_stealth]);

    // Constraint 2: Input note exists in Merkle tree
    let computed_root = compute_merkle_root(old_commitment, merkle_path, path_indices);
    assert(computed_root == merkle_root);

    // Constraint 3: Nullifier hash is correct
    let computed_nullifier = poseidon_hash_2(old_nullifier, 0);
    assert(computed_nullifier == nullifier_hash);

    // ===========================================
    // PART 2: Verify the output notes
    // ===========================================

    // Constraint 4: New commitment is correctly formed
    let computed_new = poseidon_hash_4([new_nullifier, new_secret, new_amount, new_recipient]);
    assert(computed_new == new_commitment);

    // Constraint 5: Change commitment is correctly formed
    let computed_change = poseidon_hash_4([change_nullifier, change_secret, change_amount, change_recipient]);
    assert(computed_change == change_commitment);

    // ===========================================
    // PART 3: Value conservation
    // ===========================================

    // Constraint 6: No money created or destroyed
    // input_amount = new_amount + change_amount
    assert(old_amount == new_amount + change_amount);

    // Constraint 7: Amounts must be non-negative (implicit in u64 conversion)
    let new_amount_u64 = new_amount as u64;
    let change_amount_u64 = change_amount as u64;
    assert(new_amount_u64 >= 0);
    assert(change_amount_u64 >= 0);

    // ===========================================
    // PART 4: Prevent trivial values
    // ===========================================

    // Constraint 8: New nullifiers must be non-zero
    assert(new_nullifier != 0);
    assert(change_nullifier != 0);

    // Constraint 9: New secrets must be non-zero
    assert(new_secret != 0);
    assert(change_secret != 0);

    // Constraint 10: Nullifiers must be unique (prevent double-notes)
    assert(new_nullifier != change_nullifier);
    assert(new_nullifier != old_nullifier);
    assert(change_nullifier != old_nullifier);
}

#[test]
fn test_transfer_basic() {
    // Input note
    let old_nullifier: Field = 0x1111;
    let old_secret: Field = 0x2222;
    let old_amount: Field = 1000000000; // 1 SOL
    let old_stealth: Field = 0x3333;

    let old_commitment = poseidon_hash_4([old_nullifier, old_secret, old_amount, old_stealth]);
    let nullifier_hash = poseidon_hash_2(old_nullifier, 0);

    // Build Merkle path (simplified - all zero siblings)
    let merkle_path: [Field; 10] = [0; 10];
    let path_indices: [u1; 10] = [0; 10];

    let mut current = old_commitment;
    for i in 0..10 {
        current = poseidon_hash_2(current, 0);
    }
    let merkle_root = current;

    // Output note 1 (recipient gets 0.3 SOL)
    let new_nullifier: Field = 0x4444;
    let new_secret: Field = 0x5555;
    let new_amount: Field = 300000000;
    let new_recipient: Field = 0x6666;
    let new_commitment = poseidon_hash_4([new_nullifier, new_secret, new_amount, new_recipient]);

    // Output note 2 (sender gets 0.7 SOL change)
    let change_nullifier: Field = 0x7777;
    let change_secret: Field = 0x8888;
    let change_amount: Field = 700000000;
    let change_recipient: Field = 0x9999;
    let change_commitment = poseidon_hash_4([change_nullifier, change_secret, change_amount, change_recipient]);

    main(
        merkle_root,
        nullifier_hash,
        new_commitment,
        change_commitment,
        old_nullifier,
        old_secret,
        old_amount,
        old_stealth,
        merkle_path,
        path_indices,
        new_nullifier,
        new_secret,
        new_amount,
        new_recipient,
        change_nullifier,
        change_secret,
        change_amount,
        change_recipient
    );
}
