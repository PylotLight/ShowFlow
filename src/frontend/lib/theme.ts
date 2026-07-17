const STORAGE_KEY = 'showflow-accent-color';
const THEME_SETTINGS_KEY = 'showflow-theme';

export const THEME_PRESETS = [
  { color: '#19b7a6', label: 'teal' },
  { color: '#ff6a65', label: 'coral' },
  { color: '#9775fa', label: 'violet' },
  { color: '#58a6ff', label: 'blue' },
  { color: '#f0c94b', label: 'gold' },
];

export interface ThemeConfig {
  signal: string;
  accentAmber: string;
  fontDisplay: string;
  fontMono: string;
  fontSans: string;
  fontSizeCaption: string;
  fontSizeSub: string;
  fontSizeSm: string;
  fontSizeBase: string;
  radius: string;
  background: string;
  foreground: string;
  surfaceGlass: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  mutedForeground: string;
  border: string;
  input: string;
}

const DEFAULTS: ThemeConfig = {
  signal: '#19b7a6',
  accentAmber: 'oklch(0.8 0.15 80)',
  fontDisplay: '"Barlow Condensed", "Archivo Expanded", ui-sans-serif, sans-serif',
  fontMono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
  fontSans: '"Inter", ui-sans-serif, sans-serif',
  fontSizeCaption: '0.75rem',
  fontSizeSub: '0.8125rem',
  fontSizeSm: '0.9375rem',
  fontSizeBase: '1rem',
  radius: '0.625rem',
  background: '#0b0e1a',
  foreground: '#f0f2f6',
  surfaceGlass: '#181c2e',
  card: '#131724',
  cardForeground: '#f0f2f6',
  popover: '#131724',
  popoverForeground: '#f0f2f6',
  mutedForeground: '#8b8fa3',
  border: '#ffffff1a',
  input: '#ffffff1f',
};

const CSS_VAR_MAP: Record<keyof ThemeConfig, string> = {
  signal: '--signal',
  accentAmber: '--accent-amber',
  fontDisplay: '--font-display',
  fontMono: '--font-mono',
  fontSans: '--font-sans',
  fontSizeCaption: '--text-caption',
  fontSizeSub: '--text-sub',
  fontSizeSm: '--text-sm',
  fontSizeBase: '--text-base',
  radius: '--radius',
  background: '--background',
  foreground: '--foreground',
  surfaceGlass: '--surface-glass',
  card: '--card',
  cardForeground: '--card-foreground',
  popover: '--popover',
  popoverForeground: '--popover-foreground',
  mutedForeground: '--muted-foreground',
  border: '--border',
  input: '--input',
};

export async function loadTheme(): Promise<ThemeConfig> {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    const raw = settings.find((s: any) => s.key === THEME_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw.value);
      return { ...DEFAULTS, ...parsed };
    }
  } catch {}
  return getLocalTheme();
}

export async function saveTheme(theme: ThemeConfig): Promise<void> {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: THEME_SETTINGS_KEY, value: theme }),
    });
  } catch {}
  try { localStorage.setItem(THEME_SETTINGS_KEY, JSON.stringify(theme)); } catch {}
}

function getLocalTheme(): ThemeConfig {
  try {
    const raw = localStorage.getItem(THEME_SETTINGS_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

export function applyTheme(theme: ThemeConfig) {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    const val = (theme as any)[key];
    if (val) root.style.setProperty(cssVar, val);
  }
  root.style.setProperty('--signal-foreground', '#ffffff');
  root.style.setProperty('--primary', theme.signal);
  root.style.setProperty('--primary-foreground', '#ffffff');
  root.style.setProperty('--ring', theme.signal);
  root.style.setProperty('--sidebar-primary', theme.signal);
  root.style.setProperty('--sidebar-ring', theme.signal);
}

export function loadAccent(): string {
  try { return localStorage.getItem(STORAGE_KEY) || DEFAULTS.signal; } catch { return DEFAULTS.signal; }
}

export function saveAccent(color: string) {
  try { localStorage.setItem(STORAGE_KEY, color); } catch {}
}

export function applyAccent(color: string) {
  const root = document.documentElement;
  root.style.setProperty('--signal', color);
  root.style.setProperty('--signal-foreground', '#ffffff');
}
