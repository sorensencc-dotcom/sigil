/** A struck line over an amber line: the Rewrite Labs mark. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect className="mark__tile" x="0.5" y="0.5" width="27" height="27" rx="6" />
      <rect className="mark__old" x="6" y="8" width="16" height="4" rx="1" />
      <path className="mark__strike" d="M4.5 11 L23.5 9" />
      <rect className="mark__new" x="6" y="16" width="16" height="4" rx="1" />
    </svg>
  );
}

/** Stored values from the retired three-theme picker still load: the paper one maps to light, the rest to dark. */
export function normalizeTheme(value: string | null | undefined): 'dark' | 'light' {
  return value === 'light' || value === 'cast-iron-charlie-light' ? 'light' : 'dark';
}

export function ThemeToggle({ theme, onThemeChange }: { theme: string; onThemeChange: (next: string) => void }) {
  const next = normalizeTheme(theme) === 'light' ? 'dark' : 'light';
  return (
    <button type="button" className="theme-toggle" aria-label={`Switch to ${next} theme`} onClick={() => onThemeChange(next)}>
      <svg className="theme-toggle__sun" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
      <svg className="theme-toggle__moon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** Branded title row shared by every sign-in screen, with the theme toggle when the caller supplies one. */
export function GateHeader({ theme, onThemeChange }: { theme?: string; onThemeChange?: (next: string) => void }) {
  return (
    <div className="gate-header">
      <h1 className="wordmark">
        <Mark />
        <span>
          Sigil <span className="wordmark__sub">rooms</span>
        </span>
      </h1>
      {onThemeChange && theme ? <ThemeToggle theme={theme} onThemeChange={onThemeChange} /> : null}
    </div>
  );
}
