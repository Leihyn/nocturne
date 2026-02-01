/**
 * Tor Hidden Service Support
 *
 * Configuration and utilities for running the CoinJoin coordinator
 * as a Tor hidden service (.onion address).
 *
 * Privacy benefits:
 * - Hides coordinator's real IP address
 * - Hides user's real IP from coordinator
 * - End-to-end encryption via Tor
 * - Resistance to traffic analysis
 *
 * Requirements:
 * - Tor daemon must be installed and running
 * - Hidden service must be configured in torrc
 *
 * Example torrc configuration:
 * ```
 * HiddenServiceDir /var/lib/tor/stealthsol_coinjoin/
 * HiddenServicePort 80 127.0.0.1:8080
 * HiddenServiceVersion 3
 * ```
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ============================================
// Configuration
// ============================================

export interface TorConfig {
  // Tor control settings
  controlPort: number;
  controlPassword?: string;
  controlCookieAuth?: boolean;

  // Hidden service settings
  hiddenServiceDir: string;
  hiddenServicePort: number;
  localPort: number;

  // Connection settings
  socksPort: number;
  socksHost: string;

  // Feature flags
  enabled: boolean;
  requireTor: boolean;  // Reject non-Tor connections
}

export const DEFAULT_TOR_CONFIG: TorConfig = {
  controlPort: 9051,
  controlCookieAuth: true,

  hiddenServiceDir: '/var/lib/tor/stealthsol_coinjoin/',
  hiddenServicePort: 80,
  localPort: 8080,

  socksPort: 9050,
  socksHost: '127.0.0.1',

  enabled: false,
  requireTor: false,
};

// ============================================
// Hidden Service Address
// ============================================

/**
 * Get the .onion address for this hidden service
 */
export function getOnionAddress(config: TorConfig = DEFAULT_TOR_CONFIG): string | null {
  const hostnamePath = join(config.hiddenServiceDir, 'hostname');

  if (!existsSync(hostnamePath)) {
    console.error(`Hidden service hostname file not found: ${hostnamePath}`);
    console.error('Make sure Tor is running and the hidden service is configured.');
    return null;
  }

  try {
    const hostname = readFileSync(hostnamePath, 'utf8').trim();
    return hostname;
  } catch (err) {
    console.error('Failed to read onion address:', err);
    return null;
  }
}

/**
 * Get the full WebSocket URL for the hidden service
 */
export function getOnionWebSocketUrl(config: TorConfig = DEFAULT_TOR_CONFIG): string | null {
  const address = getOnionAddress(config);
  if (!address) return null;

  return `ws://${address}:${config.hiddenServicePort}`;
}

// ============================================
// Tor Connection Detection
// ============================================

/**
 * Check if a connection appears to come from Tor
 * This is a heuristic and not foolproof
 */
export function isTorConnection(headers: Record<string, string | undefined>): boolean {
  // Check for common Tor exit node indicators
  // Note: This is not reliable for enforcing Tor-only access

  // Check X-Forwarded-For header
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    // Tor exits typically don't add this header
    return false;
  }

  // If connecting to a .onion address, it's definitely Tor
  const host = headers['host'];
  if (host && host.endsWith('.onion')) {
    return true;
  }

  // Cannot definitively determine
  return false;
}

/**
 * Check if connection is to an onion address
 */
export function isOnionConnection(host: string): boolean {
  return host.endsWith('.onion');
}

// ============================================
// SOCKS5 Proxy Configuration
// ============================================

/**
 * Get SOCKS5 proxy URL for Tor
 */
export function getTorProxyUrl(config: TorConfig = DEFAULT_TOR_CONFIG): string {
  return `socks5h://${config.socksHost}:${config.socksPort}`;
}

/**
 * Configuration for making requests through Tor
 */
export function getTorProxyConfig(config: TorConfig = DEFAULT_TOR_CONFIG) {
  return {
    hostname: config.socksHost,
    port: config.socksPort,
    type: 5 as const,  // SOCKS5
  };
}

// ============================================
// Torrc Generation
// ============================================

/**
 * Generate torrc configuration for the hidden service
 */
export function generateTorrc(config: TorConfig): string {
  return `# StealthSol CoinJoin Hidden Service Configuration
# Add this to your torrc file

# Hidden Service Configuration
HiddenServiceDir ${config.hiddenServiceDir}
HiddenServicePort ${config.hiddenServicePort} 127.0.0.1:${config.localPort}
HiddenServiceVersion 3

# Security: Only allow v3 onion addresses
HiddenServiceSingleHopMode 0
HiddenServiceNonAnonymousMode 0

# Optional: Enable client authorization for additional security
# HiddenServiceAuthorizeClient stealth client1,client2

# Restart Tor after adding this configuration:
# sudo systemctl restart tor
`;
}

/**
 * Print setup instructions
 */
export function printSetupInstructions(config: TorConfig = DEFAULT_TOR_CONFIG): void {
  console.log(`
================================================================================
                    Tor Hidden Service Setup Instructions
================================================================================

1. Install Tor:
   - Ubuntu/Debian: sudo apt install tor
   - macOS: brew install tor
   - Windows: Download from https://www.torproject.org/

2. Create the hidden service directory:
   sudo mkdir -p ${config.hiddenServiceDir}
   sudo chown debian-tor:debian-tor ${config.hiddenServiceDir}
   sudo chmod 700 ${config.hiddenServiceDir}

3. Add the following to your torrc (usually /etc/tor/torrc):

${generateTorrc(config)}

4. Restart Tor:
   sudo systemctl restart tor

5. Get your .onion address:
   sudo cat ${config.hiddenServiceDir}/hostname

6. Start the CoinJoin server:
   TOR_ENABLED=true npm run start

7. Share the .onion address with users for maximum privacy.

================================================================================
`);
}

// ============================================
// Server Middleware
// ============================================

/**
 * Express/WebSocket middleware to enforce Tor-only connections
 */
export function requireTorMiddleware(config: TorConfig) {
  return (req: any, res: any, next: any) => {
    if (!config.requireTor) {
      return next();
    }

    const host = req.headers?.host || '';

    if (!isOnionConnection(host)) {
      console.log(`Rejected non-Tor connection from ${req.ip}`);
      res.status(403).json({
        error: 'This service requires Tor. Please connect via the .onion address.',
        onionAddress: getOnionAddress(config),
      });
      return;
    }

    next();
  };
}

/**
 * WebSocket connection handler that enforces Tor
 */
export function shouldAcceptConnection(
  config: TorConfig,
  request: { headers: Record<string, string | undefined> }
): { accept: boolean; reason?: string } {
  if (!config.requireTor) {
    return { accept: true };
  }

  const host = request.headers['host'] || '';

  if (isOnionConnection(host)) {
    return { accept: true };
  }

  return {
    accept: false,
    reason: 'This service requires Tor. Please connect via the .onion address.',
  };
}

// ============================================
// Environment Configuration
// ============================================

/**
 * Load Tor configuration from environment variables
 */
export function loadConfigFromEnv(): TorConfig {
  return {
    ...DEFAULT_TOR_CONFIG,
    enabled: process.env.TOR_ENABLED === 'true',
    requireTor: process.env.TOR_REQUIRE === 'true',
    hiddenServiceDir: process.env.TOR_HIDDEN_SERVICE_DIR || DEFAULT_TOR_CONFIG.hiddenServiceDir,
    hiddenServicePort: parseInt(process.env.TOR_HIDDEN_SERVICE_PORT || '80'),
    localPort: parseInt(process.env.TOR_LOCAL_PORT || '8080'),
    socksPort: parseInt(process.env.TOR_SOCKS_PORT || '9050'),
    socksHost: process.env.TOR_SOCKS_HOST || '127.0.0.1',
    controlPort: parseInt(process.env.TOR_CONTROL_PORT || '9051'),
  };
}

// ============================================
// Health Check
// ============================================

/**
 * Check if Tor is running and hidden service is configured
 */
export async function checkTorHealth(config: TorConfig = DEFAULT_TOR_CONFIG): Promise<{
  healthy: boolean;
  torRunning: boolean;
  hiddenServiceConfigured: boolean;
  onionAddress: string | null;
  errors: string[];
}> {
  const errors: string[] = [];
  let torRunning = false;
  let hiddenServiceConfigured = false;

  // Check if hidden service hostname exists
  const onionAddress = getOnionAddress(config);
  if (onionAddress) {
    hiddenServiceConfigured = true;
    torRunning = true;  // If we have an address, Tor must be running
  } else {
    errors.push('Hidden service not configured or Tor not running');
  }

  // TODO: Add Tor control port health check

  return {
    healthy: torRunning && hiddenServiceConfigured,
    torRunning,
    hiddenServiceConfigured,
    onionAddress,
    errors,
  };
}

// Export for testing
export const _internal = {
  isTorConnection,
  isOnionConnection,
};
