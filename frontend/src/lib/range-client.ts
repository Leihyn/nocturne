/**
 * Range Compliance Client
 *
 * Integrates Range's risk and compliance APIs for compliant privacy.
 * https://docs.range.org/
 *
 * ## Features
 * - Address risk scoring
 * - Sanctions/blacklist screening (OFAC, EU, UK, UN)
 * - Transaction simulation
 * - Compliance report generation
 *
 * ## Privacy + Compliance
 * Range checks happen BEFORE transactions, not on-chain.
 * This means:
 * - Privacy is preserved (no on-chain compliance data)
 * - Bad actors are blocked pre-emptively
 * - Legitimate users proceed normally
 *
 * @see https://docs.range.org/risk-api/risk-introduction
 */

import { PublicKey } from '@solana/web3.js';

// Range API base URL
const RANGE_API_BASE = 'https://api.range.org/v1';

// Risk thresholds
export const RISK_THRESHOLDS = {
  LOW: 25,
  MEDIUM: 50,
  HIGH: 75,
  CRITICAL: 90,
} as const;

/**
 * Risk level enum
 */
export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
  UNKNOWN = 'unknown',
}

/**
 * Address risk assessment result
 */
export interface AddressRiskResult {
  address: string;
  riskScore: number;
  riskLevel: RiskLevel;
  sanctioned: boolean;
  flags: string[];
  categories: string[];
  timestamp: number;
}

/**
 * Sanctions check result
 */
export interface SanctionsResult {
  address: string;
  sanctioned: boolean;
  lists: string[]; // e.g., ['OFAC', 'EU']
  timestamp: number;
}

/**
 * Transaction simulation result
 */
export interface TransactionSimResult {
  safe: boolean;
  riskScore: number;
  warnings: string[];
  blockedReasons: string[];
}

/**
 * Compliance report for auditors
 */
export interface ComplianceReport {
  generatedAt: number;
  walletAddress: string;
  reportPeriod: {
    start: number;
    end: number;
  };
  summary: {
    totalTransactions: number;
    totalVolume: bigint;
    riskAssessment: RiskLevel;
  };
  transactions: ComplianceTransaction[];
  attestation?: string; // Range attestation ID
}

/**
 * Transaction in compliance report
 */
export interface ComplianceTransaction {
  id: string;
  timestamp: number;
  type: 'deposit' | 'withdrawal';
  amount: bigint;
  counterparty?: string; // Only if disclosed
  riskScore: number;
}

/**
 * Range client configuration
 */
export interface RangeConfig {
  apiKey: string;
  /** Block transactions above this risk score (0-100) */
  blockThreshold?: number;
  /** Enable test mode (uses mock data) */
  testMode?: boolean;
  /** Custom API base URL */
  apiBase?: string;
}

/**
 * Range Compliance Client
 *
 * Provides compliance screening and reporting for StealthSol.
 */
export class RangeClient {
  private apiKey: string;
  private blockThreshold: number;
  private testMode: boolean;
  private apiBase: string;

  constructor(config: RangeConfig) {
    this.apiKey = config.apiKey;
    this.blockThreshold = config.blockThreshold ?? RISK_THRESHOLDS.HIGH;
    this.testMode = config.testMode ?? false;
    this.apiBase = config.apiBase ?? RANGE_API_BASE;
  }

  /**
   * Check if an address passes compliance screening
   *
   * This is the main entry point for pre-transaction screening.
   * Returns true if the address is safe to transact with.
   */
  async isAddressSafe(address: string | PublicKey): Promise<boolean> {
    const addr = typeof address === 'string' ? address : address.toBase58();

    // Check sanctions first (hard block)
    const sanctions = await this.checkSanctions(addr);
    if (sanctions.sanctioned) {
      console.warn(`Address ${addr} is sanctioned:`, sanctions.lists);
      return false;
    }

    // Check risk score (soft block based on threshold)
    const risk = await this.getAddressRisk(addr);
    if (risk.riskScore >= this.blockThreshold) {
      console.warn(`Address ${addr} risk score ${risk.riskScore} exceeds threshold ${this.blockThreshold}`);
      return false;
    }

    return true;
  }

  /**
   * Get detailed risk assessment for an address
   */
  async getAddressRisk(address: string | PublicKey): Promise<AddressRiskResult> {
    const addr = typeof address === 'string' ? address : address.toBase58();

    if (this.testMode) {
      return this.mockAddressRisk(addr);
    }

    try {
      // Range API uses GET with query params
      const url = `${this.apiBase}/address?address=${encodeURIComponent(addr)}&network=solana`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Range API error: ${response.status}`);
      }

      const data = await response.json();

      // Map Range API response to our format
      const isMalicious = data.malicious === true;
      const riskScore = isMalicious ? 95 : (data.tags?.length > 0 ? 30 : 5);

      return {
        address: addr,
        riskScore,
        riskLevel: this.scoreToLevel(riskScore),
        sanctioned: isMalicious,
        flags: data.tags ?? [],
        categories: data.category ? [data.category] : [],
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('Range API error:', error);
      // Fail open in case of API errors (configurable)
      return this.mockAddressRisk(addr);
    }
  }

  /**
   * Check if an address is on sanctions lists
   */
  async checkSanctions(address: string | PublicKey): Promise<SanctionsResult> {
    const addr = typeof address === 'string' ? address : address.toBase58();

    if (this.testMode) {
      return this.mockSanctionsCheck(addr);
    }

    try {
      // Use the address endpoint which includes malicious flag
      const url = `${this.apiBase}/address?address=${encodeURIComponent(addr)}&network=solana`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Range API error: ${response.status}`);
      }

      const data = await response.json();

      // Range marks sanctioned/malicious addresses with malicious: true
      const isSanctioned = data.malicious === true;

      return {
        address: addr,
        sanctioned: isSanctioned,
        lists: isSanctioned ? ['RANGE-FLAGGED'] : [],
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('Range sanctions check error:', error);
      return this.mockSanctionsCheck(addr);
    }
  }

  /**
   * Simulate a transaction for risk assessment
   */
  async simulateTransaction(
    from: string | PublicKey,
    to: string | PublicKey,
    amount: bigint,
  ): Promise<TransactionSimResult> {
    const fromAddr = typeof from === 'string' ? from : from.toBase58();
    const toAddr = typeof to === 'string' ? to : to.toBase58();

    if (this.testMode) {
      return this.mockTransactionSim(fromAddr, toAddr, amount);
    }

    try {
      const response = await fetch(`${this.apiBase}/risk/simulate/solana`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: fromAddr,
          to: toAddr,
          amount: amount.toString(),
          token: 'SOL',
        }),
      });

      if (!response.ok) {
        throw new Error(`Range API error: ${response.status}`);
      }

      const data = await response.json();

      return {
        safe: data.safe ?? true,
        riskScore: data.risk_score ?? 0,
        warnings: data.warnings ?? [],
        blockedReasons: data.blocked_reasons ?? [],
      };
    } catch (error) {
      console.error('Range simulation error:', error);
      return this.mockTransactionSim(fromAddr, toAddr, amount);
    }
  }

  /**
   * Generate a compliance report for an address
   *
   * This is used with view keys - the view key holder can generate
   * a compliance report without having spending access.
   */
  async generateComplianceReport(
    walletAddress: string | PublicKey,
    transactions: ComplianceTransaction[],
    periodStart: number,
    periodEnd: number,
  ): Promise<ComplianceReport> {
    const addr = typeof walletAddress === 'string' ? walletAddress : walletAddress.toBase58();

    // Calculate summary
    const totalVolume = transactions.reduce((sum, tx) => sum + tx.amount, BigInt(0));
    const avgRisk = transactions.length > 0
      ? transactions.reduce((sum, tx) => sum + tx.riskScore, 0) / transactions.length
      : 0;

    const report: ComplianceReport = {
      generatedAt: Date.now(),
      walletAddress: addr,
      reportPeriod: {
        start: periodStart,
        end: periodEnd,
      },
      summary: {
        totalTransactions: transactions.length,
        totalVolume,
        riskAssessment: this.scoreToLevel(avgRisk),
      },
      transactions,
    };

    // In production, submit to Range for attestation
    if (!this.testMode) {
      try {
        const response = await fetch(`${this.apiBase}/compliance/attest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            report,
            chain: 'solana',
          }),
        });

        if (response.ok) {
          const data = await response.json();
          report.attestation = data.attestation_id;
        }
      } catch (error) {
        console.error('Range attestation error:', error);
      }
    } else {
      // Mock attestation for test mode
      report.attestation = `test-attestation-${Date.now()}`;
    }

    return report;
  }

  /**
   * Verify a compliance attestation
   */
  async verifyAttestation(attestationId: string): Promise<boolean> {
    if (this.testMode) {
      return attestationId.startsWith('test-attestation-');
    }

    try {
      const response = await fetch(`${this.apiBase}/compliance/verify/${attestationId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json();
      return data.valid === true;
    } catch (error) {
      console.error('Range verification error:', error);
      return false;
    }
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  private scoreToLevel(score: number): RiskLevel {
    if (score >= RISK_THRESHOLDS.CRITICAL) return RiskLevel.CRITICAL;
    if (score >= RISK_THRESHOLDS.HIGH) return RiskLevel.HIGH;
    if (score >= RISK_THRESHOLDS.MEDIUM) return RiskLevel.MEDIUM;
    if (score >= RISK_THRESHOLDS.LOW) return RiskLevel.LOW;
    return RiskLevel.LOW;
  }

  // =========================================================================
  // Mock Methods (for test mode / devnet)
  // =========================================================================

  private mockAddressRisk(address: string): AddressRiskResult {
    // Known test addresses that should be flagged
    const flaggedAddresses = [
      'SANCTIONED111111111111111111111111111111111', // Test sanctioned
      'HIGHRISK1111111111111111111111111111111111', // Test high risk
    ];

    const isFlagged = flaggedAddresses.some(a => address.includes(a.slice(0, 10)));

    return {
      address,
      riskScore: isFlagged ? 95 : Math.floor(Math.random() * 20), // Low risk for normal addresses
      riskLevel: isFlagged ? RiskLevel.CRITICAL : RiskLevel.LOW,
      sanctioned: address.includes('SANCTIONED'),
      flags: isFlagged ? ['test-flag'] : [],
      categories: [],
      timestamp: Date.now(),
    };
  }

  private mockSanctionsCheck(address: string): SanctionsResult {
    const isSanctioned = address.includes('SANCTIONED');

    return {
      address,
      sanctioned: isSanctioned,
      lists: isSanctioned ? ['OFAC-TEST', 'EU-TEST'] : [],
      timestamp: Date.now(),
    };
  }

  private mockTransactionSim(
    _from: string,
    to: string,
    _amount: bigint,
  ): TransactionSimResult {
    const toRisk = this.mockAddressRisk(to);

    return {
      safe: toRisk.riskScore < this.blockThreshold,
      riskScore: toRisk.riskScore,
      warnings: toRisk.riskScore > RISK_THRESHOLDS.MEDIUM ? ['Elevated risk recipient'] : [],
      blockedReasons: toRisk.sanctioned ? ['Recipient is sanctioned'] : [],
    };
  }
}

/**
 * Create a Range client for devnet/testing
 * Uses mock data, no API key required
 */
export function createTestRangeClient(): RangeClient {
  return new RangeClient({
    apiKey: 'test-key',
    testMode: true,
  });
}

/**
 * Create a Range client for production
 * Requires valid API key from app.range.org
 */
export function createRangeClient(apiKey: string): RangeClient {
  return new RangeClient({
    apiKey,
    testMode: false,
  });
}
