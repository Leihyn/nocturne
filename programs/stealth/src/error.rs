use anchor_lang::prelude::*;

/// Minimum payment amount in lamports (0.001 SOL = 1,000,000 lamports)
/// This prevents spam attacks on the announcement system
pub const MIN_PAYMENT_LAMPORTS: u64 = 1_000_000;

#[error_code]
pub enum StealthError {
    #[msg("Invalid scan public key - not a valid curve point")]
    InvalidScanPubkey,

    #[msg("Invalid spend public key - not a valid curve point")]
    InvalidSpendPubkey,

    #[msg("Invalid ephemeral key - not a valid curve point")]
    InvalidEphemeralKey,

    #[msg("Stealth address mismatch - computed address doesn't match")]
    AddressMismatch,

    #[msg("Insufficient funds in stealth address")]
    InsufficientFunds,

    #[msg("Registry already exists for this owner")]
    AlreadyRegistered,

    #[msg("Invalid stealth address derivation")]
    InvalidDerivation,

    #[msg("Unauthorized withdrawal attempt")]
    Unauthorized,

    #[msg("Commitment verification failed - stealth address may not be correctly derived")]
    CommitmentMismatch,

    #[msg("Payment amount too small - minimum is 0.001 SOL (1,000,000 lamports)")]
    PaymentTooSmall,

    #[msg("ZK proof verification failed")]
    ZkVerificationFailed,

    #[msg("Invalid proof inputs - wrong number or format")]
    InvalidProofInputs,

    #[msg("Invalid verification key")]
    InvalidVerificationKey,

    #[msg("Proof verification returned false - invalid proof")]
    ProofInvalid,

    #[msg("ZK verification not supported on this Solana version - requires 2.0+")]
    ZkVerificationNotSupported,

    // Privacy Pool Errors
    #[msg("Privacy pool is full - no more deposits allowed")]
    PoolFull,

    #[msg("Privacy pool is not active")]
    PoolNotActive,

    #[msg("Deposits are currently paused")]
    DepositsPaused,

    #[msg("Withdrawals are currently paused")]
    WithdrawalsPaused,

    #[msg("Deposit amount is below minimum")]
    DepositTooSmall,

    #[msg("Deposit amount exceeds maximum")]
    DepositTooLarge,

    #[msg("Invalid fee recipient")]
    InvalidFeeRecipient,

    #[msg("Invalid batch size - must be 1-10")]
    InvalidBatchSize,

    #[msg("Invalid Merkle root - not current or in history")]
    InvalidMerkleRoot,

    #[msg("Invalid ZK proof")]
    InvalidProof,

    #[msg("Invalid recipient address")]
    InvalidRecipient,

    #[msg("Insufficient pool balance for withdrawal")]
    InsufficientPoolBalance,

    #[msg("Nullifier has already been used")]
    NullifierAlreadyUsed,

    #[msg("Nullifier hash mismatch")]
    InvalidNullifier,

    // Oracle Verification Errors
    #[msg("Missing oracle attestation for proof verification")]
    MissingAttestation,

    #[msg("Proof hash does not match attestation")]
    ProofHashMismatch,

    #[msg("Public inputs hash does not match attestation")]
    PublicInputsMismatch,

    #[msg("Oracle attestation has expired (max 5 minutes)")]
    AttestationExpired,

    #[msg("Verification method not available")]
    VerificationMethodNotAvailable,

    #[msg("Invalid Ed25519 signature in attestation")]
    InvalidSignature,

    #[msg("Verifier is not in trusted verifiers list")]
    UntrustedVerifier,

    // Pedersen Commitment Errors
    #[msg("Missing Pedersen commitment for amount")]
    MissingAmountCommitment,

    #[msg("Invalid Pedersen commitment format")]
    InvalidPedersenCommitment,

    #[msg("Range proof verification failed")]
    RangeProofFailed,

    #[msg("Range proof missing or invalid")]
    MissingRangeProof,

    #[msg("Amount commitment mismatch")]
    AmountCommitmentMismatch,

    // Fixed Denomination Errors
    #[msg("Invalid denomination - must be 1, 10, or 100 SOL")]
    InvalidDenomination,

    #[msg("Amount must match pool denomination exactly")]
    AmountMustMatchDenomination,

    // Verification Key Errors
    #[msg("Invalid circuit ID - must be 0 (withdraw) or 1 (deposit)")]
    InvalidCircuitId,

    #[msg("Invalid IC length - must have 2-10 points")]
    InvalidICLength,

    #[msg("Serialization error")]
    SerializationError,

    #[msg("Deserialization error")]
    DeserializationError,

    #[msg("Verification key data too large")]
    VerificationKeyTooLarge,

    // ==========================================
    // VIEW KEY ERRORS
    // ==========================================

    #[msg("Invalid view key - cannot be all zeros")]
    InvalidViewKey,

    #[msg("Invalid view key holder - cannot be default pubkey")]
    InvalidViewKeyHolder,

    #[msg("View key not set - cannot toggle or revoke")]
    ViewKeyNotSet,

    #[msg("View access denied - not authorized viewer")]
    ViewAccessDenied,

    // ==========================================
    // COMMIT-REVEAL ERRORS
    // ==========================================

    #[msg("Minimum delay too short - must be at least 30 minutes")]
    DelayTooShort,

    #[msg("Maximum delay too long - cannot exceed 7 days")]
    DelayTooLong,

    #[msg("Invalid delay window - max must be greater than min")]
    InvalidDelayWindow,

    #[msg("Not in execution window - too early or too late")]
    NotInExecutionWindow,

    #[msg("Commitment already executed")]
    CommitmentAlreadyExecuted,

    #[msg("Commitment was cancelled")]
    CommitmentCancelled,

    #[msg("Commitment is still active - cannot close")]
    CommitmentStillActive,

    #[msg("Denomination mismatch")]
    DenominationMismatch,

    #[msg("Relayer fee too high - max 5%")]
    RelayerFeeTooHigh,

    #[msg("Relayer required when fee is specified")]
    RelayerRequired,

    // ==========================================
    // FEE RELAYER ERRORS
    // ==========================================

    #[msg("Relayer registrations are closed")]
    RegistrationsClosed,

    #[msg("Insufficient relayer stake - minimum 1 SOL")]
    InsufficientRelayerStake,

    #[msg("Relayer is not active")]
    RelayerNotActive,

    #[msg("Wrong relayer for this request")]
    WrongRelayer,

    #[msg("Relay already completed")]
    RelayAlreadyCompleted,

    #[msg("Relay request has expired")]
    RelayExpired,

    #[msg("Cannot withdraw stake with pending slash")]
    PendingSlash,

    #[msg("Must wait 7 days to unstake")]
    UnstakePeriodNotMet,

    #[msg("Denomination not supported by this relayer")]
    DenominationNotSupported,

    // ==========================================
    // KEEPER NETWORK ERRORS
    // ==========================================

    #[msg("Encrypted payload too large - max 512 bytes")]
    PayloadTooLarge,

    #[msg("Window start too soon - must be at least 1 hour")]
    WindowTooSoon,

    #[msg("Invalid window duration - must be 1-168 hours")]
    InvalidWindowDuration,

    #[msg("Keeper fee too low - minimum 0.001 SOL")]
    KeeperFeeTooLow,

    #[msg("Intent already executed")]
    IntentAlreadyExecuted,

    #[msg("Owner mismatch")]
    OwnerMismatch,

    #[msg("Cannot cancel during execution window")]
    CannotCancelDuringWindow,

    #[msg("Intent has not expired yet")]
    IntentNotExpired,

    // ==========================================
    // ANNOUNCEMENT LOG ERRORS
    // ==========================================

    #[msg("Announcement log is full")]
    LogFull,

    #[msg("Announcement log is not active")]
    LogNotActive,

    // ==========================================
    // DECOY SYSTEM ERRORS
    // ==========================================

    #[msg("Decoy fee too high - max 1%")]
    FeeTooHigh,

    #[msg("Invalid decoy configuration")]
    InvalidDecoyConfig,

    #[msg("Decoy system is not active")]
    DecoySystemInactive,

    #[msg("Decoy wallet not found")]
    DecoyWalletNotFound,

    #[msg("Insufficient treasury balance")]
    InsufficientTreasuryBalance,

    // ==========================================
    // ARITHMETIC ERRORS
    // ==========================================

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Arithmetic underflow")]
    ArithmeticUnderflow,

    #[msg("Math overflow")]
    MathOverflow,

    // ==========================================
    // KEEPER VERIFICATION ERRORS
    // ==========================================

    #[msg("Invalid keeper proof attestation")]
    InvalidKeeperAttestation,

    #[msg("Nullifier check failed - may have been used")]
    NullifierCheckFailed,
}
