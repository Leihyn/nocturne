/**
 * Privacy Configuration Module
 *
 * Comprehensive privacy settings and enforcement for StealthSol.
 * Addresses:
 * - Tor enforcement for CoinJoin
 * - RPC privacy (multiple endpoints, rotation)
 * - Timing analysis protection
 * - Connection fingerprinting resistance
 */

// ============================================
// Types
// ============================================

export interface PrivacyConfig {
  // Tor settings
  tor: {
    enforceForCoinJoin: boolean;
    enforceForAllConnections: boolean;
    warnIfNotTor: boolean;
    onionCoordinatorUrl?: string;
  };

  // RPC privacy
  rpc: {
    useMultipleEndpoints: boolean;
    rotateEndpoints: boolean;
    rotationIntervalMs: number;
    endpoints: string[];
    privateRpcUrl?: string;  // User's own RPC
  };

  // Timing protection
  timing: {
    enableRandomDelays: boolean;
    minDelayMs: number;
    maxDelayMs: number;
    jitterPercentage: number;  // Add ±X% randomness to all delays
    minWithdrawalDelayHours: number;
    recommendedWithdrawalDelayHours: number;
  };

  // Connection fingerprinting
  fingerprint: {
    rotateUserAgent: boolean;
    disableReferer: boolean;
    randomizeRequestOrder: boolean;
  };

  // General
  strictMode: boolean;  // Fail if any privacy requirement not met
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  tor: {
    enforceForCoinJoin: true,
    enforceForAllConnections: false,
    warnIfNotTor: true,
    onionCoordinatorUrl: undefined,
  },
  rpc: {
    useMultipleEndpoints: true,
    rotateEndpoints: true,
    rotationIntervalMs: 30000,  // 30 seconds
    endpoints: [
      'https://api.mainnet-beta.solana.com',
      'https://solana-api.projectserum.com',
      'https://rpc.ankr.com/solana',
    ],
    privateRpcUrl: undefined,
  },
  timing: {
    enableRandomDelays: true,
    minDelayMs: 5000,    // 5 seconds
    maxDelayMs: 60000,   // 60 seconds
    jitterPercentage: 20,
    minWithdrawalDelayHours: 24,
    recommendedWithdrawalDelayHours: 72,
  },
  fingerprint: {
    rotateUserAgent: false,  // Not implemented in browser
    disableReferer: true,
    randomizeRequestOrder: true,
  },
  strictMode: false,
};

// ============================================
// Privacy State
// ============================================

let currentConfig = { ...DEFAULT_PRIVACY_CONFIG };
let currentRpcIndex = 0;
let lastRpcRotation = 0;

// ============================================
// Configuration
// ============================================

/**
 * Update privacy configuration
 */
export function setPrivacyConfig(config: Partial<PrivacyConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...config,
    tor: { ...currentConfig.tor, ...config.tor },
    rpc: { ...currentConfig.rpc, ...config.rpc },
    timing: { ...currentConfig.timing, ...config.timing },
    fingerprint: { ...currentConfig.fingerprint, ...config.fingerprint },
  };
}

/**
 * Get current privacy configuration
 */
export function getPrivacyConfig(): PrivacyConfig {
  return { ...currentConfig };
}

// ============================================
// Tor Detection & Enforcement
// ============================================

/**
 * Check if connection appears to be via Tor
 */
export function detectTorConnection(): {
  isTor: boolean;
  confidence: 'high' | 'medium' | 'low';
  indicators: string[];
} {
  const indicators: string[] = [];
  let score = 0;

  // Check if connected to .onion address
  if (typeof window !== 'undefined') {
    if (window.location.hostname.endsWith('.onion')) {
      indicators.push('Connected via .onion address');
      score += 100;  // Definitive
    }

    // Check for Tor Browser indicators
    // Note: These can be spoofed, so lower confidence
    try {
      // Tor Browser blocks certain APIs
      if (!navigator.plugins || navigator.plugins.length === 0) {
        indicators.push('No plugins detected (common in Tor)');
        score += 10;
      }

      // Tor Browser has specific window dimensions
      if (window.outerWidth === window.innerWidth &&
          window.outerHeight === window.innerHeight) {
        indicators.push('Maximized window (Tor Browser default)');
        score += 5;
      }
    } catch {
      indicators.push('API restrictions detected');
      score += 15;
    }
  }

  return {
    isTor: score >= 50,
    confidence: score >= 100 ? 'high' : score >= 30 ? 'medium' : 'low',
    indicators,
  };
}

/**
 * Check if Tor is required and available
 */
export function checkTorRequirement(operation: 'coinjoin' | 'withdraw' | 'deposit' | 'general'): {
  allowed: boolean;
  warning?: string;
  error?: string;
} {
  const torStatus = detectTorConnection();

  // CoinJoin always requires Tor in strict mode
  if (operation === 'coinjoin' && currentConfig.tor.enforceForCoinJoin) {
    if (!torStatus.isTor) {
      if (currentConfig.strictMode) {
        return {
          allowed: false,
          error: 'CoinJoin requires Tor connection. Please use Tor Browser or configure a Tor proxy.',
        };
      }
      return {
        allowed: true,
        warning: 'CoinJoin without Tor significantly reduces privacy. Your IP may be visible to the coordinator.',
      };
    }
  }

  // General enforcement
  if (currentConfig.tor.enforceForAllConnections && !torStatus.isTor) {
    if (currentConfig.strictMode) {
      return {
        allowed: false,
        error: 'All connections require Tor in strict privacy mode.',
      };
    }
    return {
      allowed: true,
      warning: 'Connecting without Tor may expose your IP address.',
    };
  }

  // Warning only
  if (currentConfig.tor.warnIfNotTor && !torStatus.isTor) {
    return {
      allowed: true,
      warning: 'Consider using Tor for enhanced privacy.',
    };
  }

  return { allowed: true };
}

// ============================================
// RPC Privacy
// ============================================

/**
 * Get the current RPC endpoint (with rotation)
 */
export function getRpcEndpoint(): string {
  // Use private RPC if configured
  if (currentConfig.rpc.privateRpcUrl) {
    return currentConfig.rpc.privateRpcUrl;
  }

  // No rotation
  if (!currentConfig.rpc.rotateEndpoints || currentConfig.rpc.endpoints.length <= 1) {
    return currentConfig.rpc.endpoints[0] || 'https://api.mainnet-beta.solana.com';
  }

  // Check if rotation needed
  const now = Date.now();
  if (now - lastRpcRotation > currentConfig.rpc.rotationIntervalMs) {
    currentRpcIndex = (currentRpcIndex + 1) % currentConfig.rpc.endpoints.length;
    lastRpcRotation = now;
  }

  return currentConfig.rpc.endpoints[currentRpcIndex];
}

/**
 * Get a random RPC endpoint (for uncorrelated requests)
 */
export function getRandomRpcEndpoint(): string {
  if (currentConfig.rpc.privateRpcUrl) {
    return currentConfig.rpc.privateRpcUrl;
  }

  const endpoints = currentConfig.rpc.endpoints;
  if (endpoints.length === 0) {
    return 'https://api.mainnet-beta.solana.com';
  }

  return endpoints[Math.floor(Math.random() * endpoints.length)];
}

/**
 * Set user's private RPC endpoint
 */
export function setPrivateRpc(url: string | undefined): void {
  currentConfig.rpc.privateRpcUrl = url;
}

/**
 * RPC request wrapper with privacy enhancements
 */
export async function privacyAwareRpcRequest<T>(
  method: string,
  params: any[],
  options: { useRandomEndpoint?: boolean; addDelay?: boolean } = {}
): Promise<T> {
  const endpoint = options.useRandomEndpoint
    ? getRandomRpcEndpoint()
    : getRpcEndpoint();

  // Optional delay to prevent timing correlation
  if (options.addDelay && currentConfig.timing.enableRandomDelays) {
    await randomDelay(100, 500);  // Small delay for RPC
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Disable referer if configured
      ...(currentConfig.fingerprint.disableReferer ? { 'Referer': '' } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.random().toString(36).substring(7),
      method,
      params,
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result;
}

// ============================================
// Timing Protection
// ============================================

/**
 * Generate a random delay within configured bounds
 */
export async function randomDelay(
  minMs?: number,
  maxMs?: number
): Promise<number> {
  const min = minMs ?? currentConfig.timing.minDelayMs;
  const max = maxMs ?? currentConfig.timing.maxDelayMs;

  // Add jitter
  const jitter = currentConfig.timing.jitterPercentage / 100;
  const range = max - min;
  const jitterAmount = range * jitter * (Math.random() * 2 - 1);

  const delay = min + Math.random() * range + jitterAmount;
  const actualDelay = Math.max(0, Math.round(delay));

  await new Promise(resolve => setTimeout(resolve, actualDelay));
  return actualDelay;
}

/**
 * Check if withdrawal timing is safe
 */
export function checkWithdrawalTiming(depositTimestamp: number): {
  safe: boolean;
  waitTimeMs: number;
  recommendation: string;
} {
  const now = Date.now();
  const elapsed = now - depositTimestamp;
  const minWait = currentConfig.timing.minWithdrawalDelayHours * 60 * 60 * 1000;
  const recommendedWait = currentConfig.timing.recommendedWithdrawalDelayHours * 60 * 60 * 1000;

  if (elapsed < minWait) {
    return {
      safe: false,
      waitTimeMs: minWait - elapsed,
      recommendation: `Wait at least ${currentConfig.timing.minWithdrawalDelayHours} hours after deposit for basic privacy.`,
    };
  }

  if (elapsed < recommendedWait) {
    return {
      safe: true,
      waitTimeMs: recommendedWait - elapsed,
      recommendation: `For optimal privacy, wait ${currentConfig.timing.recommendedWithdrawalDelayHours} hours. You've waited ${Math.floor(elapsed / (60 * 60 * 1000))} hours.`,
    };
  }

  return {
    safe: true,
    waitTimeMs: 0,
    recommendation: 'Sufficient time has passed for good timing privacy.',
  };
}

/**
 * Generate cryptographically random timing offset
 */
export function getCryptoRandomDelay(baseMs: number, varianceMs: number): number {
  const randomBytes = new Uint32Array(1);
  crypto.getRandomValues(randomBytes);
  const randomFactor = randomBytes[0] / 0xFFFFFFFF;  // 0 to 1
  return Math.round(baseMs + (randomFactor * 2 - 1) * varianceMs);
}

// ============================================
// Request Ordering
// ============================================

/**
 * Execute requests in random order to prevent fingerprinting
 */
export async function executeInRandomOrder<T>(
  tasks: (() => Promise<T>)[]
): Promise<T[]> {
  if (!currentConfig.fingerprint.randomizeRequestOrder) {
    // Execute in order
    const results: T[] = [];
    for (const task of tasks) {
      results.push(await task());
    }
    return results;
  }

  // Shuffle tasks
  const shuffled = [...tasks];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Execute with random delays between
  const results: { index: number; result: T }[] = [];
  for (let i = 0; i < shuffled.length; i++) {
    if (i > 0) {
      await randomDelay(50, 200);  // Small inter-request delay
    }
    const result = await shuffled[i]();
    results.push({ index: tasks.indexOf(shuffled[i]), result });
  }

  // Return in original order
  return results.sort((a, b) => a.index - b.index).map(r => r.result);
}

// ============================================
// Privacy Score
// ============================================

export interface PrivacyScore {
  score: number;  // 0-100
  level: 'excellent' | 'good' | 'moderate' | 'poor';
  factors: {
    name: string;
    score: number;
    maxScore: number;
    recommendation?: string;
  }[];
}

/**
 * Calculate current privacy score
 */
export function calculatePrivacyScore(): PrivacyScore {
  const factors: PrivacyScore['factors'] = [];
  let totalScore = 0;
  let maxPossible = 0;

  // Tor connection (30 points)
  const torStatus = detectTorConnection();
  const torScore = torStatus.isTor ? 30 : 0;
  factors.push({
    name: 'Tor Connection',
    score: torScore,
    maxScore: 30,
    recommendation: torStatus.isTor ? undefined : 'Use Tor Browser or configure Tor proxy',
  });
  totalScore += torScore;
  maxPossible += 30;

  // Private RPC (20 points)
  const rpcScore = currentConfig.rpc.privateRpcUrl ? 20 : 5;
  factors.push({
    name: 'RPC Privacy',
    score: rpcScore,
    maxScore: 20,
    recommendation: currentConfig.rpc.privateRpcUrl ? undefined : 'Configure your own RPC endpoint',
  });
  totalScore += rpcScore;
  maxPossible += 20;

  // Timing protection (25 points)
  const timingScore = currentConfig.timing.enableRandomDelays ? 25 : 0;
  factors.push({
    name: 'Timing Protection',
    score: timingScore,
    maxScore: 25,
    recommendation: timingScore === 25 ? undefined : 'Enable random delays in settings',
  });
  totalScore += timingScore;
  maxPossible += 25;

  // Strict mode (15 points)
  const strictScore = currentConfig.strictMode ? 15 : 0;
  factors.push({
    name: 'Strict Privacy Mode',
    score: strictScore,
    maxScore: 15,
    recommendation: strictScore === 15 ? undefined : 'Enable strict mode for maximum privacy',
  });
  totalScore += strictScore;
  maxPossible += 15;

  // Browser fingerprint protection (10 points)
  const fingerprintScore =
    (currentConfig.fingerprint.randomizeRequestOrder ? 5 : 0) +
    (currentConfig.fingerprint.disableReferer ? 5 : 0);
  factors.push({
    name: 'Fingerprint Protection',
    score: fingerprintScore,
    maxScore: 10,
  });
  totalScore += fingerprintScore;
  maxPossible += 10;

  const normalizedScore = Math.round((totalScore / maxPossible) * 100);

  return {
    score: normalizedScore,
    level: normalizedScore >= 80 ? 'excellent' :
           normalizedScore >= 60 ? 'good' :
           normalizedScore >= 40 ? 'moderate' : 'poor',
    factors,
  };
}

// ============================================
// Exports
// ============================================

export {
  DEFAULT_PRIVACY_CONFIG as defaultConfig,
};
