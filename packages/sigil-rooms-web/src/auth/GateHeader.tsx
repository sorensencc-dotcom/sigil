const THEME_OPTIONS = [
  { value: 'rewrite-labs', label: 'Rewrite Labs' },
  { value: 'cast-iron-charlie', label: 'Cast Iron Charlie (Dark)' },
  { value: 'cast-iron-charlie-light', label: 'Cast Iron Charlie (Paper)' },
];

export function ThemeSelect({ theme, onThemeChange }: { theme: string; onThemeChange: (next: string) => void }) {
  return (
    <select aria-label="Theme" className="theme-select" value={theme} onChange={(e) => onThemeChange(e.target.value)}>
      {THEME_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Branded title row shared by every sign-in screen, with the theme picker when the caller supplies one. */
export function GateHeader({ theme, onThemeChange }: { theme?: string; onThemeChange?: (next: string) => void }) {
  return (
    <div className="gate-header">
      <h1>Sigil rooms</h1>
      {onThemeChange && theme ? <ThemeSelect theme={theme} onThemeChange={onThemeChange} /> : null}
    </div>
  );
}
