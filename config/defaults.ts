/**
 * StealthSol Default Configuration
 *
 * Centralized configuration for all components.
 * Override via environment variables or config files.
 */

// ============================================
// Network Configuration
// ============================================

export const NETWORK_CONFIG = {
  // Solana cluster
  cluster: process.env.SOLANA_CLUSTER || 'devnet',
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  wsUrl: process.env.SOLANA_WS_URL || 'wss://api.devnet.solana.com',

  // Commitment level
  commitment: 'confirmed' as const,
} as const;

// ============================================
// Pool Configuration
// ============================================

export const POOL_CONFIG = {
  // Supported denominations (in lamports)
  denominations: [
    1_000_000_000n,   // 1 SOL
    10_000_000_000n,  // 10 SOL
    100_000_000_000n, // 100 SOL
  ] as const,

  // Merkle tree settings
  merkleTreeDepth: 20,  // Supports ~1 million deposits
  merkleTreeHistorySize: 100,  // Keep 100 historical roots

  // Minimum pool balance for operations
  minPoolBalance: 100_000_000n,  // 0.1 SOL rent exemption buffer
} as const;

// ============================================
// Timing Configuration
// ============================================

export const TIMING_CONFIG = {
  // CoinJoin timing
  coinjoin: {
    sessionTimeoutMs: 120_000,      // 2 minutes
    minJoinDelayMs: 5_000,          // 5 seconds
    maxJoinDelayMs: 35_000,         // 35 seconds
    outputSubmissionTimeoutMs: 30_000, // 30 seconds
  },

  // Withdrawal timing (for privacy)
  withdrawal: {
    minDelayHours: 24,
    recommendedDelayHours: 72,
    warnBelowHours: 48,
  },

  // Transaction timing
  transaction: {
    confirmationTimeoutMs: 60_000,
    retryDelayMs: 1_000,
    maxRetries: 3,
  },
} as const;

// ============================================
// CoinJoin Configuration
// ============================================

export const COINJOIN_CONFIG = {
  // Participant limits
  minParticipants: 3,
  maxParticipants: 10,
  optimalParticipants: 5,

  // Coordinator settings
  coordinatorUrl: process.env.COINJOIN_COORDINATOR_URL || 'ws://localhost:8080',
  coordinatorOnionUrl: process.env.COINJOIN_COORDINATOR_ONION_URL,

  // Threshold RSA settings
  threshold: {
    required: 3,  // t
    total: 5,     // n
  },

  // Rate limiting
  rateLimit: {
    requestsPerMinute: 30,
    connectionsPerIp: 5,
  },
} as const;

// ============================================
// Cryptography Configuration
// ============================================

export const CRYPTO_CONFIG = {
  // RSA settings for blind signatures
  rsa: {
    keySize: 2048,
    publicExponent: 65537n,
    millerRabinIterations: 64,
  },

  // Argon2 settings for key derivation
  argon2: {
    memoryCost: 65536,     // 64 MB
    timeCost: 3,           // 3 iterations
    parallelism: 4,        // 4 parallel lanes
    hashLength: 32,        // 256 bits
  },

  // AES-GCM settings
  aesGcm: {
    keyLength: 256,
    ivLength: 12,
    tagLength: 128,
  },

  // PBKDF2 settings (fallback when Argon2 unavailable)
  pbkdf2: {
    iterations: 600_000,
    hashAlgorithm: 'SHA-256',
  },
} as const;

// ============================================
// Privacy Configuration
// ============================================

export const PRIVACY_CONFIG = {
  // Tor settings
  tor: {
    enforceForCoinjoin: true,
    warnIfNotTor: true,
    defaultSocksPort: 9050,
    controlPort: 9051,
  },

  // Timing analysis protection
  timing: {
    addRandomDelays: true,
    minDelayMs: 5_000,
    maxDelayMs: 60_000,
    jitterPercentage: 20,
  },

  // Request ordering
  requests: {
    randomizeOrder: true,
    disableReferer: true,
  },
} as const;

// ============================================
// ZK Proof Configuration
// ============================================

export const ZK_CONFIG = {
  // Circuit settings
  circuits: {
    withdrawCircuitPath: '/circuits/withdraw.json',
    depositCircuitPath: '/circuits/deposit.json',
  },

  // Proof verification
  verification: {
    useOnChainVerification: false,  // Set true when alt_bn128 available
    verifierServiceUrl: process.env.VERIFIER_URL || 'http://localhost:3001',
    attestationExpirySeconds: 300,  // 5 minutes
  },

  // Groth16 curve
  curve: 'BN254' as const,
} as const;

// ============================================
// Storage Configuration
// ============================================

export const STORAGE_CONFIG = {
  // Local storage keys (browser)
  localStorage: {
    encryptedNotesKey: 'stealthsol_encrypted_notes',
    keySaltKey: 'stealthsol_key_salt',
    settingsKey: 'stealthsol_settings',
  },

  // CLI storage paths
  cli: {
    configDir: '.stealthsol',
    keyFile: 'keys.enc',
    notesFile: 'notes.enc',
  },
} as const;

// ============================================
// UI Configuration
// ============================================

export const UI_CONFIG = {
  // Display formatting
  display: {
    maxDecimalPlaces: 9,
    shortAddressLength: 8,
    dateFormat: 'YYYY-MM-DD HH:mm:ss',
  },

  // Refresh intervals
  refresh: {
    balanceIntervalMs: 10_000,
    poolStatusIntervalMs: 30_000,
    transactionStatusIntervalMs: 2_000,
  },
} as const;

// ============================================
// Exports
// ============================================

export const CONFIG = {
  network: NETWORK_CONFIG,
  pool: POOL_CONFIG,
  timing: TIMING_CONFIG,
  coinjoin: COINJOIN_CONFIG,
  crypto: CRYPTO_CONFIG,
  privacy: PRIVACY_CONFIG,
  zk: ZK_CONFIG,
  storage: STORAGE_CONFIG,
  ui: UI_CONFIG,
} as const;

export default CONFIG;

// ============================================
// Type Exports
// ============================================

export type NetworkConfig = typeof NETWORK_CONFIG;
export type PoolConfig = typeof POOL_CONFIG;
export type TimingConfig = typeof TIMING_CONFIG;
export type CoinJoinConfig = typeof COINJOIN_CONFIG;
export type CryptoConfig = typeof CRYPTO_CONFIG;
export type PrivacyConfigType = typeof PRIVACY_CONFIG;
export type ZKConfig = typeof ZK_CONFIG;
export type StorageConfig = typeof STORAGE_CONFIG;
export type UIConfig = typeof UI_CONFIG;
export type Config = typeof CONFIG;
