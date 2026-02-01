'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useConnection } from '@solana/wallet-adapter-react';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import { useState, useEffect, useCallback } from 'react';
import bs58 from 'bs58';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Veil,
  getVeil,
  isMockMode,
  isStealthSolMode,
  type Identity,
  type ReceivedPayment,
  type PrivateBalance,
  type PendingWithdrawal,
  type BatchedWithdrawalResult,
} from '@/lib/veil';
import { getRelayerInfo } from '@/lib/privacy-backend';
import { isTeeAvailable, getBatchStatus, fetchGlobalBatchCount, formatBatchWaitTime, type BatchStatus } from '@/lib/magicblock-tee';

type View = 'home' | 'shield' | 'unshield' | 'scan' | 'setup' | 'queue';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Animation variants
const fadeIn = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
};

const stagger = {
  animate: { transition: { staggerChildren: 0.1 } },
};

const scaleIn = {
  initial: { scale: 0.95, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
  exit: { scale: 0.95, opacity: 0 },
};

// Privacy Shield Animation Component
const PrivacyShield = ({ active = false }: { active?: boolean }) => (
  <div className="relative">
    <motion.div
      className={`w-16 h-16 rounded-2xl flex items-center justify-center ${
        active ? 'bg-gradient-to-br from-violet-500 to-emerald-500' : 'bg-zinc-800'
      }`}
      animate={active ? {
        boxShadow: ['0 0 20px rgba(139, 92, 246, 0.3)', '0 0 40px rgba(139, 92, 246, 0.5)', '0 0 20px rgba(139, 92, 246, 0.3)']
      } : {}}
      transition={{ duration: 2, repeat: Infinity }}
    >
      <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    </motion.div>
    {active && (
      <motion.div
        className="absolute inset-0 rounded-2xl bg-gradient-to-br from-violet-500/20 to-emerald-500/20"
        animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0, 0.5] }}
        transition={{ duration: 2, repeat: Infinity }}
      />
    )}
  </div>
);

// Status Toast Component
const StatusToast = ({
  message,
  type,
  onClose
}: {
  message: string;
  type: 'info' | 'success' | 'error';
  onClose: () => void;
}) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const colors = {
    info: 'from-zinc-800 to-zinc-900 border-zinc-700',
    success: 'from-emerald-900/80 to-zinc-900 border-emerald-700/50',
    error: 'from-red-900/80 to-zinc-900 border-red-700/50',
  };

  const icons = {
    info: '○',
    success: '✓',
    error: '✕',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -50, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.9 }}
      className={`fixed top-6 left-1/2 -translate-x-1/2 px-6 py-4 rounded-2xl bg-gradient-to-r ${colors[type]} border backdrop-blur-xl shadow-2xl z-50 max-w-sm`}
    >
      <div className="flex items-center gap-3">
        <span className={`text-lg ${type === 'success' ? 'text-emerald-400' : type === 'error' ? 'text-red-400' : 'text-zinc-400'}`}>
          {icons[type]}
        </span>
        <p className="text-sm text-white">{message}</p>
      </div>
    </motion.div>
  );
};

// Balance Card Component
const BalanceCard = ({
  label,
  amount,
  unit = 'SOL',
  gradient = false,
  icon,
}: {
  label: string;
  amount: number;
  unit?: string;
  gradient?: boolean;
  icon?: React.ReactNode;
}) => (
  <div
    className={`relative overflow-hidden rounded-3xl p-6 ${
      gradient
        ? 'bg-gradient-to-br from-violet-900/40 via-zinc-900/60 to-emerald-900/30 border border-violet-500/20'
        : 'bg-zinc-900/50 border border-zinc-800'
    }`}
  >
    <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/5 to-transparent rounded-full blur-2xl -translate-y-1/2 translate-x-1/2" />
    <div className="relative">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <p className="text-xs text-zinc-500 uppercase tracking-widest">{label}</p>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-light tracking-tight ${gradient ? 'text-white' : 'text-zinc-200'}`}>
          {amount.toFixed(4)}
        </span>
        <span className="text-sm text-zinc-500">{unit}</span>
      </div>
    </div>
  </div>
);

// Action Button Component
const ActionButton = ({
  onClick,
  disabled,
  icon,
  title,
  subtitle,
  color,
  badge,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  color: 'violet' | 'emerald' | 'blue' | 'amber';
  badge?: number;
}) => {
  const colors = {
    violet: 'from-violet-600/20 to-violet-900/40 border-violet-500/30 hover:border-violet-400/50',
    emerald: 'from-emerald-600/20 to-emerald-900/40 border-emerald-500/30 hover:border-emerald-400/50',
    blue: 'from-blue-600/20 to-blue-900/40 border-blue-500/30 hover:border-blue-400/50',
    amber: 'from-amber-600/20 to-amber-900/40 border-amber-500/30 hover:border-amber-400/50',
  };

  const iconColors = {
    violet: 'text-violet-400',
    emerald: 'text-emerald-400',
    blue: 'text-blue-400',
    amber: 'text-amber-400',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`relative group w-full text-left p-5 rounded-2xl bg-gradient-to-br ${colors[color]} border backdrop-blur-sm transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed hover:scale-[1.02] active:scale-[0.98]`}
    >
      <div className="flex items-start gap-4">
        <div className={`p-3 rounded-xl bg-zinc-900/50 ${iconColors[color]}`}>
          {icon}
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-medium text-white mb-0.5">{title}</h3>
          <p className="text-sm text-zinc-500">{subtitle}</p>
        </div>
      </div>
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-3 right-3 w-6 h-6 flex items-center justify-center bg-emerald-500 text-white text-xs font-bold rounded-full animate-pulse">
          {badge}
        </span>
      )}
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </button>
  );
};

// Denomination Selector
const DenominationSelector = ({
  options,
  selected,
  onSelect,
  maxAmount,
}: {
  options: { sol: number; label: string; recommended?: boolean }[];
  selected: number;
  onSelect: (sol: number) => void;
  maxAmount: number;
}) => (
  <div className="grid grid-cols-3 gap-3">
    {options.map((opt) => (
      <motion.button
        key={opt.sol}
        whileHover={{ scale: opt.sol <= maxAmount ? 1.02 : 1 }}
        whileTap={{ scale: opt.sol <= maxAmount ? 0.98 : 1 }}
        onClick={() => onSelect(opt.sol)}
        disabled={opt.sol > maxAmount}
        className={`relative py-4 px-3 rounded-xl font-medium transition-all ${
          selected === opt.sol
            ? 'bg-gradient-to-br from-violet-600 to-violet-700 text-white ring-2 ring-violet-400 ring-offset-2 ring-offset-zinc-900'
            : opt.sol > maxAmount
            ? 'bg-zinc-900/50 text-zinc-600 cursor-not-allowed'
            : 'bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700/50 border border-zinc-700/50'
        }`}
      >
        <span className="text-lg">{opt.sol}</span>
        <span className="text-sm ml-1">SOL</span>
        {opt.recommended && selected !== opt.sol && opt.sol <= maxAmount && (
          <span className="absolute -top-2 -right-2 px-2 py-0.5 bg-violet-500 text-white text-[10px] font-bold rounded-full uppercase tracking-wider">
            Best
          </span>
        )}
      </motion.button>
    ))}
  </div>
);

// Page Header
const Header = ({
  onBack,
  title
}: {
  onBack?: () => void;
  title?: string;
}) => (
  <motion.div
    initial={{ opacity: 0, y: -10 }}
    animate={{ opacity: 1, y: 0 }}
    className="flex items-center gap-4 mb-8"
  >
    {onBack && (
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onBack}
        className="p-2 rounded-xl bg-zinc-800/50 text-zinc-400 hover:text-white hover:bg-zinc-700/50 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </motion.button>
    )}
    {title && <h1 className="text-2xl font-light text-white">{title}</h1>}
  </motion.div>
);

// Main Component
export default function Home() {
  const { publicKey, signTransaction, signMessage, connected } = useWallet();
  const { connection } = useConnection();

  // State
  const [veil, setVeil] = useState<Veil | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [walletBalance, setWalletBalance] = useState(0);
  const [privateBalance, setPrivateBalance] = useState<PrivateBalance>({ lamports: 0, sol: 0 });
  const [view, setView] = useState<View>('home');
  const [queueEncrypted, setQueueEncrypted] = useState(false);
  const [pendingWithdrawals, setPendingWithdrawals] = useState<PendingWithdrawal[]>([]);
  const [readyCount, setReadyCount] = useState(0);
  const [encryptionAttempted, setEncryptionAttempted] = useState(false);
  const [useBatchedMode, setUseBatchedMode] = useState(true);
  const [selectedDenomination, setSelectedDenomination] = useState(1);
  const [ephemeralWallet, setEphemeralWallet] = useState<{ keypair: Keypair; address: string; privateKey: string } | null>(null);
  const [ephemeralBalance, setEphemeralBalance] = useState(0);
  const [isVeilInitialized, setIsVeilInitialized] = useState(false);
  const [receiveAmount, setReceiveAmount] = useState('1');
  const [payments, setPayments] = useState<ReceivedPayment[]>([]);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' } | null>(null);
  const [relayerOnline, setRelayerOnline] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sendToOther, setSendToOther] = useState(false);
  const [recipientAddress, setRecipientAddress] = useState('');
  const [useTeeDeposit, setUseTeeDeposit] = useState(false);
  const [teeAvailable, setTeeAvailable] = useState(false);
  const [teeAuthenticating, setTeeAuthenticating] = useState(false);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);

  // Initialize
  useEffect(() => {
    if (connection) {
      const v = getVeil(connection, RPC_URL);
      setVeil(v);
      const existingIdentity = v.loadIdentity();
      if (existingIdentity) setIdentity(existingIdentity);

      const savedKey = localStorage.getItem('veil_ephemeral_key');
      if (savedKey) {
        try {
          const keypair = Keypair.fromSecretKey(bs58.decode(savedKey));
          setEphemeralWallet({ keypair, address: keypair.publicKey.toBase58(), privateKey: savedKey });
          v.initWithKeypair(keypair);
          setIsVeilInitialized(true);
        } catch {
          localStorage.removeItem('veil_ephemeral_key');
        }
      }
    }
  }, [connection]);

  // Check relayer
  useEffect(() => {
    const check = async () => {
      if (isStealthSolMode()) {
        try {
          const info = await getRelayerInfo();
          setRelayerOnline(!!info);
        } catch {
          setRelayerOnline(false);
        }
      }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  // Check TEE availability and batch status
  useEffect(() => {
    const checkTee = async () => {
      try {
        const available = await isTeeAvailable();
        setTeeAvailable(available);
        if (available) {
          console.log('[TEE] MagicBlock TEE is available');
          // Fetch global batch count from on-chain (populates cache)
          await fetchGlobalBatchCount(RPC_URL);
          // Then get batch status (uses the cached global count)
          const status = getBatchStatus(RPC_URL);
          setBatchStatus(status);
        }
      } catch {
        setTeeAvailable(false);
      }
    };
    checkTee();

    // Refresh batch status periodically when TEE is enabled
    const interval = setInterval(async () => {
      if (teeAvailable) {
        // Fetch fresh global count from on-chain
        await fetchGlobalBatchCount(RPC_URL);
        const status = getBatchStatus(RPC_URL);
        setBatchStatus(status);
      }
    }, 15000); // Every 15 seconds (matches cache TTL)

    return () => clearInterval(interval);
  }, [teeAvailable]);

  // Initialize encryption
  useEffect(() => {
    const init = async () => {
      if (veil && signMessage && connected && !queueEncrypted && !encryptionAttempted) {
        setEncryptionAttempted(true);
        try {
          const success = await veil.initializeQueueEncryption(signMessage);
          setQueueEncrypted(success);
          if (success) {
            const pending = await veil.getPendingWithdrawals();
            setPendingWithdrawals(pending);
            const ready = await veil.getReadyWithdrawals();
            setReadyCount(ready.length);
          }
        } catch (err) {
          console.error('Encryption init failed:', err);
        }
      }
    };
    init();
  }, [veil, signMessage, connected, queueEncrypted, encryptionAttempted]);

  // Check ready withdrawals
  useEffect(() => {
    if (!veil || !queueEncrypted) return;
    const check = async () => {
      const pending = await veil.getPendingWithdrawals();
      setPendingWithdrawals(pending);
      const ready = await veil.getReadyWithdrawals();
      setReadyCount(ready.length);
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [veil, queueEncrypted]);

  // Fetch balances
  useEffect(() => {
    const fetch = async () => {
      if (publicKey && connection) {
        const bal = await connection.getBalance(publicKey);
        setWalletBalance(bal / LAMPORTS_PER_SOL);
      }
      if (ephemeralWallet && connection) {
        const bal = await connection.getBalance(ephemeralWallet.keypair.publicKey);
        setEphemeralBalance(bal / LAMPORTS_PER_SOL);
      }
      if (veil && isVeilInitialized) {
        const privBal = await veil.getPrivateBalance();
        setPrivateBalance(privBal);
      }
    };
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [publicKey, connection, ephemeralWallet, veil, isVeilInitialized]);

  // Handlers
  const showToast = useCallback((message: string, type: 'info' | 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  const copyAddress = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    showToast('Address copied!', 'success');
  }, [showToast]);

  const handleGenerateWallet = () => {
    if (!veil) return;
    const wallet = veil.generateEphemeralWallet();
    setEphemeralWallet(wallet);
    localStorage.setItem('veil_ephemeral_key', wallet.privateKey);
    veil.initWithKeypair(wallet.keypair);
    setIsVeilInitialized(true);
    showToast('Privacy wallet created!', 'success');
  };

  const handleFundWallet = async (amount: number) => {
    if (!publicKey || !signTransaction || !ephemeralWallet || loading) return;
    setLoading(true);
    showToast(`Funding with ${amount} SOL...`, 'info');
    try {
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: ephemeralWallet.keypair.publicKey, lamports })
      );
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const txId = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight }, 'confirmed');
      showToast('Funded successfully!', 'success');
      setTimeout(async () => {
        const bal = await connection.getBalance(ephemeralWallet.keypair.publicKey);
        setEphemeralBalance(bal / LAMPORTS_PER_SOL);
      }, 1000);
    } catch (err) {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateIdentity = async () => {
    if (!veil) return;
    setLoading(true);
    showToast('Generating identity...', 'info');
    try {
      const id = await veil.generateIdentity();
      setIdentity(id);
      showToast('Identity created!', 'success');
    } catch (err) {
      showToast(`Error: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleShield = async () => {
    if (!veil || !isVeilInitialized) return;
    if (selectedDenomination > ephemeralBalance) return showToast('Insufficient balance', 'error');
    setLoading(true);

    // Use TEE if enabled and available
    if (useTeeDeposit && teeAvailable) {
      showToast(`Shielding ${selectedDenomination} SOL via TEE (private batch)...`, 'info');
      try {
        // Enable TEE mode if not already
        if (!veil.isTeeEnabled()) {
          const enabled = await veil.enableTeeMode();
          if (!enabled) {
            showToast('TEE unavailable, using standard deposit', 'info');
            // Fall through to standard deposit
          }
        }

        // Authenticate with TEE if needed
        if (veil.isTeeEnabled() && !veil.isAuthenticatedWithTee() && signMessage) {
          setTeeAuthenticating(true);
          showToast('Authenticating with TEE...', 'info');
          const authSuccess = await veil.authenticateWithTee(signMessage);
          setTeeAuthenticating(false);
          if (!authSuccess) {
            showToast('TEE auth failed, using standard deposit', 'info');
          }
        }

        // Use TEE deposit
        const result = await veil.sendPrivateTee(selectedDenomination, signMessage || undefined);
        if (result.success) {
          if (result.usedTee) {
            showToast(`Shielded via TEE! Batched privately. TX: ${result.txId?.slice(0, 12)}...`, 'success');
          } else {
            showToast(`Shielded! TX: ${result.txId?.slice(0, 12)}...`, 'success');
          }
          const bal = await connection.getBalance(ephemeralWallet!.keypair.publicKey);
          setEphemeralBalance(bal / LAMPORTS_PER_SOL);
          const privBal = await veil.getPrivateBalance();
          setPrivateBalance(privBal);
          // Immediately refresh batch status after TEE deposit
          await fetchGlobalBatchCount(RPC_URL);
          const status = getBatchStatus(RPC_URL);
          setBatchStatus(status);
        } else {
          showToast(`Failed: ${result.error}`, 'error');
        }
      } catch (err) {
        showToast(`Error: ${err}`, 'error');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Standard deposit
    showToast(`Shielding ${selectedDenomination} SOL...`, 'info');
    try {
      const result = await veil.sendPrivate(selectedDenomination);
      if (result.success) {
        showToast(`Shielded! TX: ${result.txId?.slice(0, 12)}...`, 'success');
        const bal = await connection.getBalance(ephemeralWallet!.keypair.publicKey);
        setEphemeralBalance(bal / LAMPORTS_PER_SOL);
        const privBal = await veil.getPrivateBalance();
        setPrivateBalance(privBal);
      } else {
        showToast(`Failed: ${result.error}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUnshield = async () => {
    if (!veil || !isVeilInitialized) return;
    const amount = parseFloat(receiveAmount);
    if (amount > privateBalance.sol) return showToast('Insufficient balance', 'error');
    if (sendToOther && !recipientAddress.trim()) return showToast('Enter recipient address', 'error');

    setLoading(true);
    const recipient = sendToOther ? recipientAddress.trim() : undefined;
    showToast(sendToOther ? `Sending ${amount} SOL privately...` : `Unshielding ${amount} SOL...`, 'info');

    try {
      let result;
      if (sendToOther) {
        // Send to another stealth address
        result = useBatchedMode && queueEncrypted
          ? await veil.sendToRecipientBatched(amount, recipient!)
          : await veil.sendToRecipient(amount, recipient!);
      } else {
        // Withdraw to self
        result = useBatchedMode && queueEncrypted
          ? await veil.receivePrivateBatched(amount)
          : await veil.receivePrivate(amount);
      }

      if (result.success) {
        if ('batchCount' in result) {
          showToast(`Created ${result.batchCount} batches over ${result.totalWindowHours?.toFixed(1)}h`, 'success');
        } else {
          showToast(sendToOther ? `Sent privately! TX: ${result.txId?.slice(0, 12)}...` : `Unshielded! TX: ${result.txId?.slice(0, 12)}...`, 'success');
        }
        const privBal = await veil.getPrivateBalance();
        setPrivateBalance(privBal);
        if (useBatchedMode) {
          const pending = await veil.getPendingWithdrawals();
          setPendingWithdrawals(pending);
        }
        if (sendToOther) setRecipientAddress('');
      } else {
        showToast(`Failed: ${result.error}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async () => {
    if (!veil) return;
    setScanning(true);
    showToast('Scanning...', 'info');
    try {
      const found = await veil.scan();
      setPayments(found);
      if (found.length === 0) {
        showToast('No payments found', 'info');
      } else {
        const total = found.reduce((s, p) => s + p.balance, 0);
        showToast(`Found ${found.length} payment(s): ${total.toFixed(4)} SOL`, 'success');
      }
    } catch (err) {
      showToast(`Scan failed: ${err}`, 'error');
    } finally {
      setScanning(false);
    }
  };

  const handleWithdraw = async (payment: ReceivedPayment) => {
    if (!veil) return;
    setLoading(true);
    showToast('Withdrawing to stealth...', 'info');
    try {
      const result = await veil.withdrawFromStealthToStealth(payment);
      if (result.success) {
        showToast(`Done! New stealth: ${result.newStealthAddress?.slice(0, 10)}...`, 'success');
        await handleScan();
      } else {
        showToast(`Failed: ${result.error}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleProcessQueue = async () => {
    if (!veil || !queueEncrypted) return;
    setLoading(true);
    showToast('Processing...', 'info');
    try {
      const { processed, results } = await veil.processReadyWithdrawals();
      const success = results.filter(r => r.success).length;
      showToast(`Processed ${success}/${processed}`, success === processed ? 'success' : 'error');
      const pending = await veil.getPendingWithdrawals();
      setPendingWithdrawals(pending);
      const ready = await veil.getReadyWithdrawals();
      setReadyCount(ready.length);
    } catch (err) {
      showToast(`Error: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const denominations = veil?.getAvailableDenominations() || [
    { sol: 1, label: '1 SOL', recommended: true },
    { sol: 10, label: '10 SOL' },
    { sol: 100, label: '100 SOL' },
  ];

  // Views
  const renderHome = () => (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      {/* Balances */}
      <div className="grid grid-cols-2 gap-4">
        <BalanceCard label="Available" amount={ephemeralBalance} />
        <BalanceCard label="Shielded" amount={privateBalance.sol} gradient icon={
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        } />
      </div>

      {/* Privacy Wallet */}
      {ephemeralWallet && (
        <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-violet-400" />
              <p className="text-xs text-zinc-500 uppercase tracking-widest">Privacy Wallet</p>
            </div>
            <button
              onClick={() => copyAddress(ephemeralWallet.address)}
              className="text-xs text-violet-400 hover:text-violet-300"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <code className="text-xs text-zinc-500 break-all block mb-2">{ephemeralWallet.address}</code>
          <p className="text-lg font-medium text-white mb-4">{ephemeralBalance.toFixed(4)} <span className="text-sm text-zinc-500">SOL</span></p>

          {/* Fund from connected wallet */}
          {connected && walletBalance > 0 && (
            <div className="pt-3 border-t border-zinc-800">
              <p className="text-xs text-zinc-500 mb-2">Fund from wallet ({walletBalance.toFixed(2)} SOL)</p>
              <div className="grid grid-cols-4 gap-2">
                {[0.5, 1, 2, 5].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => handleFundWallet(amt)}
                    disabled={loading || amt > walletBalance}
                    className="py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {amt}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Identity */}
      {identity && (
        <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-zinc-500 uppercase tracking-widest">Stealth Address</p>
            <button
              onClick={() => copyAddress(identity.metaAddress.encoded)}
              className="text-xs text-violet-400 hover:text-violet-300"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <code className="text-sm text-zinc-400 break-all">{identity.metaAddress.encoded.slice(0, 50)}...</code>
        </div>
      )}

      {/* Actions */}
      {isVeilInitialized ? (
        <div className="grid grid-cols-1 gap-3">
          <ActionButton
            onClick={() => setView('shield')}
            disabled={ephemeralBalance === 0}
            icon={<svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>}
            title="Shield"
            subtitle="Deposit SOL to privacy pool"
            color="violet"
          />
          <ActionButton
            onClick={() => setView('unshield')}
            disabled={privateBalance.sol <= 0}
            icon={<svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>}
            title="Unshield"
            subtitle="Withdraw to stealth address"
            color="emerald"
          />
          <div className="grid grid-cols-2 gap-3">
            <ActionButton
              onClick={() => setView('scan')}
              disabled={!identity}
              icon={<svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>}
              title="Scan"
              subtitle="Find payments"
              color="blue"
            />
            <ActionButton
              onClick={() => setView('queue')}
              disabled={!queueEncrypted}
              icon={<svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" /></svg>}
              title="Queue"
              subtitle="Pending"
              color="amber"
              badge={readyCount > 0 ? readyCount : undefined}
            />
          </div>
        </div>
      ) : (
        <div className="p-6 rounded-2xl bg-gradient-to-br from-amber-900/30 to-zinc-900 border border-amber-700/30">
          <h3 className="text-lg font-medium text-amber-300 mb-2">Setup Required</h3>
          <p className="text-sm text-zinc-400 mb-4">Create a privacy wallet to get started.</p>
          <button
            onClick={() => setView('setup')}
            className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors"
          >
            Setup Wallet
          </button>
        </div>
      )}

      {/* How it works */}
      <div className="p-5 rounded-2xl bg-zinc-900/30 border border-zinc-800/50">
        <h3 className="text-sm font-medium text-zinc-400 mb-4">How Privacy Works</h3>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-violet-900/50 flex items-center justify-center text-xs text-violet-400">1</div>
            <p className="text-zinc-500">Shield — Deposit enters ZK privacy pool</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-emerald-900/50 flex items-center justify-center text-xs text-emerald-400">2</div>
            <p className="text-zinc-500">Unshield — Withdraw to fresh stealth address</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-blue-900/50 flex items-center justify-center text-xs text-blue-400">3</div>
            <p className="text-zinc-500">Result — No link between deposit & withdrawal</p>
          </div>
        </div>
      </div>
    </motion.div>
  );

  const renderSetup = () => (
    <div>
      <Header onBack={() => setView('home')} title="Setup" />
      <div className="space-y-4">
        {/* Step 1 */}
        <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-full bg-violet-900/50 flex items-center justify-center text-sm text-violet-400">1</div>
            <h2 className="text-lg font-medium text-white">Create Privacy Wallet</h2>
          </div>
          {!ephemeralWallet ? (
            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={handleGenerateWallet}
              className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors">
              Create Wallet
            </motion.button>
          ) : (
            <div className="p-4 bg-zinc-800/50 rounded-xl">
              <p className="text-xs text-zinc-500 mb-1">Address</p>
              <code className="text-sm text-zinc-300 break-all">{ephemeralWallet.address}</code>
              <p className="text-emerald-400 font-medium mt-2">{ephemeralBalance.toFixed(4)} SOL</p>
            </div>
          )}
        </div>

        {/* Step 2 */}
        {ephemeralWallet && (
          <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-violet-900/50 flex items-center justify-center text-sm text-violet-400">2</div>
              <h2 className="text-lg font-medium text-white">Fund Wallet</h2>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[0.5, 1, 2, 5].map((amt) => (
                <motion.button key={amt} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                  onClick={() => handleFundWallet(amt)} disabled={loading || !connected || amt > walletBalance}
                  className="py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-medium transition-colors disabled:opacity-40">
                  {amt}
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3 */}
        {ephemeralWallet && ephemeralBalance > 0 && (
          <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-violet-900/50 flex items-center justify-center text-sm text-violet-400">3</div>
              <h2 className="text-lg font-medium text-white">Generate Identity</h2>
            </div>
            {!identity ? (
              <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={handleGenerateIdentity} disabled={loading}
                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors disabled:opacity-50">
                Generate
              </motion.button>
            ) : (
              <div className="p-4 bg-emerald-900/20 border border-emerald-700/30 rounded-xl">
                <p className="text-emerald-400 text-sm">✓ Identity ready</p>
              </div>
            )}
          </div>
        )}

        {isVeilInitialized && ephemeralBalance > 0 && (
          <button onClick={() => setView('home')}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-violet-600 to-emerald-600 text-white font-medium hover:opacity-90 transition-opacity">
            Go to Dashboard
          </button>
        )}
      </div>
    </div>
  );

  const renderShield = () => (
    <div>
      <Header onBack={() => setView('home')} title="Shield SOL" />
      <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-6">
        {/* TEE Privacy Toggle */}
        <div className={`p-4 rounded-xl border ${useTeeDeposit ? 'bg-emerald-900/20 border-emerald-700/30' : 'bg-zinc-800/50 border-zinc-700/50'}`}>
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-white">TEE Private Deposit</p>
                {teeAvailable ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-600/20 text-emerald-400 rounded">LIVE</span>
                ) : (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-zinc-600/20 text-zinc-500 rounded">OFFLINE</span>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                {teeAvailable
                  ? 'Batched with other users via MagicBlock TEE'
                  : 'TEE not available, use standard deposit'}
              </p>
            </div>
            <button
              onClick={() => setUseTeeDeposit(!useTeeDeposit)}
              disabled={!teeAvailable}
              className={`w-12 h-6 rounded-full p-1 transition-colors ${useTeeDeposit && teeAvailable ? 'bg-emerald-600' : 'bg-zinc-600'} ${!teeAvailable ? 'opacity-50 cursor-not-allowed' : ''}`}>
              <div className={`w-4 h-4 rounded-full bg-white transition-all`} style={{ marginLeft: useTeeDeposit && teeAvailable ? 24 : 0 }} />
            </button>
          </div>
          {useTeeDeposit && teeAvailable && (
            <div className="mt-3 pt-3 border-t border-emerald-700/30 space-y-3">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <p className="text-xs text-emerald-300/80">
                  Your deposit will be batched with others. No on-chain link between your wallet and the shielded funds.
                </p>
              </div>
              {/* Batch Status */}
              {batchStatus && (
                <div className={`rounded-lg p-3 transition-all duration-300 ${
                  batchStatus.justSettled ? 'bg-emerald-600/40 ring-1 ring-emerald-500' : 'bg-emerald-900/30'
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-emerald-400 font-medium">
                      Batch Status {batchStatus.settledBatches > 0 && `(#${batchStatus.settledBatches + 1})`}
                    </span>
                    {batchStatus.justSettled ? (
                      <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/40 text-emerald-200 rounded animate-pulse">Settled!</span>
                    ) : batchStatus.isReady ? (
                      <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/20 text-emerald-300 rounded">Ready</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-300 rounded">Collecting</span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <div>
                      <span className="text-zinc-500">{batchStatus.justSettled ? 'Deposits: ' : 'Pending: '}</span>
                      <span className="text-white">{batchStatus.pendingCount}/{batchStatus.batchThreshold}</span>
                    </div>
                    <div>
                      <span className="text-zinc-500">{batchStatus.justSettled ? 'Status: ' : 'Settles in: '}</span>
                      <span className="text-white">{batchStatus.justSettled ? 'Batch complete!' : formatBatchWaitTime(batchStatus.estimatedSettleTime)}</span>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div className="mt-2 h-1.5 bg-emerald-900/50 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${batchStatus.justSettled ? 'bg-emerald-400' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, (batchStatus.pendingCount / batchStatus.batchThreshold) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">Select Amount</p>
          <DenominationSelector options={denominations} selected={selectedDenomination} onSelect={setSelectedDenomination} maxAmount={ephemeralBalance} />
          <p className="text-xs text-zinc-500 mt-4">Available: {ephemeralBalance.toFixed(4)} SOL</p>
        </div>

        <button onClick={handleShield}
          disabled={loading || selectedDenomination > ephemeralBalance || teeAuthenticating}
          className={`w-full py-4 rounded-xl ${useTeeDeposit && teeAvailable ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500' : 'bg-violet-600 hover:bg-violet-500'} text-white font-medium transition-colors disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]`}>
          {loading
            ? (teeAuthenticating ? 'Authenticating with TEE...' : 'Shielding...')
            : useTeeDeposit && teeAvailable
              ? `Shield ${selectedDenomination} SOL (Private)`
              : `Shield ${selectedDenomination} SOL`}
        </button>
      </div>
    </div>
  );

  const renderUnshield = () => {
    const amount = parseFloat(receiveAmount);
    const isValid = amount === 1 || amount === 10 || amount === 100;
    const canSubmit = isValid && amount <= privateBalance.sol && (!useBatchedMode || queueEncrypted) && (!sendToOther || recipientAddress.trim());
    return (
      <div>
        <Header onBack={() => setView('home')} title={sendToOther ? "Private Send" : "Unshield SOL"} />
        <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-6">
          {/* Send to other toggle */}
          <div className="p-4 bg-zinc-800/50 rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Send to Address</p>
                <p className="text-xs text-zinc-500">Send to another stealth wallet</p>
              </div>
              <button onClick={() => setSendToOther(!sendToOther)}
                className={`w-12 h-6 rounded-full p-1 transition-colors ${sendToOther ? 'bg-violet-600' : 'bg-zinc-600'}`}>
                <div className={`w-4 h-4 rounded-full bg-white transition-all`} style={{ marginLeft: sendToOther ? 24 : 0 }} />
              </button>
            </div>
          </div>

          {/* Recipient address input */}
          {sendToOther && (
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-widest mb-2">Recipient Stealth Address</p>
              <input
                type="text"
                value={recipientAddress}
                onChange={(e) => setRecipientAddress(e.target.value)}
                placeholder="st:sol:..."
                className="w-full px-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 transition-colors"
              />
            </div>
          )}

          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-widest mb-4">Amount</p>
            <div className="grid grid-cols-3 gap-3">
              {[1, 10, 100].map((d) => (
                <button key={d}
                  onClick={() => setReceiveAmount(d.toString())} disabled={d > privateBalance.sol}
                  className={`py-3 rounded-xl font-medium transition-all hover:scale-[1.02] active:scale-[0.98] ${
                    parseFloat(receiveAmount) === d ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  } ${d > privateBalance.sol ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  {d} SOL
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-3">Shielded: {privateBalance.sol.toFixed(4)} SOL</p>
          </div>

          <div className="p-4 bg-zinc-800/50 rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Maximum Privacy</p>
                <p className="text-xs text-zinc-500">Random batches over hours</p>
              </div>
              <button onClick={() => setUseBatchedMode(!useBatchedMode)}
                className={`w-12 h-6 rounded-full p-1 transition-colors ${useBatchedMode ? 'bg-emerald-600' : 'bg-zinc-600'}`}>
                <div className={`w-4 h-4 rounded-full bg-white transition-all`} style={{ marginLeft: useBatchedMode ? 24 : 0 }} />
              </button>
            </div>
          </div>

          <button onClick={handleUnshield}
            disabled={loading || !canSubmit}
            className={`w-full py-4 rounded-xl ${sendToOther ? 'bg-violet-600 hover:bg-violet-500' : 'bg-emerald-600 hover:bg-emerald-500'} text-white font-medium transition-colors disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]`}>
            {loading ? 'Processing...' : !isValid ? 'Use 1, 10, or 100 SOL' : sendToOther ? `Send ${receiveAmount} SOL Privately` : `Unshield ${receiveAmount} SOL`}
          </button>
        </div>
      </div>
    );
  };

  const renderScan = () => (
    <div>
      <Header onBack={() => setView('home')} title="Scan Payments" />
      <div className="space-y-4">
        <button onClick={handleScan} disabled={scanning}
          className="w-full py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]">
          {scanning ? 'Scanning...' : 'Scan'}
        </button>
        {payments.length > 0 && (
          <div className="space-y-3">
            {payments.map((p, i) => (
              <div key={i}
                className="flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl border border-zinc-800">
                <div>
                  <code className="text-sm text-blue-400">{p.stealthAddress.toBase58().slice(0, 12)}...</code>
                  <p className="text-emerald-400 font-medium">{p.balance.toFixed(4)} SOL</p>
                </div>
                <button onClick={() => handleWithdraw(p)} disabled={loading}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-50 hover:scale-[1.05] active:scale-[0.95]">
                  Withdraw
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderQueue = () => {
    const pending = pendingWithdrawals.filter(w => w.status === 'pending');
    return (
      <div>
        <Header onBack={() => setView('home')} title="Queue" />
        <div className="space-y-4">
          {readyCount > 0 && (
            <button onClick={handleProcessQueue} disabled={loading}
              className="w-full py-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium animate-pulse disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]">
              Process {readyCount} Ready
            </button>
          )}
          {pending.length > 0 ? pending.map((w, i) => {
            const ready = w.executeAfter <= Date.now();
            return (
              <div key={w.id}
                className={`p-4 rounded-xl ${ready ? 'bg-emerald-900/30 border border-emerald-700/30' : 'bg-zinc-900/50 border border-zinc-800'}`}>
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-white font-medium">{w.amountSol.toFixed(4)} SOL</p>
                    <p className="text-xs text-zinc-500">{ready ? <span className="text-emerald-400">Ready!</span> : new Date(w.executeAfter).toLocaleString()}</p>
                  </div>
                </div>
              </div>
            );
          }) : <p className="text-zinc-500 text-sm text-center py-8">No pending withdrawals</p>}
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-[#0a0a0b] text-white selection:bg-violet-500/30">
      {/* Background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-violet-900/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] bg-emerald-900/10 rounded-full blur-[120px]" />
      </div>

      <div className="relative max-w-md mx-auto px-5 py-8 min-h-screen">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <PrivacyShield active={isVeilInitialized && privateBalance.sol > 0} />
            <div>
              <h1 className="text-xl font-semibold text-white tracking-tight">Nocturne</h1>
              <p className="text-xs text-zinc-500">Privacy Protocol</p>
            </div>
          </div>
          <WalletMultiButton className="!bg-zinc-900 !border !border-zinc-800 !rounded-xl !h-10 !text-sm !font-medium hover:!bg-zinc-800 !transition-colors" />
        </motion.div>

        {/* Network Badge */}
        {isStealthSolMode() && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-6 flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-full bg-emerald-900/30 text-emerald-400 text-xs font-medium border border-emerald-800/50">
              Devnet
            </span>
            {relayerOnline && (
              <span className="px-2.5 py-1 rounded-full bg-zinc-900 text-zinc-400 text-xs border border-zinc-800 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                Relayer
              </span>
            )}
          </motion.div>
        )}

        {/* Content */}
        <AnimatePresence mode="wait">
          {view === 'home' && renderHome()}
          {view === 'setup' && renderSetup()}
          {view === 'shield' && renderShield()}
          {view === 'unshield' && renderUnshield()}
          {view === 'scan' && renderScan()}
          {view === 'queue' && renderQueue()}
        </AnimatePresence>

        {/* Footer */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="mt-12 text-center">
          <p className="text-xs text-zinc-600">Powered by ZK Proofs & Stealth Addresses</p>
        </motion.div>
      </div>

      {/* Toast */}
      <AnimatePresence>
        {toast && <StatusToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>
    </main>
  );
}
