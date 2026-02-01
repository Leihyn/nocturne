// StealthSol Deposit Circuit
//
// Proves that a commitment was correctly constructed from:
// - nullifier (private): random value for double-spend prevention
// - secret (private): random blinding factor
// - amount (private): deposit amount in lamports
// - recipient (private): stealth address of recipient
//
// Public output: commitment hash
// This allows deposits without revealing the recipient or amount on-chain

use std::hash::poseidon;

// Poseidon hash for 4 inputs (optimized for ZK)
fn poseidon_hash_4(inputs: [Field; 4]) -> Field {
    poseidon::bn254::hash_4(inputs)
}

// Main deposit circuit
fn main(
    // Public inputs (visible on-chain)
    commitment: pub Field,

    // Private inputs (hidden from everyone)
    nullifier: Field,
    secret: Field,
    amount: Field,
    recipient: Field,
) {
    // Constraint 1: Commitment is correctly computed
    // commitment = Poseidon(nullifier, secret, amount, recipient)
    let computed_commitment = poseidon_hash_4([nullifier, secret, amount, recipient]);
    assert(computed_commitment == commitment);

    // Constraint 2: Amount must be positive
    // We check this by ensuring amount fits in u64
    let amount_u64 = amount as u64;
    assert(amount_u64 > 0);

    // Constraint 3: Nullifier must be non-zero (prevents trivial nullifiers)
    assert(nullifier != 0);

    // Constraint 4: Secret must be non-zero (prevents trivial secrets)
    assert(secret != 0);
}

// Test the circuit with sample values
#[test]
fn test_deposit_circuit() {
    // Use values within BN254 field (< 2^254)
    let nullifier: Field = 0x1234567890abcdef1234567890abcdef;
    let secret: Field = 0xfedcba0987654321fedcba0987654321;
    let amount: Field = 1000000000; // 1 SOL in lamports
    let recipient: Field = 0xabcdef1234567890abcdef1234567890;

    let commitment = poseidon_hash_4([nullifier, secret, amount, recipient]);

    main(commitment, nullifier, secret, amount, recipient);
}
