import * as React from "react";

export type SaveMsg = { ok: boolean; text: string } | null;

interface SettingsContextValue {
  /** /api/config, shared by General, Providers, Naming, Downloads, Integrations. */
  config: any;
  saveConfig: (updates: Record<string, any>) => void;
  updateApiKey: (provider: string, value: string) => void;
  /** Parsed value of a /api/settings row (prowlarr, sonarr, ...), or undefined. */
  getSetting: (key: string) => any;
  /** Header save indicator, shared by every tab. */
  saving: string | null;
  setSaving: React.Dispatch<React.SetStateAction<string | null>>;
  saveMsg: SaveMsg;
  setSaveMsg: React.Dispatch<React.SetStateAction<SaveMsg>>;
}

const SettingsContext = React.createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = React.useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}

/** POST /api/settings {key, value} and report the result in the header. */
export function useSaveSetting() {
  const { setSaveMsg } = useSettings();
  return React.useCallback((key: string, value: any, opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setSaveMsg(null);
    return fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    }).then(r => {
      if (!opts.quiet) setSaveMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: "Failed to save" });
      return r.ok;
    }).catch(() => {
      if (!opts.quiet) setSaveMsg({ ok: false, text: "Network error" });
      return false;
    });
  }, [setSaveMsg]);
}

export function SettingsProvider({ config, setConfig, settingsRows, children }: {
  config: any;
  setConfig: React.Dispatch<React.SetStateAction<any>>;
  settingsRows: { key: string; value: string }[];
  children: React.ReactNode;
}) {
  const [saving, setSaving] = React.useState<string | null>(null);
  const [saveMsg, setSaveMsg] = React.useState<SaveMsg>(null);

  const saveConfig = React.useCallback((updates: Record<string, any>) => {
    setSaving("config");
    setSaveMsg(null);
    fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then(r => {
      if (r.ok) {
        setSaveMsg({ ok: true, text: "Saved" });
        setConfig((prev: any) => ({ ...prev, ...updates }));
      } else {
        setSaveMsg({ ok: false, text: "Failed to save" });
      }
    }).catch(() => setSaveMsg({ ok: false, text: "Network error" }))
      .finally(() => setSaving(null));
  }, [setConfig]);

  const updateApiKey = React.useCallback((provider: string, value: string) => {
    const newKeys = { ...(config.apiKeys || {}), [provider]: value || undefined };
    const clean = Object.fromEntries(Object.entries(newKeys).filter(([_, v]) => v));
    saveConfig({ apiKeys: clean });
  }, [config.apiKeys, saveConfig]);

  const getSetting = React.useCallback((key: string) => {
    const raw = settingsRows.find(s => s.key === key);
    if (!raw) return undefined;
    try { return JSON.parse(raw.value); } catch { return undefined; }
  }, [settingsRows]);

  const value = React.useMemo(
    () => ({ config, saveConfig, updateApiKey, getSetting, saving, setSaving, saveMsg, setSaveMsg }),
    [config, saveConfig, updateApiKey, getSetting, saving, saveMsg],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
