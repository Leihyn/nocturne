/**
 * CoinJoin Error Handling
 *
 * Structured error types for the CoinJoin protocol.
 * Provides specific error codes and messages for debugging
 * while avoiding information leakage to potential attackers.
 */

/**
 * Error codes for CoinJoin operations
 */
export enum CoinJoinErrorCode {
  // Connection errors
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  CONNECTION_CLOSED = 'CONNECTION_CLOSED',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',

  // Session errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_ABORTED = 'SESSION_ABORTED',
  INSUFFICIENT_PARTICIPANTS = 'INSUFFICIENT_PARTICIPANTS',

  // Protocol errors
  INVALID_STATE = 'INVALID_STATE',
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  BLIND_SIGNATURE_FAILED = 'BLIND_SIGNATURE_FAILED',
  UNBLIND_FAILED = 'UNBLIND_FAILED',

  // Transaction errors
  TRANSACTION_BUILD_FAILED = 'TRANSACTION_BUILD_FAILED',
  SIGNING_FAILED = 'SIGNING_FAILED',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  BROADCAST_FAILED = 'BROADCAST_FAILED',

  // Validation errors
  INVALID_COMMITMENT = 'INVALID_COMMITMENT',
  INVALID_DENOMINATION = 'INVALID_DENOMINATION',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',

  // Internal errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  MISSING_DATA = 'MISSING_DATA',
}

/**
 * Structured CoinJoin error with code, message, and optional details
 */
export class CoinJoinError extends Error {
  public readonly code: CoinJoinErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: number;
  public readonly recoverable: boolean;

  constructor(
    code: CoinJoinErrorCode,
    message: string,
    options?: {
      details?: Record<string, unknown>;
      recoverable?: boolean;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = 'CoinJoinError';
    this.code = code;
    this.details = options?.details;
    this.timestamp = Date.now();
    this.recoverable = options?.recoverable ?? false;

    // Preserve original error stack if available
    if (options?.cause && options.cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }

  /**
   * Convert to a safe message for user display (no sensitive details)
   */
  toUserMessage(): string {
    switch (this.code) {
      case CoinJoinErrorCode.CONNECTION_FAILED:
        return 'Unable to connect to CoinJoin coordinator. Please try again.';
      case CoinJoinErrorCode.CONNECTION_CLOSED:
        return 'Connection to coordinator was lost. Please try again.';
      case CoinJoinErrorCode.RATE_LIMITED:
        return 'Too many requests. Please wait before trying again.';
      case CoinJoinErrorCode.SESSION_EXPIRED:
        return 'Session expired. Please start a new CoinJoin session.';
      case CoinJoinErrorCode.SESSION_ABORTED:
        return 'Session was aborted by another participant.';
      case CoinJoinErrorCode.INSUFFICIENT_PARTICIPANTS:
        return 'Not enough participants joined. Please try again later.';
      case CoinJoinErrorCode.SIGNING_FAILED:
        return 'Failed to sign transaction. Please check your wallet.';
      case CoinJoinErrorCode.BROADCAST_FAILED:
        return 'Failed to broadcast transaction. Please try again.';
      default:
        return 'An error occurred during CoinJoin. Please try again.';
    }
  }

  /**
   * Convert to JSON for logging (excludes sensitive data)
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
      recoverable: this.recoverable,
      // Exclude details to avoid logging sensitive data
    };
  }
}

/**
 * Type guard to check if an error is a CoinJoinError
 */
export function isCoinJoinError(error: unknown): error is CoinJoinError {
  return error instanceof CoinJoinError;
}

/**
 * Wrap an unknown error into a CoinJoinError
 */
export function wrapError(
  error: unknown,
  defaultCode: CoinJoinErrorCode = CoinJoinErrorCode.INTERNAL_ERROR
): CoinJoinError {
  if (isCoinJoinError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new CoinJoinError(defaultCode, error.message, {
      cause: error,
      recoverable: false,
    });
  }

  return new CoinJoinError(defaultCode, String(error), {
    recoverable: false,
  });
}

/**
 * Create specific error instances
 */
export const Errors = {
  connectionFailed: (reason?: string) =>
    new CoinJoinError(
      CoinJoinErrorCode.CONNECTION_FAILED,
      reason || 'Failed to connect to CoinJoin coordinator',
      { recoverable: true }
    ),

  connectionClosed: (reason?: string) =>
    new CoinJoinError(
      CoinJoinErrorCode.CONNECTION_CLOSED,
      reason || 'Connection closed unexpectedly',
      { recoverable: true }
    ),

  rateLimited: (retryAfter?: number) =>
    new CoinJoinError(
      CoinJoinErrorCode.RATE_LIMITED,
      `Rate limited${retryAfter ? `. Retry after ${retryAfter}s` : ''}`,
      { recoverable: true, details: { retryAfter } }
    ),

  sessionAborted: (reason?: string) =>
    new CoinJoinError(
      CoinJoinErrorCode.SESSION_ABORTED,
      reason || 'Session was aborted',
      { recoverable: true }
    ),

  invalidState: (expected: string, actual: string) =>
    new CoinJoinError(
      CoinJoinErrorCode.INVALID_STATE,
      `Invalid state: expected ${expected}, got ${actual}`,
      { recoverable: false }
    ),

  signingFailed: (reason?: string) =>
    new CoinJoinError(
      CoinJoinErrorCode.SIGNING_FAILED,
      reason || 'Failed to sign transaction',
      { recoverable: false }
    ),

  missingData: (what: string) =>
    new CoinJoinError(
      CoinJoinErrorCode.MISSING_DATA,
      `Missing required data: ${what}`,
      { recoverable: false }
    ),
};
