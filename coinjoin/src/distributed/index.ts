/**
 * Distributed CoinJoin Module
 *
 * Provides decentralized CoinJoin coordination using:
 * - Threshold RSA for distributed blind signatures
 * - P2P coordinator network
 * - Distributed key generation
 */

export {
  CoordinatorNetwork,
  CoordinatorConfig,
  CoordinatorMessage,
  performDKG,
  createCoordinatorNetwork,
} from './coordinator-network.js';

export {
  DistributedCoinJoinServer,
  DistributedServerConfig,
  startDistributedServer,
} from './distributed-server.js';
