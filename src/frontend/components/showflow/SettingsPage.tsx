import { ArrowLeft, CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import * as React from "react";

import { HeaderActions } from "@frontend/lib/header-actions";

import { ErrorNotice } from "./settings/errors";
import { SettingsProvider, useSettings } from "./settings/SettingsContext";
import { SettingsMobileList, SettingsSideNav, findTab } from "./settings/SettingsNav";
import { SettingsTabContent } from "./settings/SettingsTabContent";
import { cn } from "./SettingsShared";

const SM_QUERY = "(min-width: 640px)";

function useIsDesktop() {
  const [desktop, setDesktop] = React.useState(() => typeof window === "undefined" || window.matchMedia(SM_QUERY).matches);
  React.useEffect(() => {
    const mq = window.matchMedia(SM_QUERY);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

/** Save indicator in the global header, shared by every tab. */
function SaveStatus() {
  const { saveMsg, saving } = useSettings();
  if (!saveMsg && !saving) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 pl-2" role="status" aria-live="polite">
      {saveMsg && (
        <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", saveMsg.ok ? "text-emerald-400" : "text-red-400")}>
          {saveMsg.ok ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
          {saveMsg.text}
        </span>
      )}
      {saving && <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />}
    </div>
  );
}

/** Mobile overlay for one section: bottom sheet or full-screen drill-down. */
function MobileSection({ id, onClose, children }: { id: string; onClose: () => void; children: React.ReactNode }) {
  const def = findTab(id);
  const Icon = def?.icon;
  const iconBtn = "flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.05] hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-signal/70";

  if (def?.mobileStyle === "sheet") {
    return (
      <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={def.label}>
        <div className="absolute inset-0 bg-black/60 animate-[fadeIn_0.15s_ease-out]" onClick={onClose} />
        <div
          className="mobile-nav-safe absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t border-white/10 bg-[#1c2028] shadow-2xl"
          style={{ maxHeight: "92vh", animation: "slideUp 0.25s ease-out" }}
        >
          <div className="flex justify-center pt-2 pb-1"><div className="h-1 w-8 rounded-full bg-white/20" /></div>
          <div className="flex items-center justify-between px-4 pb-3">
            <div className="flex items-center gap-2">
              {Icon && <Icon className="size-4 text-signal" />}
              <span className="font-mono text-sm font-bold text-white">{def.label}</span>
            </div>
            <button onClick={onClose} aria-label="Close" className={iconBtn}><XIcon className="size-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-6"><div className="space-y-6">{children}</div></div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#1c2028]"
      role="dialog"
      aria-modal="true"
      aria-label={def?.label}
      style={{ animation: "slideInRight 0.25s ease-out", paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="flex h-14 items-center gap-3 border-b border-white/10 px-4">
        <button onClick={onClose} aria-label="Back" className={iconBtn}><ArrowLeft className="size-5" /></button>
        {Icon && <Icon className="size-4 text-signal" />}
        <span className="font-mono text-sm font-bold text-white">{def?.label}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4"><div className="space-y-6">{children}</div></div>
    </div>
  );
}

/**
 * Settings shell: loads the shared config + settings rows once, then each
 * tab component owns its own state. `tab`/`onTabChange` make it controllable
 * (URL routing); without them it falls back to `initialTab` + local state.
 */
export function SettingsPage({ onDone: _onDone, initialTab, scrollToSection, onReRunWizard, tab: tabProp, onTabChange }: {
  onDone: () => void;
  initialTab?: string;
  scrollToSection?: string;
  onReRunWizard?: () => void;
  tab?: string;
  onTabChange?: (tab: string) => void;
}) {
  const [localTab, setLocalTab] = React.useState(initialTab || "general");
  const tab = tabProp ?? localTab;
  const setTab = React.useCallback((id: string) => {
    if (tabProp === undefined) setLocalTab(id);
    onTabChange?.(id);
  }, [tabProp, onTabChange]);

  const [mobileSection, setMobileSection] = React.useState<string | null>(initialTab || tabProp || null);
  const isDesktop = useIsDesktop();

  const [config, setConfig] = React.useState<any>({});
  const [settingsRows, setSettingsRows] = React.useState<{ key: string; value: string }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<unknown>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadError(null);
    const json = (url: string) => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    Promise.all([json("/api/config"), json("/api/settings")])
      .then(([cfg, rows]) => {
        setConfig(cfg ?? {});
        setSettingsRows(Array.isArray(rows) ? rows : []);
      })
      .catch(setLoadError)
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);

  React.useEffect(() => {
    if (!mobileSection) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileSection(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileSection]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return <div className="py-8"><ErrorNotice error={loadError} what="settings" onRetry={load} /></div>;
  }

  const body = (id: string) => (
    <SettingsTabContent id={id} scrollToSection={scrollToSection} onReRunWizard={onReRunWizard} />
  );

  return (
    <SettingsProvider config={config} setConfig={setConfig} settingsRows={settingsRows}>
      <HeaderActions>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {!isDesktop && mobileSection && (
            <span className="mr-auto truncate font-mono text-xs font-semibold text-white">{findTab(mobileSection)?.label ?? "Settings"}</span>
          )}
          <SaveStatus />
        </div>
      </HeaderActions>

      {isDesktop ? (
        <div className="flex items-start gap-6 lg:gap-8">
          <SettingsSideNav tab={tab} onSelect={setTab} />
          <div className="min-w-0 flex-1 space-y-6">{body(tab)}</div>
        </div>
      ) : (
        <>
          <SettingsMobileList onSelect={(id) => { setTab(id); setMobileSection(id); }} />
          {mobileSection && (
            <MobileSection id={mobileSection} onClose={() => setMobileSection(null)}>{body(mobileSection)}</MobileSection>
          )}
        </>
      )}
    </SettingsProvider>
  );
}
