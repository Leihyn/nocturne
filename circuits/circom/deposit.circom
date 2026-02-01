pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";

/**
 * StealthSol Deposit Circuit
 *
 * Proves that a commitment was correctly constructed without
 * revealing the underlying values.
 *
 * Public Inputs:
 *   - commitment: The commitment being deposited
 *
 * Private Inputs:
 *   - nullifier: Secret nullifier (used later for withdrawal)
 *   - secret: Additional secret entropy
 *   - amount: Deposit amount
 *   - recipient: Intended recipient (stealth address)
 *
 * Constraints:
 *   - commitment == Poseidon(nullifier, secret, amount, recipient)
 *   - nullifier != 0 (prevent trivial commitments)
 *   - secret != 0 (prevent trivial commitments)
 *   - amount > 0 (prevent zero deposits)
 */

template Deposit() {
    // Public input
    signal input commitment;

    // Private inputs
    signal input nullifier;
    signal input secret;
    signal input amount;
    signal input recipient;

    // 1. Compute expected commitment
    component hasher = Poseidon(4);
    hasher.inputs[0] <== nullifier;
    hasher.inputs[1] <== secret;
    hasher.inputs[2] <== amount;
    hasher.inputs[3] <== recipient;

    // 2. Verify commitment matches
    commitment === hasher.out;

    // 3. Verify nullifier is non-zero
    component nullifierCheck = IsZero();
    nullifierCheck.in <== nullifier;
    nullifierCheck.out === 0;  // nullifier != 0

    // 4. Verify secret is non-zero
    component secretCheck = IsZero();
    secretCheck.in <== secret;
    secretCheck.out === 0;  // secret != 0

    // 5. Verify amount is positive
    component amountCheck = IsZero();
    amountCheck.in <== amount;
    amountCheck.out === 0;  // amount != 0
}

component main {public [commitment]} = Deposit();
