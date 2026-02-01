'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  Theme,
  ThemeId,
  themes,
  getTheme,
  getAllThemes,
  saveThemePreference,
  loadThemePreference,
} from './themes';

interface ThemeContextType {
  theme: Theme;
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
  allThemes: Theme[];
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<ThemeId>('violet-dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = loadThemePreference();
    setThemeId(saved);
  }, []);

  const setTheme = (id: ThemeId) => {
    console.log('[Theme] Changing to:', id);
    setThemeId(id);
    saveThemePreference(id);
  };

  const theme = getTheme(themeId);

  // Debug: log current theme
  console.log('[Theme] Current theme:', themeId, '| isDark:', theme.isDark);

  // Prevent hydration mismatch
  if (!mounted) {
    return <>{children}</>;
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        themeId,
        setTheme,
        allThemes: getAllThemes(),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  // Return default theme if no provider (for SSR)
  if (!context) {
    return {
      theme: themes['violet-dark'],
      themeId: 'violet-dark' as ThemeId,
      setTheme: () => {},
      allThemes: Object.values(themes),
    };
  }
  return context;
}

// Theme Switcher Component
export function ThemeSwitcher() {
  const { theme, themeId, setTheme, allThemes } = useTheme();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => {
          console.log('[ThemeSwitcher] Toggle dropdown, currently:', isOpen);
          setIsOpen(!isOpen);
        }}
        className={`p-2 rounded-lg ${theme.cardBg} ${theme.cardBorder} border transition-colors`}
        title={`Current: ${themeId} - Click to change`}
      >
        <div className="flex items-center gap-1">
          <div className={`w-3 h-3 rounded-full ${theme.primary}`} />
          <svg
            className={`w-5 h-5 ${theme.textSecondary}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
            />
          </svg>
        </div>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div
            className={`absolute right-0 top-full mt-2 w-64 rounded-xl ${theme.cardBg} ${theme.cardBorder} border ${theme.shadow} z-50 overflow-hidden`}
          >
            <div className={`p-3 border-b ${theme.divider}`}>
              <p className={`text-xs ${theme.textMuted} uppercase tracking-widest`}>
                Choose Theme
              </p>
            </div>
            <div className="p-2 max-h-80 overflow-y-auto">
              {allThemes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTheme(t.id);
                    setIsOpen(false);
                  }}
                  className={`w-full p-3 rounded-lg text-left transition-colors ${
                    themeId === t.id
                      ? `${t.primary} text-white`
                      : `${theme.cardHover} ${theme.textPrimary}`
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-lg ${t.primary} flex items-center justify-center`}
                    >
                      {t.isDark ? (
                        <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-sm">{t.name}</p>
                      <p className={`text-xs ${themeId === t.id ? 'text-white/70' : theme.textMuted}`}>
                        {t.description}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Compact inline theme switcher for mobile
export function ThemeSwitcherCompact() {
  const { themeId, setTheme, allThemes, theme } = useTheme();

  return (
    <div className="flex flex-wrap gap-2">
      {allThemes.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          className={`w-8 h-8 rounded-lg ${t.primary} transition-all ${
            themeId === t.id ? 'ring-2 ring-white ring-offset-2 ring-offset-black scale-110' : 'opacity-60 hover:opacity-100'
          }`}
          title={t.name}
        />
      ))}
    </div>
  );
}
