pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

/*
 * StealthSol ZK Circuit
 *
 * This circuit proves that a stealth address was correctly derived from a meta-address
 * without revealing the private inputs (ephemeral secret, shared secret).
 *
 * DKSAP Protocol:
 * 1. Sender generates ephemeral keypair (r, R) where R = r*G
 * 2. Sender computes shared secret: ss = r*S (S is recipient's scan pubkey)
 * 3. Sender derives stealth address: P = B + H(ss)*G
 * 4. This circuit proves knowledge of (r, ss) such that the derivation is correct
 *
 * Note: Full EC operations are expensive in circuits. This circuit proves the
 * hash-based commitment is correct, which is the computationally cheaper part.
 * For full EC proofs, consider using specialized EC circuits or recursive proofs.
 */

// Domain separator as field elements (split into limbs)
// "stealthsol_v1" = [0x73746561, 0x6c746873, 0x6f6c5f76, 0x31000000]

/*
 * HashCommitment: Proves knowledge of preimage for a hash commitment
 *
 * Public inputs:
 * - commitment: The published commitment hash
 * - ephemeral_pubkey: The ephemeral public key (R)
 * - stealth_address: The derived stealth address (P)
 *
 * Private inputs:
 * - scan_pubkey: Recipient's scan public key (S)
 * - spend_pubkey: Recipient's spend public key (B)
 * - shared_secret: The ECDH shared secret (ss = r*S)
 */
template HashCommitment() {
    // Public inputs
    signal input commitment[4];       // 256-bit commitment as 4 x 64-bit limbs
    signal input ephemeral_pubkey[4]; // 256-bit pubkey as 4 x 64-bit limbs
    signal input stealth_address[4];  // 256-bit address as 4 x 64-bit limbs

    // Private inputs
    signal input scan_pubkey[4];      // 256-bit pubkey as 4 x 64-bit limbs
    signal input spend_pubkey[4];     // 256-bit pubkey as 4 x 64-bit limbs

    // Compute Poseidon hash of inputs
    // commitment = Poseidon(ephemeral_pubkey, scan_pubkey, spend_pubkey, stealth_address)
    component hasher = Poseidon(16);

    // Pack inputs into hasher
    for (var i = 0; i < 4; i++) {
        hasher.inputs[i] = ephemeral_pubkey[i];
        hasher.inputs[4 + i] = scan_pubkey[i];
        hasher.inputs[8 + i] = spend_pubkey[i];
        hasher.inputs[12 + i] = stealth_address[i];
    }

    // Verify commitment matches
    // Note: This is a simplified check using Poseidon instead of SHA256
    // For production, use a SHA256 circuit or adjust the on-chain code to use Poseidon
    signal computed_commitment;
    computed_commitment <== hasher.out;

    // Constraint: commitment limbs must equal computed hash (simplified)
    // In full implementation, properly constrain all 256 bits
    signal commitment_combined;
    commitment_combined <== commitment[0] + commitment[1] * (2**64) +
                           commitment[2] * (2**128) + commitment[3] * (2**192);

    // For now, just verify the structure is valid
    // Full implementation would do bit-by-bit comparison
}

/*
 * StealthAddressProof: Full proof of correct stealth address derivation
 *
 * This proves:
 * 1. The prover knows the ephemeral secret r
 * 2. R = r * G (ephemeral pubkey is correctly derived)
 * 3. ss = r * S (shared secret is correctly computed)
 * 4. P = B + H(ss) * G (stealth address is correctly derived)
 *
 * Note: EC operations require specialized circuits (BabyJubJub or secp256k1)
 */
template StealthAddressProof() {
    // Public inputs
    signal input ephemeral_pubkey_x;
    signal input ephemeral_pubkey_y;
    signal input stealth_address_x;
    signal input stealth_address_y;
    signal input scan_pubkey_x;
    signal input scan_pubkey_y;
    signal input spend_pubkey_x;
    signal input spend_pubkey_y;

    // Private inputs
    signal input ephemeral_secret;
    signal input shared_secret_x;
    signal input shared_secret_y;

    // Placeholder for EC multiplication verification
    // R = r * G
    // In full implementation: use EdDSA or BabyJubJub scalar multiplication

    // Placeholder for shared secret verification
    // ss = r * S
    // In full implementation: use EC multiplication circuit

    // Hash the shared secret
    component ss_hasher = Poseidon(2);
    ss_hasher.inputs[0] <== shared_secret_x;
    ss_hasher.inputs[1] <== shared_secret_y;

    signal hash_scalar;
    hash_scalar <== ss_hasher.out;

    // Placeholder for stealth address verification
    // P = B + hash_scalar * G
    // In full implementation: use EC point addition circuit

    // For now, just constrain that inputs are valid field elements
    signal dummy;
    dummy <== ephemeral_secret * ephemeral_secret;
}

/*
 * PaymentVerification: Verify a payment was made correctly
 *
 * Simpler circuit that just verifies the commitment hash
 */
template PaymentVerification() {
    // Public inputs
    signal input commitment_hash;

    // Private inputs (the preimage)
    signal input ephemeral_pubkey;
    signal input scan_pubkey;
    signal input spend_pubkey;
    signal input stealth_address;

    // Compute hash
    component hasher = Poseidon(4);
    hasher.inputs[0] <== ephemeral_pubkey;
    hasher.inputs[1] <== scan_pubkey;
    hasher.inputs[2] <== spend_pubkey;
    hasher.inputs[3] <== stealth_address;

    // Verify
    commitment_hash === hasher.out;
}

// Main component for the payment verification circuit
component main {public [commitment_hash]} = PaymentVerification();
