/**
 * Theme System - 8 Design Variations
 *
 * Each theme defines colors, gradients, and styling for the entire app.
 */

export type ThemeId =
  | 'violet-dark'      // 1. Current default
  | 'light'            // 2. Clean light mode
  | 'midnight'         // 3. Deep blue/cyan
  | 'stealth'          // 4. Muted gray minimal
  | 'cyberpunk'        // 5. Neon green/pink
  | 'sunset'           // 6. Orange/amber warm
  | 'ocean'            // 7. Teal/aqua
  | 'minimal';         // 8. Ultra-clean white

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;

  // Background
  bg: string;
  bgGradient: string;

  // Cards & Surfaces
  cardBg: string;
  cardBorder: string;
  cardHover: string;

  // Primary accent (main actions)
  primary: string;
  primaryHover: string;
  primaryText: string;
  primaryGlow: string;

  // Secondary accent (success states)
  secondary: string;
  secondaryHover: string;
  secondaryText: string;

  // Warning/Alert
  warning: string;
  warningBg: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;

  // Input fields
  inputBg: string;
  inputBorder: string;
  inputFocus: string;

  // Gradients for special elements
  gradientPrimary: string;
  gradientSecondary: string;
  gradientCard: string;

  // Misc
  divider: string;
  shadow: string;

  // Is it a dark theme?
  isDark: boolean;
}

export const themes: Record<ThemeId, Theme> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. VIOLET DARK (Current Default)
  // ═══════════════════════════════════════════════════════════════════════════
  'violet-dark': {
    id: 'violet-dark',
    name: 'Violet Dark',
    description: 'Default dark theme with violet and emerald accents',

    bg: 'bg-[#0a0a0b]',
    bgGradient: 'from-violet-900/10 to-emerald-900/10',

    cardBg: 'bg-zinc-900/50',
    cardBorder: 'border-zinc-800',
    cardHover: 'hover:bg-zinc-800/50',

    primary: 'bg-violet-600',
    primaryHover: 'hover:bg-violet-500',
    primaryText: 'text-violet-400',
    primaryGlow: 'shadow-violet-500/20',

    secondary: 'bg-emerald-600',
    secondaryHover: 'hover:bg-emerald-500',
    secondaryText: 'text-emerald-400',

    warning: 'text-amber-400',
    warningBg: 'bg-amber-900/20',

    textPrimary: 'text-white',
    textSecondary: 'text-zinc-400',
    textMuted: 'text-zinc-500',

    inputBg: 'bg-zinc-800',
    inputBorder: 'border-zinc-700',
    inputFocus: 'focus:border-violet-500',

    gradientPrimary: 'from-violet-600 to-purple-600',
    gradientSecondary: 'from-emerald-600 to-teal-600',
    gradientCard: 'from-violet-900/40 via-zinc-900/60 to-emerald-900/30',

    divider: 'border-zinc-800',
    shadow: 'shadow-xl shadow-black/20',

    isDark: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. LIGHT MODE
  // ═══════════════════════════════════════════════════════════════════════════
  'light': {
    id: 'light',
    name: 'Light',
    description: 'Clean light theme for daytime use',

    bg: 'bg-gray-50',
    bgGradient: 'from-violet-100/50 to-emerald-100/50',

    cardBg: 'bg-white',
    cardBorder: 'border-gray-200',
    cardHover: 'hover:bg-gray-50',

    primary: 'bg-violet-600',
    primaryHover: 'hover:bg-violet-700',
    primaryText: 'text-violet-600',
    primaryGlow: 'shadow-violet-500/30',

    secondary: 'bg-emerald-600',
    secondaryHover: 'hover:bg-emerald-700',
    secondaryText: 'text-emerald-600',

    warning: 'text-amber-600',
    warningBg: 'bg-amber-50',

    textPrimary: 'text-gray-900',
    textSecondary: 'text-gray-600',
    textMuted: 'text-gray-400',

    inputBg: 'bg-gray-100',
    inputBorder: 'border-gray-300',
    inputFocus: 'focus:border-violet-500',

    gradientPrimary: 'from-violet-600 to-purple-600',
    gradientSecondary: 'from-emerald-500 to-teal-500',
    gradientCard: 'from-violet-50 via-white to-emerald-50',

    divider: 'border-gray-200',
    shadow: 'shadow-lg shadow-gray-200/50',

    isDark: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. MIDNIGHT BLUE
  // ═══════════════════════════════════════════════════════════════════════════
  'midnight': {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep navy with cyan and blue accents',

    bg: 'bg-[#0a0f1a]',
    bgGradient: 'from-blue-900/20 to-cyan-900/10',

    cardBg: 'bg-slate-900/60',
    cardBorder: 'border-slate-700/50',
    cardHover: 'hover:bg-slate-800/60',

    primary: 'bg-blue-600',
    primaryHover: 'hover:bg-blue-500',
    primaryText: 'text-blue-400',
    primaryGlow: 'shadow-blue-500/30',

    secondary: 'bg-cyan-600',
    secondaryHover: 'hover:bg-cyan-500',
    secondaryText: 'text-cyan-400',

    warning: 'text-orange-400',
    warningBg: 'bg-orange-900/20',

    textPrimary: 'text-white',
    textSecondary: 'text-slate-300',
    textMuted: 'text-slate-500',

    inputBg: 'bg-slate-800',
    inputBorder: 'border-slate-600',
    inputFocus: 'focus:border-blue-500',

    gradientPrimary: 'from-blue-600 to-indigo-600',
    gradientSecondary: 'from-cyan-500 to-blue-500',
    gradientCard: 'from-blue-900/30 via-slate-900/60 to-cyan-900/20',

    divider: 'border-slate-700',
    shadow: 'shadow-xl shadow-blue-900/20',

    isDark: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. STEALTH (Minimal Gray)
  // ═══════════════════════════════════════════════════════════════════════════
  'stealth': {
    id: 'stealth',
    name: 'Stealth',
    description: 'Ultra-minimal monochromatic design',

    bg: 'bg-neutral-950',
    bgGradient: 'from-neutral-900/50 to-neutral-900/50',

    cardBg: 'bg-neutral-900/80',
    cardBorder: 'border-neutral-800',
    cardHover: 'hover:bg-neutral-800/80',

    primary: 'bg-neutral-700',
    primaryHover: 'hover:bg-neutral-600',
    primaryText: 'text-neutral-300',
    primaryGlow: 'shadow-neutral-500/10',

    secondary: 'bg-neutral-600',
    secondaryHover: 'hover:bg-neutral-500',
    secondaryText: 'text-neutral-400',

    warning: 'text-neutral-400',
    warningBg: 'bg-neutral-800',

    textPrimary: 'text-neutral-100',
    textSecondary: 'text-neutral-400',
    textMuted: 'text-neutral-600',

    inputBg: 'bg-neutral-800',
    inputBorder: 'border-neutral-700',
    inputFocus: 'focus:border-neutral-500',

    gradientPrimary: 'from-neutral-600 to-neutral-700',
    gradientSecondary: 'from-neutral-500 to-neutral-600',
    gradientCard: 'from-neutral-800/50 via-neutral-900/80 to-neutral-800/50',

    divider: 'border-neutral-800',
    shadow: 'shadow-xl shadow-black/40',

    isDark: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. CYBERPUNK (Neon)
  // ═══════════════════════════════════════════════════════════════════════════
  'cyberpunk': {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    description: 'Neon green and pink on dark background',

    bg: 'bg-[#0d0d0d]',
    bgGradient: 'from-fuchsia-900/20 to-green-900/20',

    cardBg: 'bg-black/60',
    cardBorder: 'border-fuchsia-900/50',
    cardHover: 'hover:bg-fuchsia-950/30',

    primary: 'bg-fuchsia-600',
    primaryHover: 'hover:bg-fuchsia-500',
    primaryText: 'text-fuchsia-400',
    primaryGlow: 'shadow-fuchsia-500/40',

    secondary: 'bg-green-500',
    secondaryHover: 'hover:bg-green-400',
    secondaryText: 'text-green-400',

    warning: 'text-yellow-400',
    warningBg: 'bg-yellow-900/20',

    textPrimary: 'text-white',
    textSecondary: 'text-fuchsia-200',
    textMuted: 'text-gray-500',

    inputBg: 'bg-black',
    inputBorder: 'border-fuchsia-800',
    inputFocus: 'focus:border-green-500',

    gradientPrimary: 'from-fuchsia-600 to-pink-600',
    gradientSecondary: 'from-green-500 to-emerald-500',
    gradientCard: 'from-fuchsia-900/30 via-black/80 to-green-900/20',

    divider: 'border-fuchsia-900/50',
    shadow: 'shadow-xl shadow-fuchsia-900/30',

    isDark: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SUNSET (Warm)
  // ═══════════════════════════════════════════════════════════════════════════
  'sunset': {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm orange and amber tones',

    bg: 'bg-[#1a1210]',
    bgGradient: 'from-orange-900/20 to-amber-900/10',

    cardBg: 'bg-stone-900/60',
    cardBorder: 'border-orange-900/30',
    cardHover: 'hover:bg-stone-800/60',

    primary: 'bg-orange-600',
    primaryHover: 'hover:bg-orange-500',
    primaryText: 'text-orange-400',
    primaryGlow: 'shadow-orange-500/30',

    secondary: 'bg-amber-600',
    secondaryHover: 'hover:bg-amber-500',
    secondaryText: 'text-amber-400',

    warning: 'text-red-400',
    warningBg: 'bg-red-900/20',

    textPrimary: 'text-white',
    textSecondary: 'text-orange-200',
    textMuted: 'text-stone-500',

    inputBg: 'bg-stone-800',
    inputBorder: 'border-orange-900/50',
    inputFocus: 'focus:border-orange-500',

    gradientPrimary: 'from-orange-600 to-red-600',
    gradientSecondary: 'from-amber-500 to-orange-500',
    gradientCard: 'from-orange-900/30 via-stone-900/80 to-amber-900/20',

    divider: 'border-stone-800',
    shadow: 'shadow-xl shadow-orange-900/20',

    isDark: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. OCEAN (Teal/Aqua)
  // ═══════════════════════════════════════════════════════════════════════════
  'ocean': {
    id: 'ocean',
    name: 'Ocean',
    description: 'Deep sea teal and aqua colors',

    bg: 'bg-[#0a1414]',
    bgGradient: 'from-teal-900/20 to-cyan-900/10',

    cardBg: 'bg-slate-900/60',
    cardBorder: 'border-teal-900/40',
    cardHover: 'hover:bg-teal-950/40',

    primary: 'bg-teal-600',
    primaryHover: 'hover:bg-teal-500',
    primaryText: 'text-teal-400',
    primaryGlow: 'shadow-teal-500/30',

    secondary: 'bg-cyan-600',
    secondaryHover: 'hover:bg-cyan-500',
    secondaryText: 'text-cyan-400',

    warning: 'text-amber-400',
    warningBg: 'bg-amber-900/20',

    textPrimary: 'text-white',
    textSecondary: 'text-teal-200',
    textMuted: 'text-slate-500',

    inputBg: 'bg-slate-800',
    inputBorder: 'border-teal-800',
    inputFocus: 'focus:border-teal-500',

    gradientPrimary: 'from-teal-600 to-cyan-600',
    gradientSecondary: 'from-cyan-500 to-blue-500',
    gradientCard: 'from-teal-900/30 via-slate-900/80 to-cyan-900/20',

    divider: 'border-teal-900/50',
    shadow: 'shadow-xl shadow-teal-900/20',

    isDark: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. MINIMAL (Ultra-clean)
  // ═══════════════════════════════════════════════════════════════════════════
  'minimal': {
    id: 'minimal',
    name: 'Minimal',
    description: 'Ultra-clean with subtle accents',

    bg: 'bg-white',
    bgGradient: 'from-gray-50 to-gray-100',

    cardBg: 'bg-white',
    cardBorder: 'border-gray-100',
    cardHover: 'hover:bg-gray-50',

    primary: 'bg-gray-900',
    primaryHover: 'hover:bg-gray-800',
    primaryText: 'text-gray-900',
    primaryGlow: 'shadow-gray-300/50',

    secondary: 'bg-gray-700',
    secondaryHover: 'hover:bg-gray-600',
    secondaryText: 'text-gray-700',

    warning: 'text-gray-600',
    warningBg: 'bg-gray-100',

    textPrimary: 'text-gray-900',
    textSecondary: 'text-gray-600',
    textMuted: 'text-gray-400',

    inputBg: 'bg-gray-50',
    inputBorder: 'border-gray-200',
    inputFocus: 'focus:border-gray-400',

    gradientPrimary: 'from-gray-800 to-gray-900',
    gradientSecondary: 'from-gray-600 to-gray-700',
    gradientCard: 'from-gray-50 via-white to-gray-50',

    divider: 'border-gray-100',
    shadow: 'shadow-sm shadow-gray-200/50',

    isDark: false,
  },
};

// Get theme by ID
export function getTheme(id: ThemeId): Theme {
  return themes[id] || themes['violet-dark'];
}

// Get all themes as array
export function getAllThemes(): Theme[] {
  return Object.values(themes);
}

// Storage key for persisting theme preference
const THEME_STORAGE_KEY = 'stealthsol_theme';

// Save theme preference
export function saveThemePreference(id: ThemeId): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  }
}

// Load theme preference
export function loadThemePreference(): ThemeId {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && themes[saved as ThemeId]) {
      return saved as ThemeId;
    }
  }
  return 'violet-dark';
}
