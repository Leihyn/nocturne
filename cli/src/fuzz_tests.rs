//! Property-based fuzzing tests for StealthSol cryptographic operations
//!
//! These tests use proptest to verify cryptographic properties hold for arbitrary inputs.
//! Properties tested:
//! - DKSAP correctness: recipient can always detect and spend their payments
//! - Unlinkability: different payments produce different stealth addresses
//! - Wrong recipient rejection: non-recipient cannot detect payments
//! - Commitment consistency: deterministic commitment generation
//! - Key derivation consistency: same inputs produce same outputs

#[cfg(test)]
mod property_tests {
    use proptest::prelude::*;
    use crate::crypto::{
        compute_stealth_address, scan_payment, StealthKeys, compute_commitment,
    };
    use solana_sdk::signer::Signer;

    // Strategy for generating valid 32-byte arrays (scalar values)
    fn arbitrary_scalar() -> impl Strategy<Value = [u8; 32]> {
        prop::array::uniform32(any::<u8>())
    }

    // Strategy for generating non-zero scalars (valid secret keys)
    fn nonzero_scalar() -> impl Strategy<Value = [u8; 32]> {
        arbitrary_scalar().prop_filter("non-zero scalar", |bytes| {
            // At least one byte must be non-zero
            bytes.iter().any(|&b| b != 0)
        })
    }

    // Strategy for generating distinct key pairs
    fn distinct_scalars() -> impl Strategy<Value = ([u8; 32], [u8; 32])> {
        (nonzero_scalar(), nonzero_scalar()).prop_filter(
            "distinct scalars",
            |(a, b)| a != b
        )
    }

    proptest! {
        /// Property: DKSAP Correctness
        /// The recipient can always detect and derive the correct spending key
        /// for payments addressed to them.
        #[test]
        fn prop_dksap_correctness(
            (scan_secret, spend_secret) in distinct_scalars()
        ) {
            let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
            let (scan_pubkey, spend_pubkey) = keys.meta_address();

            // Compute stealth address (sender side)
            let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
                .expect("Stealth address computation should succeed");

            // Scan and detect payment (recipient side)
            let scan_result = scan_payment(
                &keys,
                &computation.ephemeral_pubkey,
                &computation.stealth_pubkey,
            );

            prop_assert!(scan_result.is_some(), "Recipient should detect their payment");

            // Verify spending key derives to stealth address
            let result = scan_result.unwrap();
            let signer = result.create_signer().expect("Should create signer");
            prop_assert_eq!(
                signer.pubkey().to_bytes(),
                computation.stealth_pubkey,
                "Spending key should derive to stealth address"
            );
        }

        /// Property: Unlinkability
        /// Multiple payments to the same recipient produce unique stealth addresses.
        #[test]
        fn prop_unlinkability(
            (scan_secret, spend_secret) in distinct_scalars()
        ) {
            let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
            let (scan_pubkey, spend_pubkey) = keys.meta_address();

            // Generate two payments
            let comp1 = compute_stealth_address(&scan_pubkey, &spend_pubkey)
                .expect("First computation should succeed");
            let comp2 = compute_stealth_address(&scan_pubkey, &spend_pubkey)
                .expect("Second computation should succeed");

            // Stealth addresses must be unique
            prop_assert_ne!(
                comp1.stealth_pubkey,
                comp2.stealth_pubkey,
                "Different payments should have different stealth addresses"
            );

            // Ephemeral keys must be unique
            prop_assert_ne!(
                comp1.ephemeral_pubkey,
                comp2.ephemeral_pubkey,
                "Different payments should have different ephemeral keys"
            );

            // Both should still be detectable by recipient
            prop_assert!(scan_payment(&keys, &comp1.ephemeral_pubkey, &comp1.stealth_pubkey).is_some());
            prop_assert!(scan_payment(&keys, &comp2.ephemeral_pubkey, &comp2.stealth_pubkey).is_some());
        }

        /// Property: Wrong Recipient Rejection
        /// A non-recipient cannot detect payments meant for another recipient.
        #[test]
        fn prop_wrong_recipient_rejection(
            (scan_secret1, spend_secret1) in distinct_scalars(),
            (scan_secret2, spend_secret2) in distinct_scalars(),
        ) {
            // Skip if keys happen to be the same
            prop_assume!(scan_secret1 != scan_secret2 || spend_secret1 != spend_secret2);

            let recipient1 = StealthKeys::from_secrets(&scan_secret1, &spend_secret1);
            let recipient2 = StealthKeys::from_secrets(&scan_secret2, &spend_secret2);
            let (scan_pub1, spend_pub1) = recipient1.meta_address();

            // Send to recipient 1
            let computation = compute_stealth_address(&scan_pub1, &spend_pub1)
                .expect("Computation should succeed");

            // Recipient 1 can detect
            prop_assert!(scan_payment(
                &recipient1,
                &computation.ephemeral_pubkey,
                &computation.stealth_pubkey,
            ).is_some());

            // Recipient 2 cannot detect
            prop_assert!(scan_payment(
                &recipient2,
                &computation.ephemeral_pubkey,
                &computation.stealth_pubkey,
            ).is_none(), "Wrong recipient should not detect payment");
        }

        /// Property: Commitment Determinism
        /// The same inputs always produce the same commitment hash.
        #[test]
        fn prop_commitment_determinism(
            ephemeral in arbitrary_scalar(),
            scan in arbitrary_scalar(),
            spend in arbitrary_scalar(),
            stealth in arbitrary_scalar(),
        ) {
            let commitment1 = compute_commitment(&ephemeral, &scan, &spend, &stealth);
            let commitment2 = compute_commitment(&ephemeral, &scan, &spend, &stealth);

            prop_assert_eq!(commitment1, commitment2, "Commitment must be deterministic");
        }

        /// Property: Commitment Sensitivity
        /// Different inputs produce different commitment hashes.
        #[test]
        fn prop_commitment_sensitivity(
            ephemeral in arbitrary_scalar(),
            scan in arbitrary_scalar(),
            spend in arbitrary_scalar(),
            stealth in arbitrary_scalar(),
            different_ephemeral in arbitrary_scalar(),
        ) {
            prop_assume!(ephemeral != different_ephemeral);

            let commitment1 = compute_commitment(&ephemeral, &scan, &spend, &stealth);
            let commitment2 = compute_commitment(&different_ephemeral, &scan, &spend, &stealth);

            prop_assert_ne!(
                commitment1,
                commitment2,
                "Different inputs should produce different commitments"
            );
        }

        /// Property: Key Derivation Determinism
        /// Same secrets always produce the same public keys.
        #[test]
        fn prop_key_derivation_determinism(
            (scan_secret, spend_secret) in distinct_scalars()
        ) {
            let keys1 = StealthKeys::from_secrets(&scan_secret, &spend_secret);
            let keys2 = StealthKeys::from_secrets(&scan_secret, &spend_secret);

            prop_assert_eq!(keys1.scan_pubkey, keys2.scan_pubkey);
            prop_assert_eq!(keys1.spend_pubkey, keys2.spend_pubkey);
        }

        /// Property: Different Secrets Produce Different Keys
        /// Different secrets always produce different public keys.
        #[test]
        fn prop_different_secrets_different_keys(
            (scan_secret1, spend_secret1) in distinct_scalars(),
            (scan_secret2, spend_secret2) in distinct_scalars(),
        ) {
            prop_assume!(scan_secret1 != scan_secret2);

            let keys1 = StealthKeys::from_secrets(&scan_secret1, &spend_secret1);
            let keys2 = StealthKeys::from_secrets(&scan_secret2, &spend_secret2);

            // At least the scan pubkeys should differ (spend might match by coincidence)
            prop_assert_ne!(keys1.scan_pubkey, keys2.scan_pubkey);
        }

        /// Property: Edge Case - Near-Zero Scalars
        /// Keys work correctly even with minimal scalar values.
        #[test]
        fn prop_edge_case_small_scalars(
            small_val1 in 1u8..=10,
            small_val2 in 1u8..=10,
        ) {
            prop_assume!(small_val1 != small_val2);

            let mut scan_secret = [0u8; 32];
            let mut spend_secret = [0u8; 32];
            scan_secret[0] = small_val1;
            spend_secret[0] = small_val2;

            let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
            let (scan_pubkey, spend_pubkey) = keys.meta_address();

            let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
                .expect("Should work with small scalars");

            let scan_result = scan_payment(
                &keys,
                &computation.ephemeral_pubkey,
                &computation.stealth_pubkey,
            );

            prop_assert!(scan_result.is_some(), "Should work with small scalar values");
        }

        /// Property: Edge Case - Large Scalars
        /// Keys work correctly even with large scalar values (near curve order).
        #[test]
        fn prop_edge_case_large_scalars(
            high_byte in 0xF0u8..=0xFF,
        ) {
            let mut scan_secret = [high_byte; 32];
            let mut spend_secret = [high_byte.wrapping_sub(1); 32];
            // Ensure they're different
            scan_secret[0] = 0xFE;
            spend_secret[0] = 0xFD;

            let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
            let (scan_pubkey, spend_pubkey) = keys.meta_address();

            let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
                .expect("Should work with large scalars");

            let scan_result = scan_payment(
                &keys,
                &computation.ephemeral_pubkey,
                &computation.stealth_pubkey,
            );

            prop_assert!(scan_result.is_some(), "Should work with large scalar values");
        }

        /// Property: Meta-Address Roundtrip
        /// Meta-address encoding/decoding preserves the original keys.
        #[test]
        fn prop_meta_address_roundtrip(
            (scan_secret, spend_secret) in distinct_scalars()
        ) {
            use crate::config::{format_meta_address, parse_meta_address};

            let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
            let (scan_pubkey, spend_pubkey) = keys.meta_address();

            let formatted = format_meta_address(&scan_pubkey, &spend_pubkey);
            let (parsed_scan, parsed_spend) = parse_meta_address(&formatted)
                .expect("Should parse meta-address");

            prop_assert_eq!(scan_pubkey, parsed_scan);
            prop_assert_eq!(spend_pubkey, parsed_spend);
        }

        /// Property: Commitment Non-Collision (probabilistic)
        /// Random inputs should not produce commitment collisions.
        #[test]
        fn prop_commitment_no_collision(
            inputs1 in (arbitrary_scalar(), arbitrary_scalar(), arbitrary_scalar(), arbitrary_scalar()),
            inputs2 in (arbitrary_scalar(), arbitrary_scalar(), arbitrary_scalar(), arbitrary_scalar()),
        ) {
            let (e1, sc1, sp1, st1) = inputs1;
            let (e2, sc2, sp2, st2) = inputs2;

            // Skip if all inputs are the same
            prop_assume!(e1 != e2 || sc1 != sc2 || sp1 != sp2 || st1 != st2);

            let commitment1 = compute_commitment(&e1, &sc1, &sp1, &st1);
            let commitment2 = compute_commitment(&e2, &sc2, &sp2, &st2);

            prop_assert_ne!(
                commitment1,
                commitment2,
                "Different inputs should (almost always) produce different commitments"
            );
        }
    }

    /// Regression test: ensure mnemonic generation is deterministic from same entropy
    #[test]
    fn test_mnemonic_determinism() {
        let entropy = [0x42u8; 32];

        // Same entropy should produce same mnemonic and keys
        // Note: We can't test generate_with_mnemonic directly as it uses random entropy
        // But we can test from_mnemonic with a fixed phrase
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

        let keys1 = StealthKeys::from_mnemonic(phrase, "").unwrap();
        let keys2 = StealthKeys::from_mnemonic(phrase, "").unwrap();

        assert_eq!(keys1.scan_pubkey, keys2.scan_pubkey);
        assert_eq!(keys1.spend_pubkey, keys2.spend_pubkey);
    }

    /// Regression test: different passphrases produce different keys
    #[test]
    fn test_mnemonic_passphrase_sensitivity() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

        let keys1 = StealthKeys::from_mnemonic(phrase, "").unwrap();
        let keys2 = StealthKeys::from_mnemonic(phrase, "different").unwrap();

        assert_ne!(keys1.scan_pubkey, keys2.scan_pubkey);
        assert_ne!(keys1.spend_pubkey, keys2.spend_pubkey);
    }
}
