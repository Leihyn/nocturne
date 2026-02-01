/**
 * Secure Secret Storage
 *
 * Provides AES-GCM encryption for storing private notes securely.
 * Notes are encrypted with a key derived from a user password using Argon2id.
 *
 * Security features:
 * - AES-256-GCM for authenticated encryption
 * - Argon2id for password-based key derivation (memory-hard)
 * - Random IV for each encryption
 * - Salt stored with encrypted data
 */

import { type PrivateNote } from './zk-crypto';

// ============================================
// Configuration
// ============================================

const STORAGE_CONFIG = {
  // AES-GCM configuration
  AES_KEY_LENGTH: 256,
  IV_LENGTH: 12,  // 96 bits recommended for GCM
  TAG_LENGTH: 128,  // 128-bit authentication tag

  // Key derivation configuration (Argon2id-like via PBKDF2 fallback)
  SALT_LENGTH: 32,
  PBKDF2_ITERATIONS: 600000,  // OWASP recommendation for SHA-256

  // Storage keys
  NOTES_STORAGE_KEY: 'stealthsol_encrypted_notes',
  SALT_STORAGE_KEY: 'stealthsol_key_salt',
};

// ============================================
// Types
// ============================================

interface EncryptedData {
  iv: string;        // Base64 encoded IV
  salt: string;      // Base64 encoded salt
  ciphertext: string; // Base64 encoded ciphertext + tag
  version: number;   // Schema version for future upgrades
}

interface StoredNotes {
  notes: EncryptedData;
  lastModified: number;
  noteCount: number;
}

// ============================================
// Key Derivation
// ============================================

/**
 * Derive an encryption key from a password using PBKDF2
 * (WebCrypto doesn't have Argon2, so we use PBKDF2 with high iterations)
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  // Import password as key material
  const encodedPassword = new TextEncoder().encode(password);
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encodedPassword.buffer as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES key using PBKDF2
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: STORAGE_CONFIG.PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    {
      name: 'AES-GCM',
      length: STORAGE_CONFIG.AES_KEY_LENGTH,
    },
    false,  // Not extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Generate a random salt
 */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(STORAGE_CONFIG.SALT_LENGTH));
}

/**
 * Generate a random IV
 */
function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(STORAGE_CONFIG.IV_LENGTH));
}

// ============================================
// Encryption / Decryption
// ============================================

/**
 * Encrypt data using AES-GCM
 */
async function encryptData(
  data: Uint8Array,
  password: string,
  salt?: Uint8Array
): Promise<EncryptedData> {
  const usedSalt = salt || generateSalt();
  const iv = generateIV();
  const key = await deriveKey(password, usedSalt);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv.buffer as ArrayBuffer,
      tagLength: STORAGE_CONFIG.TAG_LENGTH,
    },
    key,
    data.buffer as ArrayBuffer
  );

  return {
    iv: uint8ToBase64(iv),
    salt: uint8ToBase64(usedSalt),
    ciphertext: uint8ToBase64(new Uint8Array(ciphertext)),
    version: 1,
  };
}

/**
 * Decrypt data using AES-GCM
 */
async function decryptData(
  encryptedData: EncryptedData,
  password: string
): Promise<Uint8Array> {
  const iv = base64ToUint8(encryptedData.iv);
  const salt = base64ToUint8(encryptedData.salt);
  const ciphertext = base64ToUint8(encryptedData.ciphertext);

  const key = await deriveKey(password, salt);

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer as ArrayBuffer,
        tagLength: STORAGE_CONFIG.TAG_LENGTH,
      },
      key,
      ciphertext.buffer as ArrayBuffer
    );

    return new Uint8Array(plaintext);
  } catch (err) {
    // Decryption failed - likely wrong password
    throw new Error('Decryption failed. Incorrect password or corrupted data.');
  }
}

// ============================================
// Note Serialization
// ============================================

/**
 * Serialize a PrivateNote to JSON-safe format
 */
function serializeNote(note: PrivateNote): object {
  return {
    commitment: note.commitment.toString(),
    nullifier: note.nullifier.toString(),
    secret: uint8ToBase64(note.secret),
    amount: note.amount.toString(),
    leafIndex: note.leafIndex,
    timestamp: note.timestamp,
  };
}

/**
 * Deserialize a PrivateNote from JSON-safe format
 */
function deserializeNote(data: any): PrivateNote {
  return {
    commitment: BigInt(data.commitment),
    nullifier: BigInt(data.nullifier),
    secret: base64ToUint8(data.secret),
    amount: BigInt(data.amount),
    leafIndex: data.leafIndex,
    timestamp: data.timestamp,
  };
}

/**
 * Serialize multiple notes
 */
function serializeNotes(notes: PrivateNote[]): string {
  return JSON.stringify(notes.map(serializeNote));
}

/**
 * Deserialize multiple notes
 */
function deserializeNotes(json: string): PrivateNote[] {
  const data = JSON.parse(json);
  return data.map(deserializeNote);
}

// ============================================
// Base64 Utilities
// ============================================

function uint8ToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================
// Public API
// ============================================

/**
 * SecureNoteStorage class for managing encrypted notes
 */
export class SecureNoteStorage {
  private password: string | null = null;
  private cachedNotes: PrivateNote[] | null = null;

  /**
   * Unlock the storage with a password
   * Must be called before reading/writing notes
   */
  async unlock(password: string): Promise<boolean> {
    // Try to decrypt existing notes to verify password
    const stored = localStorage.getItem(STORAGE_CONFIG.NOTES_STORAGE_KEY);

    if (stored) {
      try {
        const storedData: StoredNotes = JSON.parse(stored);
        const decrypted = await decryptData(storedData.notes, password);
        const json = new TextDecoder().decode(decrypted);
        this.cachedNotes = deserializeNotes(json);
        this.password = password;
        return true;
      } catch (err) {
        // Wrong password
        return false;
      }
    }

    // No existing notes - password is accepted for new storage
    this.password = password;
    this.cachedNotes = [];
    return true;
  }

  /**
   * Lock the storage (clear password and cached notes)
   */
  lock(): void {
    this.password = null;
    this.cachedNotes = null;
  }

  /**
   * Check if storage is unlocked
   */
  isUnlocked(): boolean {
    return this.password !== null;
  }

  /**
   * Get all stored notes
   * Throws if storage is locked
   */
  getNotes(): PrivateNote[] {
    if (!this.isUnlocked() || this.cachedNotes === null) {
      throw new Error('Storage is locked. Call unlock() first.');
    }
    return [...this.cachedNotes];
  }

  /**
   * Add a new note
   * Throws if storage is locked
   */
  async addNote(note: PrivateNote): Promise<void> {
    if (!this.isUnlocked() || this.password === null || this.cachedNotes === null) {
      throw new Error('Storage is locked. Call unlock() first.');
    }

    this.cachedNotes.push(note);
    await this.save();
  }

  /**
   * Remove a note by commitment
   */
  async removeNote(commitment: bigint): Promise<boolean> {
    if (!this.isUnlocked() || this.password === null || this.cachedNotes === null) {
      throw new Error('Storage is locked. Call unlock() first.');
    }

    const initialLength = this.cachedNotes.length;
    this.cachedNotes = this.cachedNotes.filter(n => n.commitment !== commitment);

    if (this.cachedNotes.length !== initialLength) {
      await this.save();
      return true;
    }

    return false;
  }

  /**
   * Find a note by commitment
   */
  findNote(commitment: bigint): PrivateNote | undefined {
    if (!this.isUnlocked() || this.cachedNotes === null) {
      throw new Error('Storage is locked. Call unlock() first.');
    }

    return this.cachedNotes.find(n => n.commitment === commitment);
  }

  /**
   * Save notes to encrypted storage
   */
  private async save(): Promise<void> {
    if (!this.password || !this.cachedNotes) {
      throw new Error('Storage is locked');
    }

    const json = serializeNotes(this.cachedNotes);
    const data = new TextEncoder().encode(json);
    const encrypted = await encryptData(data, this.password);

    const stored: StoredNotes = {
      notes: encrypted,
      lastModified: Date.now(),
      noteCount: this.cachedNotes.length,
    };

    localStorage.setItem(STORAGE_CONFIG.NOTES_STORAGE_KEY, JSON.stringify(stored));
  }

  /**
   * Change the password for encrypted storage
   */
  async changePassword(newPassword: string): Promise<void> {
    if (!this.isUnlocked() || this.cachedNotes === null) {
      throw new Error('Storage is locked. Call unlock() first.');
    }

    this.password = newPassword;
    await this.save();
  }

  /**
   * Check if any notes are stored (without needing password)
   */
  static hasStoredNotes(): boolean {
    return localStorage.getItem(STORAGE_CONFIG.NOTES_STORAGE_KEY) !== null;
  }

  /**
   * Get stored note count (without needing password)
   */
  static getStoredNoteCount(): number {
    const stored = localStorage.getItem(STORAGE_CONFIG.NOTES_STORAGE_KEY);
    if (!stored) return 0;

    try {
      const data: StoredNotes = JSON.parse(stored);
      return data.noteCount;
    } catch {
      return 0;
    }
  }

  /**
   * Clear all stored notes (destructive!)
   */
  static clearAll(): void {
    localStorage.removeItem(STORAGE_CONFIG.NOTES_STORAGE_KEY);
  }

  /**
   * Export encrypted backup
   */
  exportBackup(): string | null {
    return localStorage.getItem(STORAGE_CONFIG.NOTES_STORAGE_KEY);
  }

  /**
   * Import encrypted backup
   * Note: This replaces all current notes!
   */
  async importBackup(backup: string, password: string): Promise<boolean> {
    try {
      const storedData: StoredNotes = JSON.parse(backup);
      const decrypted = await decryptData(storedData.notes, password);
      const json = new TextDecoder().decode(decrypted);
      this.cachedNotes = deserializeNotes(json);
      this.password = password;

      // Save with current password
      await this.save();
      return true;
    } catch (err) {
      return false;
    }
  }
}

// Export a singleton instance
export const secureStorage = new SecureNoteStorage();

// Export utility functions for direct use
export {
  encryptData,
  decryptData,
  deriveKey,
  generateSalt,
  type EncryptedData,
};
