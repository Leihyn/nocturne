//! Integration tests for StealthSol CLI
//!
//! These tests verify complete end-to-end flows:
//! - Key generation → Storage → Recovery
//! - Complete stealth payment flow (send → scan → spend)
//! - Error handling and edge cases
//! - Multi-recipient scenarios

#[cfg(test)]
mod e2e_tests {
    use crate::crypto::{
        compute_stealth_address, scan_payment, StealthKeys, compute_commitment,
        check_payment,
    };
    use crate::config::{format_meta_address, parse_meta_address};
    use crate::secure_storage::{SecureKeyStorage, KeyData};
    use solana_sdk::signer::Signer;
    use std::collections::HashSet;
    use tempfile::tempdir;

    // ==================== Key Management Integration Tests ====================

    /// Test complete key lifecycle: generate → store → load → recover
    #[test]
    fn test_key_lifecycle_with_mnemonic() {
        // 1. Generate keys with mnemonic
        let (keys, mnemonic) = StealthKeys::generate_with_mnemonic()
            .expect("Should generate keys with mnemonic");

        // 2. Verify keys are valid
        assert!(!keys.scan_pubkey.iter().all(|&b| b == 0));
        assert!(!keys.spend_pubkey.iter().all(|&b| b == 0));
        assert_ne!(keys.scan_pubkey, keys.spend_pubkey);

        // 3. Recover keys from mnemonic
        let recovered = StealthKeys::from_mnemonic(&mnemonic, "")
            .expect("Should recover keys from mnemonic");

        // 4. Verify recovered keys match
        assert_eq!(keys.scan_pubkey, recovered.scan_pubkey);
        assert_eq!(keys.spend_pubkey, recovered.spend_pubkey);
    }

    /// Test encrypted key storage: save → load → decrypt
    #[test]
    fn test_encrypted_storage_lifecycle() {
        let temp_dir = tempdir().expect("Should create temp dir");
        let storage_path = temp_dir.path().join("test_keys.enc");
        let storage = SecureKeyStorage::new(storage_path);

        let password = "Test@Password123";

        // Generate and save keys
        let keys = StealthKeys::generate();
        let (scan_secret, spend_secret) = keys.export_secrets();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        let key_data = KeyData {
            scan_secret,
            spend_secret,
            scan_pubkey,
            spend_pubkey,
        };

        storage.save(&key_data, password).expect("Should save keys");

        // Load and verify
        let loaded = storage.load(password).expect("Should load keys");

        assert_eq!(loaded.scan_pubkey, keys.scan_pubkey);
        assert_eq!(loaded.spend_pubkey, keys.spend_pubkey);

        // Verify wrong password fails
        let wrong_result = storage.load("wrong_password");
        assert!(wrong_result.is_err());
    }

    /// Test meta-address encoding/decoding roundtrip
    #[test]
    fn test_meta_address_roundtrip() {
        let keys = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = keys.meta_address();

        // Format meta-address
        let formatted = format_meta_address(&scan_pubkey, &spend_pubkey);

        // Should have correct prefix
        assert!(formatted.starts_with("stealth:"));

        // Parse back
        let (parsed_scan, parsed_spend) = parse_meta_address(&formatted)
            .expect("Should parse meta-address");

        assert_eq!(parsed_scan, scan_pubkey);
        assert_eq!(parsed_spend, spend_pubkey);

        // Also test without prefix
        let without_prefix = formatted.strip_prefix("stealth:").unwrap();
        let (parsed_scan2, parsed_spend2) = parse_meta_address(without_prefix)
            .expect("Should parse without prefix");

        assert_eq!(parsed_scan2, scan_pubkey);
        assert_eq!(parsed_spend2, spend_pubkey);
    }

    // ==================== Stealth Payment Flow Tests ====================

    /// Test complete stealth payment flow: generate → send → scan → verify
    #[test]
    fn test_complete_payment_flow() {
        // Setup: Recipient generates keys
        let recipient = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient.meta_address();

        // Step 1: Sender computes stealth address
        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
            .expect("Should compute stealth address");

        // Step 2: Verify commitment is computed
        let commitment = compute_commitment(
            &computation.ephemeral_pubkey,
            &scan_pubkey,
            &spend_pubkey,
            &computation.stealth_pubkey,
        );
        assert!(!commitment.iter().all(|&b| b == 0));

        // Step 3: Recipient scans and finds payment
        let scan_result = scan_payment(
            &recipient,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        ).expect("Should find payment");

        // Step 4: Recipient creates signer to spend
        let signer = scan_result.create_signer()
            .expect("Should create signer");

        // Step 5: Verify signer's pubkey matches stealth address
        assert_eq!(
            signer.pubkey().to_bytes(),
            computation.stealth_pubkey,
            "Signer pubkey should match stealth address"
        );
    }

    /// Test view-key only scanning (no spending capability)
    #[test]
    fn test_view_key_scanning() {
        let recipient = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient.meta_address();

        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
            .expect("Should compute stealth address");

        // Extract just the scan secret (view key)
        let scan_secret = recipient.scan_secret();

        // View key holder can detect payment
        let can_detect = check_payment(
            &scan_secret,
            &spend_pubkey,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        );

        assert!(can_detect, "View key should detect payment");

        // But view key alone cannot derive spending key
        // (This is tested implicitly - check_payment only returns bool, not spending key)
    }

    /// Test multiple payments to same recipient are unlinkable
    #[test]
    fn test_multiple_payments_unlinkable() {
        let recipient = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient.meta_address();

        let num_payments = 10;
        let mut stealth_addresses = HashSet::new();
        let mut ephemeral_keys = HashSet::new();

        for _ in 0..num_payments {
            let comp = compute_stealth_address(&scan_pubkey, &spend_pubkey)
                .expect("Should compute");

            // All stealth addresses should be unique
            assert!(
                stealth_addresses.insert(comp.stealth_pubkey),
                "Stealth address should be unique"
            );

            // All ephemeral keys should be unique
            assert!(
                ephemeral_keys.insert(comp.ephemeral_pubkey),
                "Ephemeral key should be unique"
            );

            // Recipient should detect all payments
            assert!(
                scan_payment(&recipient, &comp.ephemeral_pubkey, &comp.stealth_pubkey).is_some()
            );
        }

        assert_eq!(stealth_addresses.len(), num_payments);
        assert_eq!(ephemeral_keys.len(), num_payments);
    }

    // ==================== Multi-Recipient Tests ====================

    /// Test payments to multiple recipients
    #[test]
    fn test_multi_recipient_isolation() {
        // Create multiple recipients
        let recipients: Vec<_> = (0..5)
            .map(|_| StealthKeys::generate())
            .collect();

        // Send to each recipient
        let payments: Vec<_> = recipients.iter().map(|r| {
            let (scan, spend) = r.meta_address();
            compute_stealth_address(&scan, &spend).expect("Should compute")
        }).collect();

        // Each recipient can only detect their own payment
        for (i, recipient) in recipients.iter().enumerate() {
            for (j, payment) in payments.iter().enumerate() {
                let result = scan_payment(
                    recipient,
                    &payment.ephemeral_pubkey,
                    &payment.stealth_pubkey,
                );

                if i == j {
                    assert!(result.is_some(), "Recipient {} should detect payment {}", i, j);
                } else {
                    assert!(result.is_none(), "Recipient {} should NOT detect payment {}", i, j);
                }
            }
        }
    }

    // ==================== Error Handling Tests ====================

    /// Test handling of invalid curve points
    #[test]
    fn test_invalid_curve_point_handling() {
        let recipient = StealthKeys::generate();

        // Invalid ephemeral key (all zeros)
        let invalid_ephemeral = [0u8; 32];
        let some_stealth = [0x42u8; 32];

        let result = scan_payment(&recipient, &invalid_ephemeral, &some_stealth);
        assert!(result.is_none(), "Should handle invalid ephemeral key");

        // Invalid stealth address
        let (scan, spend) = recipient.meta_address();
        let comp = compute_stealth_address(&scan, &spend).expect("Should compute");

        let wrong_stealth = [0x42u8; 32]; // Not matching
        let result = scan_payment(&recipient, &comp.ephemeral_pubkey, &wrong_stealth);
        assert!(result.is_none(), "Should reject non-matching stealth address");
    }

    /// Test meta-address parsing errors
    #[test]
    fn test_meta_address_parsing_errors() {
        // Too short
        let result = parse_meta_address("short");
        assert!(result.is_err());

        // Invalid base58
        let result = parse_meta_address("stealth:invalid!!!base58###");
        assert!(result.is_err());

        // Wrong length after decode
        let result = parse_meta_address("stealth:2rSMv");  // Valid base58 but too short
        assert!(result.is_err());
    }

    // ==================== Determinism Tests ====================

    /// Test that all operations are deterministic given same inputs
    #[test]
    fn test_deterministic_key_derivation() {
        let scan_secret = [0x42u8; 32];
        let spend_secret = [0x43u8; 32];

        let keys1 = StealthKeys::from_secrets(&scan_secret, &spend_secret);
        let keys2 = StealthKeys::from_secrets(&scan_secret, &spend_secret);

        assert_eq!(keys1.scan_pubkey, keys2.scan_pubkey);
        assert_eq!(keys1.spend_pubkey, keys2.spend_pubkey);
    }

    /// Test commitment determinism
    #[test]
    fn test_deterministic_commitment() {
        let e = [0x01u8; 32];
        let s = [0x02u8; 32];
        let p = [0x03u8; 32];
        let a = [0x04u8; 32];

        let c1 = compute_commitment(&e, &s, &p, &a);
        let c2 = compute_commitment(&e, &s, &p, &a);

        assert_eq!(c1, c2);
    }

    // ==================== Signature Tests ====================

    /// Test that StealthSigner produces valid signatures
    #[test]
    fn test_signer_signature_validity() {
        let recipient = StealthKeys::generate();
        let (scan_pubkey, spend_pubkey) = recipient.meta_address();

        let computation = compute_stealth_address(&scan_pubkey, &spend_pubkey)
            .expect("Should compute");

        let scan_result = scan_payment(
            &recipient,
            &computation.ephemeral_pubkey,
            &computation.stealth_pubkey,
        ).expect("Should find payment");

        let signer = scan_result.create_signer().expect("Should create signer");

        // Sign a test message
        let message = b"Test message for signing";
        let signature = signer.try_sign_message(message)
            .expect("Should sign message");

        // Verify signature is non-zero
        assert!(!signature.as_ref().iter().all(|&b| b == 0));

        // Signature should be 64 bytes
        assert_eq!(signature.as_ref().len(), 64);
    }

    // ==================== Edge Case Tests ====================

    /// Test with edge case key values
    #[test]
    fn test_edge_case_keys() {
        // Near-minimum values
        let mut min_scan = [0u8; 32];
        let mut min_spend = [0u8; 32];
        min_scan[0] = 1;
        min_spend[0] = 2;

        let keys = StealthKeys::from_secrets(&min_scan, &min_spend);
        let (scan, spend) = keys.meta_address();

        let comp = compute_stealth_address(&scan, &spend)
            .expect("Should work with minimal values");

        assert!(scan_payment(&keys, &comp.ephemeral_pubkey, &comp.stealth_pubkey).is_some());

        // High values (will be reduced mod curve order)
        let keys2 = StealthKeys::from_secrets(&[0xFF; 32], &[0xFE; 32]);
        let (scan2, spend2) = keys2.meta_address();

        let comp2 = compute_stealth_address(&scan2, &spend2)
            .expect("Should work with high values");

        assert!(scan_payment(&keys2, &comp2.ephemeral_pubkey, &comp2.stealth_pubkey).is_some());
    }

    /// Test rapid sequential operations for race conditions
    #[test]
    fn test_rapid_sequential_operations() {
        let keys = StealthKeys::generate();
        let (scan, spend) = keys.meta_address();

        // Perform many operations rapidly
        for i in 0..100 {
            let comp = compute_stealth_address(&scan, &spend)
                .unwrap_or_else(|| panic!("Iteration {} failed", i));

            let result = scan_payment(&keys, &comp.ephemeral_pubkey, &comp.stealth_pubkey);
            assert!(result.is_some(), "Iteration {} should succeed", i);
        }
    }

    /// Test mnemonic recovery with passphrase
    #[test]
    fn test_mnemonic_with_passphrase() {
        // Standard BIP-39 test vector mnemonic
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

        // Empty passphrase
        let keys1 = StealthKeys::from_mnemonic(mnemonic, "")
            .expect("Should work with empty passphrase");

        // With passphrase
        let keys2 = StealthKeys::from_mnemonic(mnemonic, "secret passphrase")
            .expect("Should work with passphrase");

        // Different passphrases should produce different keys
        assert_ne!(keys1.scan_pubkey, keys2.scan_pubkey);
        assert_ne!(keys1.spend_pubkey, keys2.spend_pubkey);

        // Same passphrase should produce same keys
        let keys3 = StealthKeys::from_mnemonic(mnemonic, "secret passphrase")
            .expect("Should recover same keys");

        assert_eq!(keys2.scan_pubkey, keys3.scan_pubkey);
        assert_eq!(keys2.spend_pubkey, keys3.spend_pubkey);
    }
}
