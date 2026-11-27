import { useEffect, useState } from 'react';

const DENSITY_KEY = 'sigil.density';
type Density = 'comfortable' | 'compact';

function load(): Density {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
}

export function DensityToggle() {
  const [density, setDensity] = useState<Density>(load);
  useEffect(() => {
    document.documentElement.dataset.density = density;
    return () => { delete document.documentElement.dataset.density; };
  }, [density]);
  const compact = density === 'compact';
  return (
    <button
      type="button"
      className="ghost"
      aria-pressed={compact}
      onClick={() => {
        const next: Density = compact ? 'comfortable' : 'compact';
        setDensity(next);
        try { localStorage.setItem(DENSITY_KEY, next); } catch { /* ignore */ }
      }}
    >
      {compact ? 'Compact' : 'Comfortable'}
    </button>
  );
}
