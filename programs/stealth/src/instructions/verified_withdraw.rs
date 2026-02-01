//! Verified Withdrawal with On-Chain Groth16 Verification
//!
//! This instruction performs a privacy pool withdrawal with FULL ON-CHAIN
//! ZK proof verification using Solana's alt_bn128 precompiles.
//!
//! Unlike the oracle-based private_withdraw, this instruction:
//! - Verifies the Groth16 proof directly on-chain (~200k CUs)
//! - Does NOT require an oracle attestation
//! - Provides trustless verification
//!
//! Public Inputs (from circuit):
//! - merkleRoot: Current Merkle root of commitments
//! - nullifierHash: Hash of nullifier (prevents double-spend)
//! - recipient: Address receiving the withdrawal
//! - amount: Withdrawal amount (must match pool denomination)
//!
//! Compute Budget: ~200k CUs (vs 1.4M+ for on-chain Poseidon)

use anchor_lang::prelude::*;
use borsh::BorshDeserialize;
use crate::state::privacy_pool::{PrivacyPool, NullifierRecord, PoolConfig};
use crate::crypto::merkle::{compute_zero_hashes_poseidon, MERKLE_DEPTH, merkle_hash_2};
use crate::error::StealthError;
use crate::zk::{Groth16Proof, VerificationKey, StoredVerificationKey, verify_groth16};

/// Public inputs for the Groth16 withdrawal circuit
/// Must match exactly what the circuit expects
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct Groth16WithdrawInputs {
    /// Merkle root the proof was generated against (32 bytes, field element)
    pub merkle_root: [u8; 32],
    /// Nullifier hash (prevents double-spend)
    pub nullifier_hash: [u8; 32],
    /// Recipient address (Solana pubkey as field element)
    pub recipient: [u8; 32],
    /// Amount in lamports (as field element)
    pub amount: [u8; 32],
}

impl Groth16WithdrawInputs {
    /// Convert to array of field elements for proof verification
    /// Note: All field elements must be big-endian for alt_bn128 syscalls
    pub fn to_field_elements(&self) -> [[u8; 32]; 4] {
        // Amount is stored as LE for u64 reading, but ZK verifier needs BE
        let mut amount_be = [0u8; 32];
        // Read amount as LE u64, then convert to BE 32-byte field element
        let amount_u64 = u64::from_le_bytes(self.amount[0..8].try_into().unwrap());
        let amount_bytes = amount_u64.to_be_bytes();
        // Place in the last 8 bytes (BE format)
        amount_be[24..32].copy_from_slice(&amount_bytes);

        [
            self.merkle_root,
            self.nullifier_hash,
            self.recipient,
            amount_be,
        ]
    }

    /// Create from pubkey and amount
    pub fn new(
        merkle_root: [u8; 32],
        nullifier_hash: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Self {
        // Convert recipient pubkey to field element (32 bytes)
        let recipient_bytes = recipient.to_bytes();

        // Convert amount to field element (32 bytes, little-endian)
        let mut amount_bytes = [0u8; 32];
        amount_bytes[0..8].copy_from_slice(&amount.to_le_bytes());

        Self {
            merkle_root,
            nullifier_hash,
            recipient: recipient_bytes,
            amount: amount_bytes,
        }
    }
}

/// Accounts for verified withdrawal (on-chain Groth16 verification)
#[derive(Accounts)]
#[instruction(denomination: u64, public_inputs: Groth16WithdrawInputs)]
pub struct VerifiedWithdraw<'info> {
    /// Anyone can submit (relayer support)
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// Privacy pool PDA
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Pool config
    #[account(
        seeds = [PoolConfig::SEED, &denomination.to_le_bytes()],
        bump = config.bump,
        constraint = !config.withdrawals_paused @ StealthError::WithdrawalsPaused,
    )]
    pub config: Account<'info, PoolConfig>,

    /// Stored verification key
    #[account(
        seeds = [StoredVerificationKey::SEEDS],
        bump = verification_key.bump,
    )]
    pub verification_key: Account<'info, StoredVerificationKey>,

    /// Nullifier record (prevents double-spend)
    #[account(
        init,
        payer = relayer,
        space = NullifierRecord::SIZE,
        seeds = [NullifierRecord::SEED, &denomination.to_le_bytes(), public_inputs.nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier: Account<'info, NullifierRecord>,

    /// Recipient receiving the withdrawal
    /// CHECK: Validated below after reducing pubkey to field element
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// Optional relayer fee recipient
    /// CHECK: Relayer controls their fee recipient
    #[account(mut)]
    pub relayer_fee_recipient: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

/// Withdraw from privacy pool with on-chain Groth16 verification
///
/// # Arguments
/// * `denomination` - Pool denomination (must match proof amount)
/// * `public_inputs` - Public inputs to the circuit
/// * `proof` - Groth16 proof (A, B, C points)
/// * `relayer_fee` - Fee for relayer submitting the transaction
///
/// # Verification
/// 1. Loads verification key from on-chain account
/// 2. Verifies Groth16 proof using alt_bn128 precompiles (~200k CUs)
/// 3. Checks nullifier not used
/// 4. Verifies Merkle root is valid
/// 5. Transfers funds to recipient
#[inline(never)]
pub fn verified_withdraw(
    ctx: Context<VerifiedWithdraw>,
    denomination: u64,
    public_inputs: Groth16WithdrawInputs,
    proof: Groth16Proof,
    relayer_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    // 1. Load and deserialize verification key
    let vk = load_vk(&ctx.accounts.verification_key.vk_data)?;
    msg!("Loaded verification key with {} IC points", vk.ic.len());

    // 2. Verify pool is active and amount matches denomination
    let amount = {
        let pool = ctx.accounts.pool.load()?;
        require!(pool.is_active, StealthError::PoolNotActive);
        require!(
            pool.denomination == denomination,
            StealthError::AmountMustMatchDenomination
        );
        require!(
            pool.is_valid_root(&public_inputs.merkle_root),
            StealthError::InvalidMerkleRoot
        );
        pool.denomination
    };

    // Verify amount in proof matches denomination
    let proof_amount = u64::from_le_bytes(public_inputs.amount[0..8].try_into().unwrap());
    require!(
        proof_amount == denomination,
        StealthError::AmountMustMatchDenomination
    );

    // Validate recipient: verify that the public input is the correct field reduction
    // of the recipient account's pubkey. This ensures the ZK proof was generated for
    // this specific recipient.
    let recipient_pubkey_bytes = ctx.accounts.recipient.key().to_bytes();

    // Debug: print pubkey and input for comparison
    msg!("Raw pubkey[0..4]: {:02x}{:02x}{:02x}{:02x}",
        recipient_pubkey_bytes[0], recipient_pubkey_bytes[1],
        recipient_pubkey_bytes[2], recipient_pubkey_bytes[3]);
    msg!("Input[0..4]: {:02x}{:02x}{:02x}{:02x}",
        public_inputs.recipient[0], public_inputs.recipient[1],
        public_inputs.recipient[2], public_inputs.recipient[3]);

    // Verify that public_inputs.recipient is the correct reduction of the pubkey mod field
    let recipient_valid = verify_field_reduction(&recipient_pubkey_bytes, &public_inputs.recipient);
    msg!("Recipient field reduction valid: {}", recipient_valid);

    require!(
        recipient_valid,
        StealthError::InvalidRecipient
    );

    // 3. Verify Groth16 proof on-chain
    msg!("Verifying Groth16 proof on-chain...");
    let field_elements = public_inputs.to_field_elements();
    let field_refs: Vec<[u8; 32]> = field_elements.to_vec();

    let is_valid = verify_groth16(&proof, &field_refs, &vk)?;
    require!(is_valid, StealthError::InvalidProof);
    msg!("Groth16 proof verified successfully!");

    // 4. Mark nullifier as used
    mark_nullifier_used(
        &mut ctx.accounts.nullifier,
        &public_inputs.nullifier_hash,
        clock.unix_timestamp,
        ctx.bumps.nullifier,
    );

    // 5. Transfer funds
    transfer_withdrawal(
        &ctx.accounts.pool,
        &ctx.accounts.recipient,
        &ctx.accounts.relayer,
        ctx.accounts.relayer_fee_recipient.as_ref(),
        amount,
        relayer_fee,
    )?;

    // 6. Update pool stats
    {
        let mut pool = ctx.accounts.pool.load_mut()?;
        pool.total_withdrawn = pool.total_withdrawn
            .checked_add(amount)
            .ok_or(StealthError::ArithmeticOverflow)?;
        pool.withdrawal_count = pool.withdrawal_count
            .checked_add(1)
            .ok_or(StealthError::ArithmeticOverflow)?;
    }

    msg!("Verified withdrawal complete");
    msg!("Amount: {} lamports", amount);
    msg!("Recipient: {}", ctx.accounts.recipient.key());

    Ok(())
}

/// Load verification key from stored bytes
#[inline(never)]
fn load_vk(vk_data: &[u8]) -> Result<VerificationKey> {
    VerificationKey::try_from_slice(vk_data)
        .map_err(|_| error!(StealthError::DeserializationError))
}

/// Mark nullifier as used
#[inline(never)]
fn mark_nullifier_used(
    nullifier: &mut NullifierRecord,
    hash: &[u8; 32],
    timestamp: i64,
    bump: u8,
) {
    nullifier.nullifier_hash = *hash;
    nullifier.spent_at = timestamp;
    nullifier.bump = bump;
}

/// Transfer withdrawal funds
#[inline(never)]
fn transfer_withdrawal<'info>(
    pool: &AccountLoader<'info, PrivacyPool>,
    recipient: &AccountInfo<'info>,
    relayer: &Signer<'info>,
    relayer_fee_recipient: Option<&AccountInfo<'info>>,
    amount: u64,
    relayer_fee: u64,
) -> Result<()> {
    let amount_after_fee = amount.saturating_sub(relayer_fee);

    // Validate pool balance
    let pool_balance = pool.to_account_info().lamports();
    require!(
        pool_balance >= amount,
        StealthError::InsufficientPoolBalance
    );

    // Transfer to recipient
    **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
    **recipient.try_borrow_mut_lamports()? += amount_after_fee;

    // Pay relayer fee
    if relayer_fee > 0 {
        if let Some(fee_recipient) = relayer_fee_recipient {
            **fee_recipient.try_borrow_mut_lamports()? += relayer_fee;
        } else {
            **relayer.try_borrow_mut_lamports()? += relayer_fee;
        }
    }

    Ok(())
}

/// Verify that `reduced` is the correct reduction of `pubkey` modulo the BN254 scalar field
/// r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
///
/// Instead of computing pubkey mod r (which is error-prone), we verify:
/// - reduced < r (it's a valid field element)
/// - pubkey - reduced is a multiple of r (i.e., pubkey ≡ reduced (mod r))
///
/// Since pubkey < 2^256 and r ≈ 2^254, we have pubkey - reduced < 12*r,
/// so we just need to check if (pubkey - reduced) / r is an integer in [0, 11].
#[inline(never)]
fn verify_field_reduction(pubkey: &[u8; 32], reduced: &[u8; 32]) -> bool {
    // BN254 SCALAR FIELD modulus r split into two u128 parts (big-endian)
    // r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
    // r = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
    // NOTE: This is the SCALAR field (Fr), NOT the base field (Fq)!
    const MOD_HIGH: u128 = 0x30644e72e131a029_b85045b68181585d;
    const MOD_LOW: u128 = 0x2833e84879b97091_43e1f593f0000001;

    // Convert inputs to (high, low) u128 pairs
    let pk_high = u128::from_be_bytes(pubkey[0..16].try_into().unwrap());
    let pk_low = u128::from_be_bytes(pubkey[16..32].try_into().unwrap());
    let rd_high = u128::from_be_bytes(reduced[0..16].try_into().unwrap());
    let rd_low = u128::from_be_bytes(reduced[16..32].try_into().unwrap());

    // Debug: print all parts
    msg!("pk_high: {:x}", pk_high);
    msg!("pk_low: {:x}", pk_low);
    msg!("rd_high: {:x}", rd_high);
    msg!("rd_low: {:x}", rd_low);

    // Check that reduced < modulus (it's a valid field element)
    let reduced_valid = if rd_high < MOD_HIGH {
        true
    } else if rd_high > MOD_HIGH {
        false
    } else {
        rd_low < MOD_LOW
    };
    msg!("reduced_valid: {}", reduced_valid);
    if !reduced_valid {
        return false;
    }

    // Check that pubkey >= reduced
    let pubkey_ge_reduced = if pk_high > rd_high {
        true
    } else if pk_high < rd_high {
        false
    } else {
        pk_low >= rd_low
    };
    msg!("pubkey_ge_reduced: {}", pubkey_ge_reduced);
    if !pubkey_ge_reduced {
        return false;
    }

    // Compute diff = pubkey - reduced
    let (diff_low, borrow) = pk_low.overflowing_sub(rd_low);
    let diff_high = pk_high.wrapping_sub(rd_high).wrapping_sub(if borrow { 1 } else { 0 });
    msg!("diff_high: {:x}, diff_low: {:x}", diff_high, diff_low);

    // Check if diff is a multiple of the modulus (diff = k * modulus for some k in [0, 11])
    // We do this by checking if diff == 0, modulus, 2*modulus, ..., 11*modulus
    let mut mult_high = 0u128;
    let mut mult_low = 0u128;

    for k in 0..12u32 {
        // Debug: print mult values for first few iterations and k=5
        if k <= 2 || k == 5 {
            msg!("k={}: mult_high={:x}, mult_low={:x}", k, mult_high, mult_low);
        }
        if diff_high == mult_high && diff_low == mult_low {
            msg!("Match at k={}", k);
            return true;
        }
        // Add modulus for next iteration
        let (new_low, carry) = mult_low.overflowing_add(MOD_LOW);
        mult_high = mult_high.wrapping_add(MOD_HIGH).wrapping_add(if carry { 1 } else { 0 });
        mult_low = new_low;
    }

    // Print what k=5 would be if computed
    msg!("After loop: mult_high={:x} (this is 12*mod)", mult_high);
    msg!("No match found after 12 iterations");
    false
}
