import { Loader2Icon } from "lucide-react";
import * as React from "react";

import { applyAccent, applyTheme, loadAccent, loadTheme, saveAccent, saveTheme, type ThemeConfig } from "@frontend/lib/theme";

import { AppearanceTab } from "../AppearanceTab";

export function AppearanceSettings() {
  const [accent, setAccent] = React.useState(loadAccent);
  const [theme, setTheme] = React.useState<ThemeConfig | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    loadTheme().then(t => { if (!cancelled) setTheme(t); });
    return () => { cancelled = true; };
  }, []);

  function updateTheme(updates: Record<string, any>) {
    if (!theme) return;
    const next = { ...theme, ...updates };
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  }

  function handleAccentChange(color: string) {
    setAccent(color);
    saveAccent(color);
    applyAccent(color);
  }

  if (!theme) return <div className="flex justify-center py-16"><Loader2Icon className="size-5 animate-spin text-muted-foreground" /></div>;
  return <AppearanceTab theme={theme} accent={accent} updateTheme={updateTheme} setAccent={handleAccentChange} />;
}
