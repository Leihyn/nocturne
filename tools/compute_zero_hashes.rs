//! Tool to compute real Poseidon zero hashes for the Merkle tree
//! Run with: cargo run --release

use light_poseidon::{Poseidon, PoseidonHasher};
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};

fn main() {
    const MERKLE_DEPTH: usize = 20;
    
    println!("pub static ZERO_HASHES: [[u8; 32]; {}] = [", MERKLE_DEPTH + 1);
    println!("    // Level 0: Zero value (empty leaf)");
    
    // Level 0: Zero value (empty leaf)
    let zero = [0u8; 32];
    print_bytes(&zero);
    
    // Compute each level: h[i] = Poseidon(h[i-1], h[i-1])
    let mut current = Fr::from_be_bytes_mod_order(&zero);
    
    for level in 1..=MERKLE_DEPTH {
        // Create a fresh hasher for 2 inputs (t=3)
        let mut hasher = Poseidon::<Fr>::new_circom(2).unwrap();
        let hash = hasher.hash(&[current, current]).unwrap();
        
        let mut bytes = [0u8; 32];
        let repr = hash.into_bigint().to_bytes_le();
        bytes.copy_from_slice(&repr[..32]);
        
        println!("    // Level {}: Poseidon(level{}, level{})", level, level-1, level-1);
        print_bytes(&bytes);
        
        current = hash;
    }
    
    println!("];");
}

fn print_bytes(bytes: &[u8; 32]) {
    print!("    [");
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && i % 16 == 0 {
            print!("\n     ");
        }
        print!("0x{:02x}", b);
        if i < 31 {
            print!(", ");
        }
    }
    println!("],");
}
