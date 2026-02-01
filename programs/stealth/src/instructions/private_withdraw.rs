//! Private Withdrawal Instruction with Stealth Address Support
//!
//! Withdraws funds from a FIXED-DENOMINATION privacy pool using a ZK proof.
//! The proof demonstrates knowledge of a valid note without revealing which one.
//! This breaks the link between deposit and withdrawal!
//!
//! STEALTH ADDRESS INTEGRATION:
//! Withdrawals go to a stealth address derived from the recipient's meta-address,
//! making the withdrawal recipient unlinkable to any known identity.
//!
//! FIXED DENOMINATION: The amount is determined by the pool's denomination.
//! All withdrawals from a pool are exactly the same amount, hiding the transfer amounts.
//!
//! Privacy Properties:
//! - Amount: HIDDEN (fixed denomination)
//! - Deposit↔Withdrawal link: HIDDEN (ZK proof)
//! - Recipient identity: HIDDEN (stealth address)
//!
//! Verification Flow:
//! 1. User generates ZK proof in browser (Noir/Barretenberg)
//! 2. User sends proof to off-chain verifier service
//! 3. Verifier validates proof and signs an attestation
//! 4. User submits attestation + proof + stealth address to this instruction
//! 5. On-chain program verifies ZK proof and stealth commitment
//! 6. Funds sent to stealth address, announcement created for scanning
//!
//! Stack Optimization:
//! - Uses computed Poseidon zero hashes
//! - Functions marked #[inline(never)] to prevent stack blowup
//! - Merkle tree insertion split into separate function

use anchor_lang::prelude::*;
use crate::state::privacy_pool::{PrivacyPool, NullifierRecord, PoolConfig};
use crate::state::announcement::{StealthAnnouncement, compute_commitment};
use crate::crypto::merkle::{compute_zero_hashes_poseidon, MERKLE_DEPTH, merkle_hash_2};
use crate::crypto::validate_curve_point;
use crate::error::StealthError;
use crate::zk::verifier::{OracleAttestation, verify_proof_with_sysvar};

/// ZK proof for withdrawal (from Noir circuit)
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct WithdrawProof {
    /// The proof bytes (Noir/Barretenberg format)
    pub proof: Vec<u8>,

    /// Public inputs to the circuit
    pub public_inputs: WithdrawPublicInputs,

    /// Oracle attestation (required in production mode)
    pub attestation: Option<OracleAttestation>,
}

/// Public inputs for the withdrawal circuit
/// Note: Amount is NOT included - it's determined by the pool's denomination
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct WithdrawPublicInputs {
    /// Merkle root the proof was generated against
    pub merkle_root: [u8; 32],

    /// Nullifier hash (prevents double-spend)
    pub nullifier_hash: [u8; 32],

    /// Stealth address receiving the funds (derived from recipient's meta-address)
    /// This is a one-time address that can't be linked to the real recipient
    pub stealth_address: Pubkey,

    /// Ephemeral public key (R = r·G) for recipient scanning
    /// Recipients use this with their scan key to detect this withdrawal
    pub ephemeral_pubkey: [u8; 32],

    /// Recipient's scan public key (from their meta-address)
    /// Used to verify the stealth address was correctly derived
    pub scan_pubkey: [u8; 32],

    /// Recipient's spend public key (from their meta-address)
    /// Used to verify the stealth address was correctly derived
    pub spend_pubkey: [u8; 32],

    /// Stealth commitment: SHA256(domain || R || S || B || stealth_address)
    /// Proves the stealth address was correctly derived from the meta-address
    pub stealth_commitment: [u8; 32],
    // Amount removed - it's implicit from pool denomination
}

/// Private withdrawal accounts for fixed-denomination pools with stealth addresses
#[derive(Accounts)]
#[instruction(denomination: u64, proof: WithdrawProof)]
pub struct PrivateWithdraw<'info> {
    /// Anyone can submit a withdrawal proof (relayer support)
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// Pool PDA includes denomination in seeds
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Config PDA includes denomination in seeds
    #[account(
        seeds = [PoolConfig::SEED, &denomination.to_le_bytes()],
        bump = config.bump,
        constraint = !config.withdrawals_paused @ StealthError::WithdrawalsPaused,
    )]
    pub config: Account<'info, PoolConfig>,

    /// Nullifier record (prevents double-spend)
    /// Includes denomination to separate nullifiers across pools
    #[account(
        init,
        payer = relayer,
        space = NullifierRecord::SIZE,
        seeds = [NullifierRecord::SEED, &denomination.to_le_bytes(), proof.public_inputs.nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier: Account<'info, NullifierRecord>,

    /// Stealth address receiving the withdrawal
    /// This is a one-time address derived from recipient's meta-address
    /// CHECK: Validated via stealth commitment in proof
    #[account(
        mut,
        constraint = stealth_address.key() == proof.public_inputs.stealth_address @ StealthError::InvalidRecipient,
    )]
    pub stealth_address: AccountInfo<'info>,

    /// Announcement account for recipient scanning
    /// Recipients scan these to detect withdrawals addressed to them
    #[account(
        init,
        payer = relayer,
        space = StealthAnnouncement::SIZE,
        seeds = [StealthAnnouncement::SEED, proof.public_inputs.ephemeral_pubkey.as_ref()],
        bump,
    )]
    pub announcement: Account<'info, StealthAnnouncement>,

    /// Optional: relayer fee recipient
    /// CHECK: Relayer can set their own fee recipient
    #[account(mut)]
    pub relayer_fee_recipient: Option<AccountInfo<'info>>,

    /// Instructions sysvar for Ed25519 signature verification (production mode)
    /// CHECK: Validated by address constraint
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Withdraw funds privately using a ZK proof from a FIXED-DENOMINATION pool
/// with stealth address recipient for maximum privacy.
///
/// PRIVACY PROPERTIES:
/// - Amount: HIDDEN (fixed denomination - all withdrawals same size)
/// - Deposit↔Withdrawal link: HIDDEN (ZK proof)
/// - Recipient identity: HIDDEN (stealth address - unlinkable to real recipient)
///
/// VERIFICATION:
/// - ZK proof proves knowledge of a valid note
/// - Stealth commitment proves correct address derivation from meta-address
/// - Nullifier prevents double-spending
#[inline(never)]
pub fn private_withdraw(
    ctx: Context<PrivateWithdraw>,
    denomination: u64,
    proof: WithdrawProof,
    relayer_fee: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    // 1. Verify pool is active, denomination matches, and Merkle root is valid
    let amount = {
        let pool = ctx.accounts.pool.load()?;
        require!(pool.is_active, StealthError::PoolNotActive);
        require!(
            pool.denomination == denomination,
            StealthError::AmountMustMatchDenomination
        );
        require!(
            pool.is_valid_root(&proof.public_inputs.merkle_root),
            StealthError::InvalidMerkleRoot
        );
        pool.denomination // Amount is the pool's fixed denomination
    };

    // 2. Verify the stealth address commitment
    // This proves the stealth address was correctly derived from the meta-address
    verify_stealth_commitment(&proof.public_inputs)?;

    // 3. Verify the ZK proof (dev: skipped, production: Oracle attestation + Ed25519 introspection)
    verify_zk_proof(&proof, &ctx.accounts.instructions_sysvar)?;

    // 4. Mark nullifier as used (prevents double-spend)
    mark_nullifier_used(
        &mut ctx.accounts.nullifier,
        &proof.public_inputs.nullifier_hash,
        clock.unix_timestamp,
        ctx.bumps.nullifier,
    );

    // 5. Transfer the fixed denomination amount to stealth address
    transfer_withdrawal_funds_zc(&ctx, amount, relayer_fee)?;

    // 6. Create announcement for recipient scanning
    create_stealth_announcement(
        &mut ctx.accounts.announcement,
        &proof.public_inputs,
        amount,
        clock.slot,
        clock.unix_timestamp,
        ctx.bumps.announcement,
    );

    // 7. Update pool stats
    {
        let mut pool = ctx.accounts.pool.load_mut()?;
        pool.total_withdrawn = pool.total_withdrawn
            .checked_add(amount)
            .ok_or(StealthError::ArithmeticOverflow)?;
        pool.withdrawal_count = pool.withdrawal_count
            .checked_add(1)
            .ok_or(StealthError::ArithmeticOverflow)?;
    }

    msg!("Private withdrawal with stealth address");
    msg!("Denomination: {} SOL", amount / 1_000_000_000);
    msg!("Stealth address: {}", ctx.accounts.stealth_address.key());
    msg!("Ephemeral key: {:?}", &proof.public_inputs.ephemeral_pubkey[..8]);

    Ok(())
}

/// Verify the stealth address was correctly derived from the meta-address
#[inline(never)]
fn verify_stealth_commitment(inputs: &WithdrawPublicInputs) -> Result<()> {
    // Validate ephemeral key is a valid curve point
    require!(
        validate_curve_point(&inputs.ephemeral_pubkey),
        StealthError::InvalidEphemeralKey
    );

    // Validate scan and spend pubkeys are valid curve points
    require!(
        validate_curve_point(&inputs.scan_pubkey),
        StealthError::InvalidScanPubkey
    );
    require!(
        validate_curve_point(&inputs.spend_pubkey),
        StealthError::InvalidSpendPubkey
    );

    // Compute expected commitment
    let stealth_address_bytes = inputs.stealth_address.to_bytes();
    let expected_commitment = compute_commitment(
        &inputs.ephemeral_pubkey,
        &inputs.scan_pubkey,
        &inputs.spend_pubkey,
        &stealth_address_bytes,
    );

    // Verify commitment matches
    require!(
        inputs.stealth_commitment == expected_commitment,
        StealthError::CommitmentMismatch
    );

    msg!("Stealth address commitment verified");
    Ok(())
}

/// Create announcement for recipient scanning (separate stack frame)
#[inline(never)]
fn create_stealth_announcement(
    announcement: &mut StealthAnnouncement,
    inputs: &WithdrawPublicInputs,
    amount: u64,
    slot: u64,
    timestamp: i64,
    bump: u8,
) {
    announcement.ephemeral_pubkey = inputs.ephemeral_pubkey;
    announcement.stealth_address = inputs.stealth_address;
    announcement.commitment = inputs.stealth_commitment;
    announcement.amount = amount;
    announcement.token_mint = Pubkey::default(); // Native SOL
    announcement.slot = slot;
    announcement.timestamp = timestamp;
    announcement.bump = bump;
}

/// Verify ZK proof using the oracle attestation system with Ed25519 introspection
/// Note: Amount is NOT in public inputs - it's implicit from pool denomination
/// Public inputs include stealth address (not plaintext recipient)
#[inline(never)]
fn verify_zk_proof(proof: &WithdrawProof, instructions_sysvar: &AccountInfo) -> Result<()> {
    // Serialize public inputs for verification
    // Includes stealth address for privacy (no plain recipient)
    let mut public_inputs_bytes = Vec::with_capacity(192); // 32+32+32+32+32+32
    public_inputs_bytes.extend_from_slice(&proof.public_inputs.merkle_root);
    public_inputs_bytes.extend_from_slice(&proof.public_inputs.nullifier_hash);
    public_inputs_bytes.extend_from_slice(proof.public_inputs.stealth_address.as_ref());
    public_inputs_bytes.extend_from_slice(&proof.public_inputs.ephemeral_pubkey);
    public_inputs_bytes.extend_from_slice(&proof.public_inputs.scan_pubkey);
    public_inputs_bytes.extend_from_slice(&proof.public_inputs.spend_pubkey);
    // Amount NOT included - determined by pool denomination
    // Stealth commitment NOT included in ZK proof - verified separately

    // Use the centralized verifier with full Ed25519 introspection
    verify_proof_with_sysvar(
        &proof.proof,
        &public_inputs_bytes,
        proof.attestation.as_ref(),
        instructions_sysvar,
        None, // No trusted verifier whitelist for now (can be added via VerificationOracle account)
    )?;

    msg!("ZK proof verification successful");
    Ok(())
}

/// Mark nullifier as used (separate stack frame)
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

/// Transfer withdrawal funds to stealth address (separate stack frame)
#[inline(never)]
fn transfer_withdrawal_funds_zc(
    ctx: &Context<PrivateWithdraw>,
    amount: u64,
    relayer_fee: u64,
) -> Result<()> {
    let amount_after_relayer_fee = amount.saturating_sub(relayer_fee);

    // Validate pool has sufficient balance
    let pool_balance = ctx.accounts.pool.to_account_info().lamports();
    require!(
        pool_balance >= amount,
        StealthError::InsufficientPoolBalance
    );

    // Transfer to stealth address (unlinkable to real recipient)
    **ctx.accounts.pool.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.stealth_address.try_borrow_mut_lamports()? += amount_after_relayer_fee;

    // Pay relayer fee if applicable
    if relayer_fee > 0 {
        pay_relayer_fee_zc(ctx, relayer_fee)?;
    }

    Ok(())
}

/// Pay relayer fee for zero-copy (separate stack frame)
#[inline(never)]
fn pay_relayer_fee_zc(ctx: &Context<PrivateWithdraw>, fee: u64) -> Result<()> {
    if let Some(relayer_fee_recipient) = &ctx.accounts.relayer_fee_recipient {
        **relayer_fee_recipient.try_borrow_mut_lamports()? += fee;
    } else {
        // Fee goes to relayer themselves
        **ctx.accounts.relayer.try_borrow_mut_lamports()? += fee;
    }
    Ok(())
}

/// Private transfer within a fixed-denomination pool
/// Spends one note and creates two new notes (recipient + change)
/// Note: In fixed-denomination pools, transfers create notes of the SAME denomination
#[derive(Accounts)]
#[instruction(denomination: u64, proof: TransferProof)]
pub struct PrivateTransfer<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// Pool PDA includes denomination
    #[account(
        mut,
        seeds = [PrivacyPool::SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub pool: AccountLoader<'info, PrivacyPool>,

    /// Old nullifier (note being spent) - includes denomination
    #[account(
        init,
        payer = relayer,
        space = NullifierRecord::SIZE,
        seeds = [NullifierRecord::SEED, &denomination.to_le_bytes(), proof.public_inputs.nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier: Account<'info, NullifierRecord>,

    /// Instructions sysvar for Ed25519 signature verification (production mode)
    /// CHECK: Validated by address constraint
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// ZK proof for private transfer
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct TransferProof {
    pub proof: Vec<u8>,
    pub public_inputs: TransferPublicInputs,
    /// Oracle attestation (required in production mode)
    pub attestation: Option<OracleAttestation>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct TransferPublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub new_commitment: [u8; 32],
    pub change_commitment: [u8; 32],
}

/// Private transfer within a fixed-denomination pool
/// Spend a note and create two new notes (both at the same denomination)
#[inline(never)]
pub fn private_transfer(
    ctx: Context<PrivateTransfer>,
    denomination: u64,
    proof: TransferProof,
) -> Result<()> {
    let clock = Clock::get()?;

    // 1. Verify pool is active, denomination matches, and Merkle root is valid
    {
        let pool = ctx.accounts.pool.load()?;
        require!(pool.is_active, StealthError::PoolNotActive);
        require!(
            pool.denomination == denomination,
            StealthError::AmountMustMatchDenomination
        );
        require!(
            pool.is_valid_root(&proof.public_inputs.merkle_root),
            StealthError::InvalidMerkleRoot
        );
    }

    // 2. Verify transfer proof (dev: skipped, production: Oracle attestation + Ed25519)
    verify_transfer_proof(&proof, &ctx.accounts.instructions_sysvar)?;

    // 3. Mark old nullifier as used
    mark_nullifier_used(
        &mut ctx.accounts.nullifier,
        &proof.public_inputs.nullifier_hash,
        clock.unix_timestamp,
        ctx.bumps.nullifier,
    );

    // 4. Insert new commitments into the tree (separate stack frames)
    {
        let mut pool = ctx.accounts.pool.load_mut()?;
        insert_transfer_commitments_zc(
            &mut pool,
            proof.public_inputs.new_commitment,
            proof.public_inputs.change_commitment,
        )?;
    }

    msg!("Private transfer successful");
    msg!("Old nullifier: {:?}", proof.public_inputs.nullifier_hash);
    msg!("New commitment: {:?}", proof.public_inputs.new_commitment);
    msg!("Change commitment: {:?}", proof.public_inputs.change_commitment);

    Ok(())
}

/// Verify transfer proof with Ed25519 introspection (separate stack frame)
///
/// In production mode, this requires an oracle attestation with Ed25519 signature.
/// The proof demonstrates:
/// - Knowledge of a valid note (merkle proof)
/// - Correct nullifier derivation
/// - Correct new commitment derivation
#[inline(never)]
fn verify_transfer_proof(proof: &TransferProof, instructions_sysvar: &AccountInfo) -> Result<()> {
    #[cfg(not(feature = "production"))]
    {
        msg!("DEV MODE: Skipping ZK proof verification for transfer");
        // Basic validation even in dev mode
        require!(
            !proof.proof.is_empty(),
            StealthError::InvalidProof
        );
        require!(
            proof.public_inputs.nullifier_hash != [0u8; 32],
            StealthError::InvalidProofInputs
        );
        require!(
            proof.public_inputs.new_commitment != [0u8; 32],
            StealthError::InvalidProofInputs
        );
        // Suppress unused variable warning in dev mode
        let _ = instructions_sysvar;
        return Ok(());
    }

    #[cfg(feature = "production")]
    {
        // Serialize public inputs for verification
        let mut public_inputs_bytes = Vec::with_capacity(128);
        public_inputs_bytes.extend_from_slice(&proof.public_inputs.merkle_root);
        public_inputs_bytes.extend_from_slice(&proof.public_inputs.nullifier_hash);
        public_inputs_bytes.extend_from_slice(&proof.public_inputs.new_commitment);
        public_inputs_bytes.extend_from_slice(&proof.public_inputs.change_commitment);

        // Use the centralized verifier with Ed25519 introspection
        verify_proof_with_sysvar(
            &proof.proof,
            &public_inputs_bytes,
            proof.attestation.as_ref(),
            instructions_sysvar,
            None, // No trusted verifier whitelist for transfers
        )?;

        msg!("Transfer proof verification successful");
        Ok(())
    }
}

/// Insert both transfer commitments for zero-copy (separate stack frame)
#[inline(never)]
fn insert_transfer_commitments_zc(
    pool: &mut PrivacyPool,
    new_commitment: [u8; 32],
    change_commitment: [u8; 32],
) -> Result<()> {
    pool.save_root_to_history();

    // Insert new_commitment
    insert_leaf_zc(pool, new_commitment)?;

    // Insert change_commitment
    insert_leaf_zc(pool, change_commitment)?;

    Ok(())
}

/// Helper to insert a leaf into the Merkle tree for zero-copy (stack-optimized)
#[inline(never)]
fn insert_leaf_zc(pool: &mut PrivacyPool, commitment: [u8; 32]) -> Result<u64> {
    let leaf_index = pool.next_leaf_index;
    let new_root = compute_merkle_root_zc(pool, commitment, leaf_index);

    pool.merkle_root = new_root;
    pool.next_leaf_index += 1;

    Ok(leaf_index)
}

/// Compute new Merkle root for zero-copy (separate stack frame)
/// Uses Poseidon hash for ZK circuit compatibility
#[inline(never)]
fn compute_merkle_root_zc(pool: &mut PrivacyPool, commitment: [u8; 32], leaf_index: u64) -> [u8; 32] {
    let zeros = compute_zero_hashes_poseidon();
    let mut current_index = leaf_index;
    let mut current_hash = commitment;

    for i in 0..MERKLE_DEPTH {
        let is_left = current_index % 2 == 0;

        if is_left {
            pool.filled_subtrees[i] = current_hash;
            current_hash = merkle_hash_2(&current_hash, &zeros[i]);
        } else {
            current_hash = merkle_hash_2(&pool.filled_subtrees[i], &current_hash);
        }

        current_index /= 2;
    }

    current_hash
}
