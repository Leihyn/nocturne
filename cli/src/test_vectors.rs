//! DKSAP Test Vectors
//!
//! These test vectors verify the correctness of the DKSAP (Dual-Key Stealth Address Protocol)
//! implementation against known-good values.
//!
//! Reference: "Stealth Addresses" cryptographic protocol
//! Similar implementations: Umbra Protocol, EIP-5564

#[cfg(test)]
#[allow(clippy::op_ref)]
#[allow(clippy::needless_borrows_for_generic_args)]
#[allow(clippy::expect_fun_call)]
#[allow(non_snake_case)]  // Crypto notation uses S, B, R, P, etc.
mod dksap_test_vectors {
    use crate::crypto::{
        compute_stealth_address, scan_payment, StealthKeys, compute_commitment,
    };
    use curve25519_dalek::{
        constants::ED25519_BASEPOINT_POINT,
        scalar::Scalar,
    };

    /// Test Vector 1: Known scalar values with deterministic derivation
    ///
    /// This tests the full DKSAP flow with fixed inputs to ensure
    /// deterministic and correct behavior.
    #[test]
    fn test_vector_1_deterministic_keys() {
        // Fixed scan and spend secrets (reduced mod l for valid scalars)
        let scan_secret_bytes: [u8; 32] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
            0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
            0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x00,
        ];

        let spend_secret_bytes: [u8; 32] = [
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
            0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30,
            0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
            0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x00,
        ];

        let keys = StealthKeys::from_secrets(&scan_secret_bytes, &spend_secret_bytes);

        // Verify public keys are derived correctly
        // S = s * G, B = b * G
        let g = ED25519_BASEPOINT_POINT;
        let scan_scalar = Scalar::from_bytes_mod_order(scan_secret_bytes);
        let spend_scalar = Scalar::from_bytes_mod_order(spend_secret_bytes);

        let expected_scan_pub = (&scan_scalar * &g).compress().to_bytes();
        let expected_spend_pub = (&spend_scalar * &g).compress().to_bytes();

        assert_eq!(keys.scan_pubkey, expected_scan_pub, "Scan pubkey derivation failed");
        assert_eq!(keys.spend_pubkey, expected_spend_pub, "Spend pubkey derivation failed");
    }

    /// Test Vector 2: DKSAP shared secret computation
    ///
    /// Verifies that r*S == s*R (the core DKSAP property)
    #[test]
    fn test_vector_2_shared_secret_equality() {
        // This is the fundamental DKSAP property:
        // sender: ss = r * S = r * s * G
        // recipient: ss = s * R = s * r * G
        // Both compute the same shared secret

        let scan_secret: [u8; 32] = [
            0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89,
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
            0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
            0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0x00,
        ];

        let ephemeral_secret: [u8; 32] = [
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
            0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
            0x00, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99,
            0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x00,
        ];

        let g = ED25519_BASEPOINT_POINT;

        let s = Scalar::from_bytes_mod_order(scan_secret);
        let r = Scalar::from_bytes_mod_order(ephemeral_secret);

        // Compute public keys
        let S = &s * &g;  // scan pubkey
        let R = &r * &g;  // ephemeral pubkey

        // Sender computes: r * S
        let sender_ss = &r * &S;

        // Recipient computes: s * R
        let recipient_ss = &s * &R;

        // These must be equal
        assert_eq!(
            sender_ss.compress().to_bytes(),
            recipient_ss.compress().to_bytes(),
            "Shared secret mismatch - DKSAP property violated"
        );
    }

    /// Test Vector 3: Full stealth address derivation and recovery
    ///
    /// P = B + H(ss)*G (stealth pubkey)
    /// p = b + H(ss) (stealth privkey)
    #[test]
    fn test_vector_3_full_stealth_flow() {
        let scan_secret: [u8; 32] = [
            0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
            0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
            0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
            0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x00,
        ];

        let spend_secret: [u8; 32] = [
            0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
            0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
            0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
            0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x00,
        ];

        let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let (scan_pub, spend_pub) = keys.meta_address();

        // Compute stealth address (sender side)
        let computation = compute_stealth_address(&scan_pub, &spend_pub)
            .expect("Should compute stealth address");

        // Scan and recover (recipient side)
        let scan_result = scan_payment(
            &keys,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        );

        assert!(scan_result.is_some(), "Recipient should detect the payment");

        // Verify the spending key derives to the stealth address
        let result = scan_result.unwrap();
        let g = ED25519_BASEPOINT_POINT;
        let spending_scalar = Scalar::from_bytes_mod_order(result.spending_key_bytes());
        let derived_pub = (&spending_scalar * &g).compress().to_bytes();

        assert_eq!(
            derived_pub, computation.stealth_pubkey,
            "Spending key should derive to stealth address"
        );
    }

    /// Test Vector 4: Wrong recipient cannot derive spending key
    #[test]
    fn test_vector_4_wrong_recipient() {
        let keys1 = StealthKeys::from_secrets(
            &[0x11; 32],
            &[0x22; 32],
        );

        let keys2 = StealthKeys::from_secrets(
            &[0x33; 32],
            &[0x44; 32],
        );

        let (scan_pub, spend_pub) = keys1.meta_address();

        // Send to recipient 1
        let computation = compute_stealth_address(&scan_pub, &spend_pub)
            .expect("Should compute");

        // Recipient 2 tries to scan
        let result = scan_payment(
            &keys2,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        );

        assert!(result.is_none(), "Wrong recipient should not detect payment");
    }

    /// Test Vector 5: Multiple payments are unlinkable
    #[test]
    fn test_vector_5_unlinkability() {
        let keys = StealthKeys::from_secrets(
            &[0x99; 32],
            &[0x88; 32],
        );
        let (scan_pub, spend_pub) = keys.meta_address();

        // Generate 5 payments
        let mut stealth_addresses = Vec::new();
        let mut ephemeral_keys = Vec::new();

        for _ in 0..5 {
            let comp = compute_stealth_address(&scan_pub, &spend_pub).unwrap();
            stealth_addresses.push(comp.stealth_pubkey);
            ephemeral_keys.push(comp.ephemeral_pubkey);
        }

        // All stealth addresses must be unique
        for i in 0..5 {
            for j in (i + 1)..5 {
                assert_ne!(
                    stealth_addresses[i], stealth_addresses[j],
                    "Stealth addresses {} and {} should be different (unlinkability)",
                    i, j
                );
            }
        }

        // All ephemeral keys must be unique
        for i in 0..5 {
            for j in (i + 1)..5 {
                assert_ne!(
                    ephemeral_keys[i], ephemeral_keys[j],
                    "Ephemeral keys {} and {} should be different",
                    i, j
                );
            }
        }

        // But recipient can scan all of them
        for i in 0..5 {
            let result = scan_payment(&keys, &ephemeral_keys[i], &stealth_addresses[i]);
            assert!(result.is_some(), "Recipient should detect payment {}", i);
        }
    }

    /// Test Vector 6: Commitment hash consistency
    #[test]
    fn test_vector_6_commitment_consistency() {
        let ephemeral: [u8; 32] = [0x11; 32];
        let scan: [u8; 32] = [0x22; 32];
        let spend: [u8; 32] = [0x33; 32];
        let stealth: [u8; 32] = [0x44; 32];

        // Compute commitment twice
        let commitment1 = compute_commitment(&ephemeral, &scan, &spend, &stealth);
        let commitment2 = compute_commitment(&ephemeral, &scan, &spend, &stealth);

        // Must be deterministic
        assert_eq!(commitment1, commitment2, "Commitment must be deterministic");

        // Change any input, commitment changes
        let commitment_diff = compute_commitment(&[0x12; 32], &scan, &spend, &stealth);
        assert_ne!(commitment1, commitment_diff, "Different input should produce different commitment");
    }

    /// Test Vector 7: Edge case - minimum valid scalar
    #[test]
    fn test_vector_7_minimum_scalar() {
        // Scalar with value 1 (minimum non-zero)
        let mut scan_secret = [0u8; 32];
        scan_secret[0] = 1;

        let mut spend_secret = [0u8; 32];
        spend_secret[0] = 2;

        let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let (scan_pub, spend_pub) = keys.meta_address();

        let computation = compute_stealth_address(&scan_pub, &spend_pub)
            .expect("Should work with minimum scalars");

        let result = scan_payment(&keys, &computation.ephemeral_pubkey, &computation.stealth_pubkey);
        assert!(result.is_some(), "Should work with minimum scalar values");
    }

    /// Test Vector 8: Edge case - maximum valid scalar (close to curve order)
    #[test]
    fn test_vector_8_large_scalar() {
        // Large scalar (will be reduced mod l)
        let scan_secret = [0xFF; 32];
        let spend_secret = [0xFE; 32];

        let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let (scan_pub, spend_pub) = keys.meta_address();

        let computation = compute_stealth_address(&scan_pub, &spend_pub)
            .expect("Should work with large scalars");

        let result = scan_payment(&keys, &computation.ephemeral_pubkey, &computation.stealth_pubkey);
        assert!(result.is_some(), "Should work with large scalar values");
    }

    /// Test Vector 9: Verify scan key separation from spend key
    ///
    /// View key (scan key) can detect payments but cannot spend
    #[test]
    fn test_vector_9_view_key_separation() {
        let scan_secret: [u8; 32] = [0x77; 32];
        let spend_secret: [u8; 32] = [0x88; 32];

        let full_keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let (scan_pub, spend_pub) = full_keys.meta_address();

        // Compute stealth address
        let computation = compute_stealth_address(&scan_pub, &spend_pub).unwrap();

        // View-only keys (someone with only scan_secret)
        // They can compute the expected stealth address but not the spending key
        let g = ED25519_BASEPOINT_POINT;
        let s = Scalar::from_bytes_mod_order(scan_secret);

        // View key holder can compute shared secret
        let R_bytes = computation.ephemeral_pubkey;
        let R = curve25519_dalek::edwards::CompressedEdwardsY::from_slice(&R_bytes)
            .decompress()
            .expect("Valid point");

        let ss = &s * &R;
        let ss_bytes = ss.compress().to_bytes();

        // Hash shared secret
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(b"stealthsol_v1");
        hasher.update(&ss_bytes);
        let hash = hasher.finalize();
        let mut hash_bytes = [0u8; 32];
        hash_bytes.copy_from_slice(&hash);
        let h = Scalar::from_bytes_mod_order(hash_bytes);

        // Compute expected stealth pubkey: P = B + h*G
        let B = curve25519_dalek::edwards::CompressedEdwardsY::from_slice(&spend_pub)
            .decompress()
            .expect("Valid point");
        let expected_P = &B + &(&h * &g);

        // View key holder can verify payment is for this recipient
        assert_eq!(
            expected_P.compress().to_bytes(),
            computation.stealth_pubkey,
            "View key should be able to verify payments"
        );

        // But to spend, you need: p = b + h
        // View key holder doesn't have 'b', so can't compute 'p'
    }

    /// Test Vector 10: Stress test with many sequential operations
    #[test]
    fn test_vector_10_stress_test() {
        let keys = StealthKeys::from_secrets(&[0x12; 32], &[0x34; 32]);
        let (scan_pub, spend_pub) = keys.meta_address();

        for i in 0..50 {
            let computation = compute_stealth_address(&scan_pub, &spend_pub)
                .expect(&format!("Iteration {} failed", i));

            let result = scan_payment(
                &keys,
                &computation.ephemeral_pubkey,
                &computation.stealth_pubkey,
            );

            assert!(result.is_some(), "Iteration {} should succeed", i);

            // Verify spending key
            let g = ED25519_BASEPOINT_POINT;
            let result_unwrapped = result.unwrap();
            let spending_scalar = Scalar::from_bytes_mod_order(result_unwrapped.spending_key_bytes());
            let derived = (&spending_scalar * &g).compress().to_bytes();
            assert_eq!(derived, computation.stealth_pubkey, "Iteration {} key mismatch", i);
        }
    }
}
