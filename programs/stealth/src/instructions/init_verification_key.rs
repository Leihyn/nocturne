//! Initialize Verification Key Instruction
//!
//! Stores the Groth16 verification key on-chain for trustless ZK proof verification.
//! This should be called once during program initialization with the VK generated
//! from the trusted setup ceremony.
//!
//! The verification key is stored in a PDA and used by the withdraw instruction
//! to verify proofs on-chain without needing an oracle.

use anchor_lang::prelude::*;
use borsh::BorshDeserialize;
use crate::error::StealthError;
use crate::zk::types::{VerificationKey, StoredVerificationKey};

/// Maximum size for verification key data
/// This accommodates VKs with up to 10 IC points
const MAX_VK_DATA_SIZE: usize = 2048;

/// Accounts for initialize_verification_key instruction
#[derive(Accounts)]
pub struct InitializeVerificationKey<'info> {
    /// Authority that can initialize the VK (program deployer)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The verification key account (PDA)
    /// Uses a simple seed without circuit_id for simplicity
    #[account(
        init,
        payer = authority,
        space = 8 + StoredVerificationKey::space(MAX_VK_DATA_SIZE),
        seeds = [StoredVerificationKey::SEEDS],
        bump
    )]
    pub verification_key: Account<'info, StoredVerificationKey>,

    pub system_program: Program<'info, System>,
}

/// Initialize a verification key
///
/// # Arguments
/// * `ctx` - The instruction context
/// * `vk_data` - Serialized verification key bytes
pub fn initialize_verification_key(
    ctx: Context<InitializeVerificationKey>,
    vk_data: Vec<u8>,
) -> Result<()> {
    require!(
        vk_data.len() <= MAX_VK_DATA_SIZE,
        StealthError::VerificationKeyTooLarge
    );

    // Validate that the data is a valid VerificationKey
    let _vk: VerificationKey = VerificationKey::try_from_slice(&vk_data)
        .map_err(|_| StealthError::DeserializationError)?;

    let vk_account = &mut ctx.accounts.verification_key;

    // Store authority
    vk_account.authority = ctx.accounts.authority.key();
    vk_account.vk_data = vk_data;
    vk_account.bump = ctx.bumps.verification_key;

    msg!("Verification key initialized");

    Ok(())
}

/// Accounts for updating a verification key
#[derive(Accounts)]
pub struct UpdateVerificationKey<'info> {
    /// Authority that can update the VK (must match stored authority)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The verification key account
    #[account(
        mut,
        seeds = [StoredVerificationKey::SEEDS],
        bump = verification_key.bump,
        constraint = verification_key.authority == authority.key() @ StealthError::Unauthorized
    )]
    pub verification_key: Account<'info, StoredVerificationKey>,
}

/// Update an existing verification key
/// Only the original authority can update
pub fn update_verification_key(
    ctx: Context<UpdateVerificationKey>,
    vk_data: Vec<u8>,
) -> Result<()> {
    require!(
        vk_data.len() <= MAX_VK_DATA_SIZE,
        StealthError::VerificationKeyTooLarge
    );

    // Validate that the data is a valid VerificationKey
    let _vk: VerificationKey = VerificationKey::try_from_slice(&vk_data)
        .map_err(|_| StealthError::DeserializationError)?;

    let vk_account = &mut ctx.accounts.verification_key;
    vk_account.vk_data = vk_data;

    msg!("Verification key updated");

    Ok(())
}

/// Load verification key from account
pub fn load_verification_key(vk_data: &[u8]) -> Result<VerificationKey> {
    VerificationKey::try_from_slice(vk_data)
        .map_err(|_| error!(StealthError::DeserializationError))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zk::{G1_SIZE, G2_SIZE};

    #[test]
    fn test_vk_data_size() {
        // Verify size calculation for a VK with 10 IC points
        // VK structure: alpha (G1) + beta/gamma/delta (G2*3) + IC points (G1*n)
        let max_ic_points = 10;
        let expected = G1_SIZE + G2_SIZE * 3 + G1_SIZE * max_ic_points;
        assert_eq!(expected, 64 + 128 * 3 + 64 * 10); // 1088 bytes
        assert!(expected <= MAX_VK_DATA_SIZE); // Must fit in allocated space
    }
}
