//! Unit tests for StealthSol on-chain program
//!
//! These tests verify the program logic without requiring BPF compilation.

#[cfg(test)]
mod unit_tests {
    use crate::crypto::keys::{validate_curve_point, StealthMetaAddress};
    use crate::crypto::dksap::{verify_stealth_structure, DOMAIN_SEPARATOR};
    use crate::state::{StealthRegistry, StealthAnnouncement};

    // ==================== Key Validation Tests ====================

    #[test]
    fn test_validate_curve_point_valid() {
        // Valid point (non-zero, non-all-ones)
        let mut valid_point = [0u8; 32];
        valid_point[0] = 0x42;
        valid_point[10] = 0xAB;
        valid_point[20] = 0xCD;

        assert!(validate_curve_point(&valid_point));
    }

    #[test]
    fn test_validate_curve_point_all_zeros_invalid() {
        let zero_point = [0u8; 32];
        assert!(!validate_curve_point(&zero_point));
    }

    #[test]
    fn test_validate_curve_point_all_ones_invalid() {
        let ones_point = [0xFF; 32];
        assert!(!validate_curve_point(&ones_point));
    }

    #[test]
    fn test_validate_curve_point_order_2_invalid() {
        // Point of order 2 (small subgroup attack)
        let order_2: [u8; 32] = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
        ];
        assert!(!validate_curve_point(&order_2));
    }

    #[test]
    fn test_validate_curve_point_order_4_invalid() {
        // Point (1, 0) - order 4
        let order_4: [u8; 32] = [
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        assert!(!validate_curve_point(&order_4));
    }

    #[test]
    fn test_validate_curve_point_near_prime_invalid() {
        // Value equal to field prime should be invalid
        let at_prime: [u8; 32] = [
            0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
        ];
        assert!(!validate_curve_point(&at_prime));
    }

    #[test]
    fn test_validate_curve_point_random_valid() {
        // Random valid-looking points
        let point1: [u8; 32] = [
            0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
            0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10,
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
            0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00,
        ];
        assert!(validate_curve_point(&point1));

        let point2: [u8; 32] = [
            0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE,
            0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0,
            0x0F, 0xED, 0xCB, 0xA9, 0x87, 0x65, 0x43, 0x21,
            0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x00,
        ];
        assert!(validate_curve_point(&point2));
    }

    // ==================== StealthMetaAddress Tests ====================

    #[test]
    fn test_meta_address_creation_valid() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];

        let meta = StealthMetaAddress::new(scan, spend);
        assert!(meta.is_some());

        let meta = meta.unwrap();
        assert_eq!(meta.scan_pubkey, scan);
        assert_eq!(meta.spend_pubkey, spend);
    }

    #[test]
    fn test_meta_address_creation_invalid_scan() {
        let scan = [0u8; 32]; // Invalid: all zeros
        let spend = [0x43u8; 32];

        let meta = StealthMetaAddress::new(scan, spend);
        assert!(meta.is_none());
    }

    #[test]
    fn test_meta_address_creation_invalid_spend() {
        let scan = [0x42u8; 32];
        let spend = [0u8; 32]; // Invalid: all zeros

        let meta = StealthMetaAddress::new(scan, spend);
        assert!(meta.is_none());
    }

    #[test]
    fn test_meta_address_to_bytes_roundtrip() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];

        let meta = StealthMetaAddress::new(scan, spend).unwrap();
        let bytes = meta.to_bytes();

        assert_eq!(bytes.len(), 64);
        assert_eq!(&bytes[..32], &scan);
        assert_eq!(&bytes[32..], &spend);

        let restored = StealthMetaAddress::from_bytes(&bytes).unwrap();
        assert_eq!(restored.scan_pubkey, scan);
        assert_eq!(restored.spend_pubkey, spend);
    }

    // ==================== DKSAP Verification Tests ====================

    #[test]
    fn test_verify_stealth_structure_valid() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];
        let ephemeral = [0x44u8; 32];
        let claimed_stealth = [0x45u8; 32];

        let meta = StealthMetaAddress::new(scan, spend).unwrap();

        assert!(verify_stealth_structure(&meta, &ephemeral, &claimed_stealth));
    }

    #[test]
    fn test_verify_stealth_structure_invalid_ephemeral() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];
        let ephemeral = [0u8; 32]; // Invalid: all zeros
        let claimed_stealth = [0x45u8; 32];

        let meta = StealthMetaAddress::new(scan, spend).unwrap();

        assert!(!verify_stealth_structure(&meta, &ephemeral, &claimed_stealth));
    }

    #[test]
    fn test_domain_separator() {
        assert_eq!(DOMAIN_SEPARATOR, b"stealthsol_v1");
    }

    // ==================== State Account Size Tests ====================

    #[test]
    fn test_stealth_registry_size() {
        // Verify the constant matches actual struct size
        // Struct has been expanded with additional fields
        assert_eq!(StealthRegistry::SIZE, 210);
    }

    #[test]
    fn test_stealth_announcement_size() {
        // 8 (discriminator) + 32 (ephemeral) + 32 (stealth_addr) + 32 (commitment) + 8 (amount) + 32 (token_mint) + 8 (slot) + 8 (timestamp) + 1 (bump) = 161
        assert_eq!(StealthAnnouncement::SIZE, 161);
    }

    #[test]
    fn test_registry_seed() {
        assert_eq!(StealthRegistry::SEED, b"stealth_registry");
    }

    #[test]
    fn test_announcement_seed() {
        assert_eq!(StealthAnnouncement::SEED, b"announcement");
    }

    // ==================== Edge Case Tests ====================

    #[test]
    fn test_single_byte_difference() {
        // Point with only one byte non-zero
        let mut point = [0u8; 32];
        point[15] = 0x01;
        assert!(validate_curve_point(&point));
    }

    #[test]
    fn test_high_bit_variations() {
        // Test with high bit set (valid Edwards Y coordinate can have high bit)
        let mut point = [0u8; 32];
        point[0] = 0x01;
        point[31] = 0x80; // High bit set
        assert!(validate_curve_point(&point));

        // Test with all high bits except not all 0xFF
        let mut point2 = [0xFE; 32];
        point2[0] = 0xFD;
        assert!(validate_curve_point(&point2));
    }

    #[test]
    fn test_meta_address_equality() {
        let scan = [0x42u8; 32];
        let spend = [0x43u8; 32];

        let meta1 = StealthMetaAddress::new(scan, spend).unwrap();
        let meta2 = StealthMetaAddress::new(scan, spend).unwrap();

        assert_eq!(meta1, meta2);
    }

    #[test]
    fn test_meta_address_inequality() {
        let scan1 = [0x42u8; 32];
        let scan2 = [0x44u8; 32];
        let spend = [0x43u8; 32];

        let meta1 = StealthMetaAddress::new(scan1, spend).unwrap();
        let meta2 = StealthMetaAddress::new(scan2, spend).unwrap();

        assert_ne!(meta1, meta2);
    }
}
