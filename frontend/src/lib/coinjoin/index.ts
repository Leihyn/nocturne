/**
 * CoinJoin Module
 *
 * P2P Blind CoinJoin for private deposits.
 * Multiple users coordinate to deposit simultaneously, making it
 * cryptographically impossible to link depositors to their commitments.
 *
 * Privacy guarantee: Even the coordination server cannot determine
 * which participant owns which commitment due to blind signatures.
 */

export {
  CoinJoinClient,
  coinJoinDeposit,
  CoinJoinState,
  type CoinJoinStatus,
  type CoinJoinResult,
} from './client';

export {
  buildCoinJoinTransaction,
  verifyCoinJoinTransaction,
  serializeCoinJoinData,
  deserializeCoinJoinData,
  getCoinJoinMessageToSign,
  applyCoinJoinSignatures,
  verifyCoinJoinSignatures,
  extractSignatureFromSignedTx,
  type CoinJoinInput,
  type SerializedCoinJoinTx,
  type CollectedSignature,
} from './transaction-builder';

export {
  CoinJoinError,
  CoinJoinErrorCode,
  isCoinJoinError,
  wrapError,
  Errors,
} from './errors';
