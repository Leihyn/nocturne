//! Comprehensive tests for StealthSol CLI
//!
//! Tests cover:
//! - Cryptographic operations (DKSAP protocol)
//! - Key generation and storage
//! - Meta-address encoding/decoding
//! - End-to-end stealth payment flow

#[cfg(test)]
#[allow(clippy::op_ref)]
#[allow(clippy::expect_fun_call)]
mod crypto_tests {
    use crate::crypto::{
        compute_stealth_address, scan_payment, StealthKeys, StealthSigner,
    };
    use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
    use solana_sdk::signer::Signer;

    #[test]
    fn test_stealth_keys_generation() {
        let keys = StealthKeys::generate();

        // Verify keys are not all zeros
        assert!(!keys.scan_pubkey.iter().all(|&b| b == 0));
        assert!(!keys.spend_pubkey.iter().all(|&b| b == 0));

        // Verify secrets can be exported and reconstructed
        let (scan_secret, spend_secret) = keys.export_secrets();
        let reconstructed = StealthKeys::from_secrets(&scan_secret, &spend_secret);

        assert_eq!(keys.scan_pubkey, reconstructed.scan_pubkey);
        assert_eq!(keys.spend_pubkey, reconstructed.spend_pubkey);
    }

    #[test]
    fn test_stealth_keys_deterministic_from_secrets() {
        let scan_secret = [0x42u8; 32];
        let spend_secret = [0x43u8; 32];

        let keys1 = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let keys2 = StealthKeys::from_secrets(&scan_secret, &spend_secret);

        assert_eq!(keys1.scan_pubkey, keys2.scan_pubkey);
        assert_eq!(keys1.spend_pubkey, keys2.spend_pubkey);
    }

    #[test]
    fn test_meta_address_format() {
        let keys = StealthKeys::generate();
        let (scan, spend) = keys.meta_address();

        assert_eq!(scan.len(), 32);
        assert_eq!(spend.len(), 32);
        assert_eq!(scan, keys.scan_pubkey);
        assert_eq!(spend, keys.spend_pubkey);
    }

    #[test]
    fn test_compute_stealth_address_returns_valid_result() {
        let keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        let result = compute_stealth_address(&scan_pubkey, &spend_pubkey);
        assert!(result.is_some());

        let computation = result.unwrap();
        assert!(!computation.stealth_pubkey.iter().all(|&b| b == 0));
        assert!(!computation.ephemeral_pubkey.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_compute_stealth_address_unique_per_call() {
        let keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        let result1 = compute_stealth_address(&scan_pubkey, &spend_pubkey).unwrap();
        let result2 = compute_stealth_address(&scan_pubkey, &spend_pubkey).unwrap();

        // Each call should produce different stealth addresses (different ephemeral keys)
        assert_ne!(result1.stealth_pubkey, result2.stealth_pubkey);
        assert_ne!(result1.ephemeral_pubkey, result2.ephemeral_pubkey);
    }

    #[test]
    fn test_full_stealth_payment_flow() {
        // 1. Recipient generates keys
        let recipient_keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient_keys.meta_address();

        // 2. Sender computes stealth address
        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
            .expect("Should compute stealth address");

        // 3. Recipient scans and detects payment
        let scan_result = scan_payment(
            &recipient_keys,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        );

        assert!(scan_result.is_some(), "Recipient should detect their payment");

        // 4. Verify spending key derivation
        let result = scan_result.unwrap();

        // The spending key should derive to the same stealth address
        let g = ED25519_BASEPOINT_POINT;
        let spending_scalar = Scalar::from_bytes_mod_order(result.spending_key_bytes());
        let derived_pubkey = (&spending_scalar * &g).compress().to_bytes();
        assert_eq!(
            derived_pubkey, computation.stealth_pubkey,
            "Derived public key should match stealth address"
        );
    }

    #[test]
    fn test_scan_payment_rejects_wrong_recipient() {
        // Recipient 1 generates keys
        let recipient1_keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient1_keys.meta_address();

        // Sender sends to recipient 1
        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
            .expect("Should compute stealth address");

        // Recipient 2 (different keys) tries to scan
        let recipient2_keys = StealthKeys::generate();
        let scan_result = scan_payment(
            &recipient2_keys,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        );

        assert!(
            scan_result.is_none(),
            "Wrong recipient should not detect payment"
        );
    }

    #[test]
    fn test_scan_payment_with_wrong_ephemeral_key() {
        let recipient_keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient_keys.meta_address();

        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
            .expect("Should compute stealth address");

        // Try with a different ephemeral key
        let wrong_ephemeral = [0x42u8; 32];
        let scan_result = scan_payment(
            &recipient_keys,
            &wrong_ephemeral,
            &computation.stealth_pubkey,
        );

        assert!(
            scan_result.is_none(),
            "Should not match with wrong ephemeral key"
        );
    }

    #[test]
    fn test_stealth_signer() {
        let scalar_bytes = [0x42u8; 32];
        let scalar = Scalar::from_bytes_mod_order(scalar_bytes);

        let signer = StealthSigner::from_scalar(&scalar).unwrap();

        // Verify the signer is valid
        assert!(signer.pubkey().to_bytes().len() == 32);

        // Verify public key matches scalar * G
        let g = ED25519_BASEPOINT_POINT;
        let expected_pubkey = (&scalar * &g).compress().to_bytes();
        assert_eq!(signer.pubkey().to_bytes(), expected_pubkey);
    }

    #[test]
    fn test_scalar_to_keypair_consistency() {
        let recipient_keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient_keys.meta_address();

        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey).unwrap();

        let scan_result = scan_payment(
            &recipient_keys,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        )
        .unwrap();

        // Convert spending key to signer
        let signer = scan_result.create_signer().unwrap();

        // The signer's public key should match the stealth address
        assert_eq!(
            signer.pubkey().to_bytes(),
            computation.stealth_pubkey,
            "Signer public key should match stealth address"
        );
    }

    #[test]
    fn test_multiple_payments_to_same_recipient() {
        let recipient_keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient_keys.meta_address();

        // Send 3 payments
        let mut stealth_addresses = Vec::new();
        let mut ephemeral_keys = Vec::new();

        for _ in 0..3 {
            let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey).unwrap();
            stealth_addresses.push(computation.stealth_pubkey);
            ephemeral_keys.push(computation.ephemeral_pubkey);
        }

        // All stealth addresses should be unique (unlinkable)
        assert_ne!(stealth_addresses[0], stealth_addresses[1]);
        assert_ne!(stealth_addresses[1], stealth_addresses[2]);
        assert_ne!(stealth_addresses[0], stealth_addresses[2]);

        // But recipient should be able to scan all of them
        for i in 0..3 {
            let result = scan_payment(&recipient_keys, &ephemeral_keys[i], &stealth_addresses[i]);
            assert!(
                result.is_some(),
                "Recipient should detect payment {}",
                i + 1
            );
        }
    }
}

#[cfg(test)]
mod config_tests {
    use crate::config::{format_meta_address, parse_meta_address};

    #[test]
    fn test_format_meta_address() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];

        let formatted = format_meta_address(&scan, &spend);

        assert!(formatted.starts_with("stealth:"));
        assert!(formatted.len() > 8); // "stealth:" + base58 encoded data
    }

    #[test]
    fn test_parse_meta_address_with_prefix() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];

        let formatted = format_meta_address(&scan, &spend);
        let (parsed_scan, parsed_spend) = parse_meta_address(&formatted).unwrap();

        assert_eq!(scan, parsed_scan);
        assert_eq!(spend, parsed_spend);
    }

    #[test]
    fn test_parse_meta_address_without_prefix() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];

        let formatted = format_meta_address(&scan, &spend);
        // Remove the "stealth:" prefix
        let without_prefix = formatted.strip_prefix("stealth:").unwrap();

        let (parsed_scan, parsed_spend) = parse_meta_address(without_prefix).unwrap();

        assert_eq!(scan, parsed_scan);
        assert_eq!(spend, parsed_spend);
    }

    #[test]
    fn test_parse_meta_address_invalid_length() {
        let result = parse_meta_address("invalid");
        assert!(result.is_err());
    }

    #[test]
    fn test_meta_address_roundtrip_random() {
        use rand::RngCore;
        let mut rng = rand::thread_rng();

        for _ in 0..10 {
            let mut scan = [0u8; 32];
            let mut spend = [0u8; 32];
            rng.fill_bytes(&mut scan);
            rng.fill_bytes(&mut spend);

            let formatted = format_meta_address(&scan, &spend);
            let (parsed_scan, parsed_spend) = parse_meta_address(&formatted).unwrap();

            assert_eq!(scan, parsed_scan);
            assert_eq!(spend, parsed_spend);
        }
    }
}

#[cfg(test)]
mod security_tests {
    use crate::crypto::StealthKeys;
    use zeroize::Zeroize;

    #[test]
    fn test_keys_are_different_each_generation() {
        let keys1 = StealthKeys::generate();
        let keys2 = StealthKeys::generate();

        assert_ne!(keys1.scan_pubkey, keys2.scan_pubkey);
        assert_ne!(keys1.spend_pubkey, keys2.spend_pubkey);
    }

    #[test]
    fn test_scan_and_spend_keys_are_different() {
        let keys = StealthKeys::generate();
        assert_ne!(keys.scan_pubkey, keys.spend_pubkey);
    }

    #[test]
    fn test_secret_export_matches_reconstruction() {
        let keys = StealthKeys::generate();
        let (scan_secret, spend_secret) = keys.export_secrets();

        // Verify secrets are not all zeros
        assert!(!scan_secret.iter().all(|&b| b == 0));
        assert!(!spend_secret.iter().all(|&b| b == 0));

        // Verify reconstruction
        let reconstructed = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        assert_eq!(keys.scan_pubkey, reconstructed.scan_pubkey);
        assert_eq!(keys.spend_pubkey, reconstructed.spend_pubkey);
    }

    #[test]
    fn test_zeroize_works_on_secrets() {
        let mut secret = [0x42u8; 32];
        secret.zeroize();
        assert!(secret.iter().all(|&b| b == 0));
    }
}

#[cfg(test)]
#[allow(clippy::expect_fun_call)]
mod edge_case_tests {
    use crate::crypto::{compute_stealth_address, scan_payment, StealthKeys};

    #[test]
    fn test_stealth_address_with_zero_like_secrets() {
        // Create keys from near-zero secrets (but not exactly zero due to mod order)
        let scan_secret = [0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let spend_secret = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

        let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey);
        assert!(computation.is_some());

        let computation = computation.unwrap();
        let scan_result = scan_payment(&keys, &computation.ephemeral_pubkey, &computation.stealth_pubkey);
        assert!(scan_result.is_some());
    }

    #[test]
    fn test_stealth_address_with_high_value_secrets() {
        // Create keys from high-value secrets
        let scan_secret = [0xFE; 32];
        let spend_secret = [0xFD; 32];

        let keys = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey);
        assert!(computation.is_some());

        let computation = computation.unwrap();
        let scan_result = scan_payment(&keys, &computation.ephemeral_pubkey, &computation.stealth_pubkey);
        assert!(scan_result.is_some());
    }

    #[test]
    fn test_many_sequential_operations() {
        let keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        // Perform many operations to check for any accumulating errors
        for i in 0..100 {
            let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
                .expect(&format!("Should compute stealth address on iteration {}", i));

            let scan_result = scan_payment(&keys, &computation.ephemeral_pubkey, &computation.stealth_pubkey);
            assert!(
                scan_result.is_some(),
                "Should detect payment on iteration {}",
                i
            );
        }
    }
}
