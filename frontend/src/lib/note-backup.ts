/**
 * Complete Privacy Wallet Backup (Manual Export/Import)
 *
 * Zero network requests. Maximum privacy.
 *
 * What's included in backup:
 * 1. Deposit notes (veil_deposit_notes) - your shielded funds
 * 2. Identity keys (stealthsol_keys) - scan/spend keypair for receiving stealth payments
 * 3. Pending withdrawals (veil_pending_withdrawals) - queued withdrawal operations
 *
 * How it works:
 * 1. User signs a challenge message with their wallet
 * 2. Signature derives an AES-256-GCM encryption key
 * 3. All data is encrypted and downloaded as a .veil file
 * 4. To restore: user selects file, signs to decrypt
 *
 * No server. No metadata. No IP logging.
 */

import { loadDepositNotes, saveDepositNote, type DepositNote } from './privacy-backend';
import { loadKeys, saveKeys, type StealthKeys } from './stealth';

// Challenge message for deriving encryption key
const BACKUP_CHALLENGE = 'stealthsol-backup-v2:sign-to-encrypt-wallet';

// Backup file format version
const BACKUP_VERSION = 2;

// localStorage keys
const PENDING_WITHDRAWALS_KEY = 'veil_pending_withdrawals_encrypted';
const ENCRYPTION_SALT_KEY = 'veil_encryption_salt';

/**
 * Complete backup data structure
 */
interface BackupData {
  version: number;
  timestamp: number;
  depositNotes: SerializedDepositNote[];
  identityKeys: SerializedKeys | null;
  pendingWithdrawals: SerializedPendingWithdrawal[];
  encryptionSalt: string | null;
}

interface SerializedDepositNote {
  nullifier: string;
  secret: string;
  commitment: string; // hex
  denomination: string;
  leafIndex: number;
  timestamp: number;
  txSignature?: string;
  merkleRoot?: string;
  merklePath?: string[];
}

interface SerializedKeys {
  scanSecret: string;
  spendSecret: string;
  scanPubkey: string;
  spendPubkey: string;
}

interface SerializedPendingWithdrawal {
  id: string;
  amountSol: number;
  recipientMetaAddress?: string;
  createdAt: number;
  executeAfter: number;
  status: string;
  txId?: string;
  error?: string;
}

/**
 * Derive encryption key from wallet signature
 */
export async function deriveBackupKeys(signature: Uint8Array): Promise<{
  storageKey: string;
  encryptKey: CryptoKey;
}> {
  // Create a fresh ArrayBuffer to avoid SharedArrayBuffer issues
  const sigCopy = new Uint8Array(signature.length);
  sigCopy.set(signature);
  const hashBuffer = await crypto.subtle.digest('SHA-512', sigCopy);
  const hashArray = new Uint8Array(hashBuffer);

  // First 16 bytes → storage key (unused but kept for compatibility)
  const storageKeyBytes = hashArray.slice(0, 16);
  const storageKey = Array.from(storageKeyBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Next 32 bytes → AES-GCM encryption key
  const encryptKeyBytes = hashArray.slice(16, 48);
  const encryptKey = await crypto.subtle.importKey(
    'raw',
    encryptKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return { storageKey, encryptKey };
}

/**
 * Encrypt backup data
 */
async function encryptBackup(data: BackupData, encryptKey: CryptoKey): Promise<string> {
  const serialized = JSON.stringify(data);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(serialized);

  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt - create fresh copy to avoid SharedArrayBuffer issues
  const plaintextCopy = new Uint8Array(plaintext.length);
  plaintextCopy.set(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptKey,
    plaintextCopy
  );

  // Combine IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt backup data
 */
async function decryptBackup(encryptedBase64: string, encryptKey: CryptoKey): Promise<BackupData> {
  const combined = new Uint8Array(
    atob(encryptedBase64).split('').map(c => c.charCodeAt(0))
  );

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    encryptKey,
    ciphertext
  );

  const decoder = new TextDecoder();
  const json = decoder.decode(decrypted);

  return JSON.parse(json);
}

/**
 * Serialize deposit notes for backup
 */
function serializeDepositNotes(notes: DepositNote[]): SerializedDepositNote[] {
  return notes.map(n => ({
    nullifier: n.nullifier.toString(),
    secret: n.secret.toString(),
    commitment: Buffer.from(n.commitment).toString('hex'),
    denomination: n.denomination.toString(),
    leafIndex: n.leafIndex,
    timestamp: n.timestamp,
    txSignature: n.txSignature,
    merkleRoot: n.merkleRoot ? Buffer.from(n.merkleRoot).toString('hex') : undefined,
    merklePath: n.merklePath ? n.merklePath.map(p => Buffer.from(p).toString('hex')) : undefined,
  }));
}

/**
 * Deserialize deposit notes from backup
 */
function deserializeDepositNotes(serialized: SerializedDepositNote[]): DepositNote[] {
  return serialized.map(n => ({
    nullifier: BigInt(n.nullifier),
    secret: BigInt(n.secret),
    commitment: new Uint8Array(Buffer.from(n.commitment, 'hex')),
    denomination: BigInt(n.denomination),
    leafIndex: n.leafIndex,
    timestamp: n.timestamp,
    txSignature: n.txSignature,
    merkleRoot: n.merkleRoot ? new Uint8Array(Buffer.from(n.merkleRoot, 'hex')) : undefined,
    merklePath: n.merklePath ? n.merklePath.map(p => new Uint8Array(Buffer.from(p, 'hex'))) : undefined,
  }));
}

/**
 * Load pending withdrawals from raw localStorage (without session encryption)
 * Note: These are encrypted with session key, so we store the raw encrypted blob
 */
function loadRawPendingWithdrawals(): { encrypted: string | null; salt: string | null } {
  if (typeof window === 'undefined') return { encrypted: null, salt: null };

  return {
    encrypted: localStorage.getItem(PENDING_WITHDRAWALS_KEY),
    salt: localStorage.getItem(ENCRYPTION_SALT_KEY),
  };
}

/**
 * Save raw pending withdrawals to localStorage
 */
function saveRawPendingWithdrawals(encrypted: string | null, salt: string | null): void {
  if (typeof window === 'undefined') return;

  if (encrypted) {
    localStorage.setItem(PENDING_WITHDRAWALS_KEY, encrypted);
  }
  if (salt) {
    localStorage.setItem(ENCRYPTION_SALT_KEY, salt);
  }
}

/**
 * Trigger file download in browser
 */
function downloadFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export complete wallet backup as encrypted .veil file
 *
 * Includes:
 * - Deposit notes (shielded funds)
 * - Identity keys (stealth address keypair)
 * - Pending withdrawals (session-encrypted, preserved as-is)
 *
 * @param signMessage - Wallet's signMessage function
 * @returns Object with counts of exported items, or error
 */
export async function exportNotesToFile(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<{ notes: number; hasKeys: boolean; hasPending: boolean } | -1> {
  try {
    const challenge = new TextEncoder().encode(BACKUP_CHALLENGE);
    const signature = await signMessage(challenge);
    const { encryptKey } = await deriveBackupKeys(signature);

    // Gather all data
    const depositNotes = loadDepositNotes();
    const identityKeys = loadKeys();
    const { encrypted: pendingEncrypted, salt: encryptionSalt } = loadRawPendingWithdrawals();

    // Check if there's anything to export
    if (depositNotes.length === 0 && !identityKeys && !pendingEncrypted) {
      console.log('[Backup] No data to export');
      return { notes: 0, hasKeys: false, hasPending: false };
    }

    // Serialize identity keys
    let serializedKeys: SerializedKeys | null = null;
    if (identityKeys) {
      // Keys are stored as Uint8Array, need to convert to base64 for backup
      serializedKeys = {
        scanSecret: btoa(String.fromCharCode(...identityKeys.scanSecret)),
        spendSecret: btoa(String.fromCharCode(...identityKeys.spendSecret)),
        scanPubkey: btoa(String.fromCharCode(...identityKeys.scanPubkey)),
        spendPubkey: btoa(String.fromCharCode(...identityKeys.spendPubkey)),
      };
    }

    // Build backup data
    const backupData: BackupData = {
      version: BACKUP_VERSION,
      timestamp: Date.now(),
      depositNotes: serializeDepositNotes(depositNotes),
      identityKeys: serializedKeys,
      pendingWithdrawals: [], // We store raw encrypted blob separately
      encryptionSalt,
    };

    // If there are pending withdrawals, include the encrypted blob
    // (We can't decrypt it without the session key, so preserve as-is)
    if (pendingEncrypted) {
      // Store as a special field in the backup
      (backupData as any).rawPendingWithdrawals = pendingEncrypted;
    }

    const encrypted = await encryptBackup(backupData, encryptKey);

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `veil-backup-${timestamp}.veil`;

    downloadFile(encrypted, filename);

    console.log(`[Backup] Exported complete wallet backup to ${filename}`);
    console.log(`[Backup]   - ${depositNotes.length} deposit notes`);
    console.log(`[Backup]   - Identity keys: ${identityKeys ? 'yes' : 'no'}`);
    console.log(`[Backup]   - Pending withdrawals: ${pendingEncrypted ? 'yes' : 'no'}`);

    return {
      notes: depositNotes.length,
      hasKeys: !!identityKeys,
      hasPending: !!pendingEncrypted,
    };
  } catch (err) {
    console.error('[Backup] Export failed:', err);
    return -1;
  }
}

/**
 * Import complete wallet backup from encrypted .veil file
 *
 * Restores:
 * - Deposit notes (merged with existing, no duplicates)
 * - Identity keys (overwrites existing)
 * - Pending withdrawals (overwrites existing)
 *
 * @param fileContent - Contents of the .veil file
 * @param signMessage - Wallet's signMessage function
 * @returns Object with counts of imported items, or -1 on error
 */
export async function importNotesFromFile(
  fileContent: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<{ notes: number; keysRestored: boolean; pendingRestored: boolean } | -1> {
  try {
    const challenge = new TextEncoder().encode(BACKUP_CHALLENGE);
    const signature = await signMessage(challenge);
    const { encryptKey } = await deriveBackupKeys(signature);

    const backupData = await decryptBackup(fileContent.trim(), encryptKey);

    // Handle version differences
    if (backupData.version === 1 || !backupData.version) {
      // V1 backup - only contains deposit notes
      console.log('[Backup] Detected v1 backup format, importing notes only');
      const notes = deserializeDepositNotes(backupData.depositNotes || []);

      const existingNotes = loadDepositNotes();
      const existingCommitments = new Set(
        existingNotes.map(n => Buffer.from(n.commitment).toString('hex'))
      );

      let imported = 0;
      for (const note of notes) {
        const commitmentHex = Buffer.from(note.commitment).toString('hex');
        if (!existingCommitments.has(commitmentHex)) {
          saveDepositNote(note);
          imported++;
        }
      }

      return { notes: imported, keysRestored: false, pendingRestored: false };
    }

    // V2 backup - full wallet backup
    console.log('[Backup] Detected v2 backup format, importing complete wallet');

    // 1. Import deposit notes (merge, no duplicates)
    const notes = deserializeDepositNotes(backupData.depositNotes || []);
    const existingNotes = loadDepositNotes();
    const existingCommitments = new Set(
      existingNotes.map(n => Buffer.from(n.commitment).toString('hex'))
    );

    let notesImported = 0;
    for (const note of notes) {
      const commitmentHex = Buffer.from(note.commitment).toString('hex');
      if (!existingCommitments.has(commitmentHex)) {
        saveDepositNote(note);
        notesImported++;
      }
    }

    // 2. Import identity keys (overwrite)
    let keysRestored = false;
    if (backupData.identityKeys) {
      const keys: StealthKeys = {
        scanSecret: new Uint8Array(atob(backupData.identityKeys.scanSecret).split('').map(c => c.charCodeAt(0))),
        spendSecret: new Uint8Array(atob(backupData.identityKeys.spendSecret).split('').map(c => c.charCodeAt(0))),
        scanPubkey: new Uint8Array(atob(backupData.identityKeys.scanPubkey).split('').map(c => c.charCodeAt(0))),
        spendPubkey: new Uint8Array(atob(backupData.identityKeys.spendPubkey).split('').map(c => c.charCodeAt(0))),
      };
      saveKeys(keys);
      keysRestored = true;
      console.log('[Backup] Identity keys restored');
    }

    // 3. Import pending withdrawals (overwrite)
    let pendingRestored = false;
    const rawPending = (backupData as any).rawPendingWithdrawals;
    if (rawPending && backupData.encryptionSalt) {
      saveRawPendingWithdrawals(rawPending, backupData.encryptionSalt);
      pendingRestored = true;
      console.log('[Backup] Pending withdrawals restored');
    }

    console.log(`[Backup] Import complete:`);
    console.log(`[Backup]   - ${notesImported} new notes (${notes.length - notesImported} already existed)`);
    console.log(`[Backup]   - Identity keys: ${keysRestored ? 'restored' : 'not in backup'}`);
    console.log(`[Backup]   - Pending withdrawals: ${pendingRestored ? 'restored' : 'not in backup'}`);

    return {
      notes: notesImported,
      keysRestored,
      pendingRestored,
    };
  } catch (err) {
    console.error('[Backup] Import failed:', err);
    return -1;
  }
}

/**
 * Get the backup challenge message (for display to user)
 */
export function getBackupChallenge(): string {
  return BACKUP_CHALLENGE;
}
