/**
 * Transaction History - Local-only tracking of deposits and withdrawals
 *
 * Stores transaction history locally without exposing on-chain data.
 * This helps users track their activity without compromising privacy.
 */

export type TxType = 'deposit' | 'withdraw' | 'send' | 'receive';
export type TxStatus = 'pending' | 'confirmed' | 'failed';

export interface TxHistoryEntry {
  id: string;
  type: TxType;
  amount: number;
  denomination: number;
  timestamp: number;
  status: TxStatus;
  signature?: string;
  recipient?: string; // Truncated for privacy
  noteId?: string; // Reference to saved note
  privacyScore?: number;
  teeRelay?: boolean;
  stealthAddress?: string; // Truncated
}

const STORAGE_KEY = 'stealthsol_history';
const MAX_ENTRIES = 50;

/**
 * Get all transaction history
 */
export function getTxHistory(): TxHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Add a new transaction to history
 */
export function addTxToHistory(entry: Omit<TxHistoryEntry, 'id' | 'timestamp'>): TxHistoryEntry {
  const history = getTxHistory();

  const newEntry: TxHistoryEntry = {
    ...entry,
    id: generateId(),
    timestamp: Date.now(),
  };

  history.unshift(newEntry);

  // Keep only the most recent entries
  if (history.length > MAX_ENTRIES) {
    history.length = MAX_ENTRIES;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  return newEntry;
}

/**
 * Update transaction status
 */
export function updateTxStatus(id: string, status: TxStatus, signature?: string): void {
  const history = getTxHistory();
  const entry = history.find(e => e.id === id);

  if (entry) {
    entry.status = status;
    if (signature) entry.signature = signature;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }
}

/**
 * Get recent transactions
 */
export function getRecentTx(limit: number = 10): TxHistoryEntry[] {
  return getTxHistory().slice(0, limit);
}

/**
 * Get transactions by type
 */
export function getTxByType(type: TxType): TxHistoryEntry[] {
  return getTxHistory().filter(e => e.type === type);
}

/**
 * Clear all history
 */
export function clearTxHistory(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
}

/**
 * Format transaction for display
 */
export function formatTxDisplay(entry: TxHistoryEntry): {
  icon: string;
  title: string;
  subtitle: string;
  amount: string;
  time: string;
  color: string;
} {
  const time = formatTimeAgo(entry.timestamp);
  const amount = `${entry.amount} SOL`;

  switch (entry.type) {
    case 'deposit':
      return {
        icon: '↓',
        title: 'Deposited',
        subtitle: 'Added to privacy pool',
        amount: `+${amount}`,
        time,
        color: 'text-violet-400',
      };
    case 'withdraw':
      return {
        icon: '↑',
        title: 'Withdrew',
        subtitle: entry.recipient ? `To ${entry.recipient}` : 'To private address',
        amount: `-${amount}`,
        time,
        color: 'text-emerald-400',
      };
    case 'send':
      return {
        icon: '→',
        title: 'Sent',
        subtitle: entry.recipient ? `To ${entry.recipient}` : 'To recipient',
        amount: `-${amount}`,
        time,
        color: 'text-blue-400',
      };
    case 'receive':
      return {
        icon: '←',
        title: 'Received',
        subtitle: 'From stealth payment',
        amount: `+${amount}`,
        time,
        color: 'text-green-400',
      };
    default:
      return {
        icon: '•',
        title: 'Transaction',
        subtitle: '',
        amount,
        time,
        color: 'text-zinc-400',
      };
  }
}

/**
 * Format time ago
 */
function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

/**
 * Generate unique ID
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}

/**
 * Truncate address for privacy
 */
export function truncateAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Calculate privacy score for a transaction
 */
export function calculatePrivacyScore(entry: Partial<TxHistoryEntry>): number {
  let score = 50; // Base score

  // ZK proof used
  score += 25;

  // TEE relay used
  if (entry.teeRelay) score += 15;

  // Fixed denomination
  if (entry.denomination && [0.1, 1, 10, 100].includes(entry.denomination)) {
    score += 7;
  }

  // Stealth address used
  if (entry.stealthAddress) score += 3;

  return Math.min(score, 100);
}

/**
 * Get statistics
 */
export function getTxStats(): {
  totalDeposits: number;
  totalWithdrawals: number;
  totalVolume: number;
  avgPrivacyScore: number;
} {
  const history = getTxHistory();

  const deposits = history.filter(e => e.type === 'deposit');
  const withdrawals = history.filter(e => e.type === 'withdraw');

  const totalDeposits = deposits.reduce((sum, e) => sum + e.amount, 0);
  const totalWithdrawals = withdrawals.reduce((sum, e) => sum + e.amount, 0);

  const scores = history.filter(e => e.privacyScore).map(e => e.privacyScore!);
  const avgPrivacyScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  return {
    totalDeposits,
    totalWithdrawals,
    totalVolume: totalDeposits + totalWithdrawals,
    avgPrivacyScore,
  };
}
