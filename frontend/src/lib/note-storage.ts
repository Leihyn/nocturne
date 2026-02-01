/**
 * Note Storage - Auto-save withdrawal keys to localStorage
 *
 * Prevents users from losing funds by automatically saving note codes
 * after successful deposits.
 */

export interface SavedNote {
  id: string;
  noteCode: string;
  amount: number;
  denomination: number;
  createdAt: number;
  depositTx?: string;
  label?: string;
  used: boolean;
  usedAt?: number;
  withdrawTx?: string;
}

const STORAGE_KEY = 'stealthsol_notes';

/**
 * Get all saved notes
 */
export function getSavedNotes(): SavedNote[] {
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
 * Save a new note after deposit
 */
export function saveNote(
  noteCode: string,
  amount: number,
  denomination: number,
  depositTx?: string,
  label?: string
): SavedNote {
  const notes = getSavedNotes();

  // Check if note already exists
  const existing = notes.find(n => n.noteCode === noteCode);
  if (existing) return existing;

  const newNote: SavedNote = {
    id: generateId(),
    noteCode,
    amount,
    denomination,
    createdAt: Date.now(),
    depositTx,
    label,
    used: false,
  };

  notes.unshift(newNote); // Add to beginning
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));

  return newNote;
}

/**
 * Mark a note as used after successful withdrawal
 */
export function markNoteUsed(noteCode: string, withdrawTx?: string): void {
  const notes = getSavedNotes();
  const note = notes.find(n => n.noteCode === noteCode);

  if (note) {
    note.used = true;
    note.usedAt = Date.now();
    note.withdrawTx = withdrawTx;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  }
}

/**
 * Delete a note (with confirmation recommended)
 */
export function deleteNote(id: string): void {
  const notes = getSavedNotes();
  const filtered = notes.filter(n => n.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

/**
 * Get unused notes only
 */
export function getUnusedNotes(): SavedNote[] {
  return getSavedNotes().filter(n => !n.used);
}

/**
 * Get used notes only
 */
export function getUsedNotes(): SavedNote[] {
  return getSavedNotes().filter(n => n.used);
}

/**
 * Clear all used notes (cleanup)
 */
export function clearUsedNotes(): void {
  const notes = getSavedNotes().filter(n => !n.used);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

/**
 * Update note label
 */
export function updateNoteLabel(id: string, label: string): void {
  const notes = getSavedNotes();
  const note = notes.find(n => n.id === id);
  if (note) {
    note.label = label;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  }
}

/**
 * Get note by code
 */
export function getNoteByCode(noteCode: string): SavedNote | undefined {
  return getSavedNotes().find(n => n.noteCode === noteCode);
}

/**
 * Format amount for display
 */
export function formatNoteAmount(note: SavedNote): string {
  return `${note.amount} SOL`;
}

/**
 * Format time ago
 */
export function formatTimeAgo(timestamp: number): string {
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
 * Export notes for backup
 */
export function exportNotes(): string {
  const notes = getSavedNotes();
  return JSON.stringify(notes, null, 2);
}

/**
 * Import notes from backup
 */
export function importNotes(jsonString: string): number {
  try {
    const imported = JSON.parse(jsonString) as SavedNote[];
    const existing = getSavedNotes();
    const existingCodes = new Set(existing.map(n => n.noteCode));

    let added = 0;
    for (const note of imported) {
      if (!existingCodes.has(note.noteCode)) {
        existing.push(note);
        added++;
      }
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    return added;
  } catch {
    return 0;
  }
}
