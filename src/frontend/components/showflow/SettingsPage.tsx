import { ArrowLeft, Loader2Icon, XIcon } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { HeaderActions } from "@frontend/lib/header-actions";

import { ErrorNotice } from "./settings/errors";
import { SettingsProvider, useSettings } from "./settings/SettingsContext";
import { SettingsCompactNav, SettingsMobileList, SettingsSideNav, findTab } from "./settings/SettingsNav";
import { SettingsTabContent } from "./settings/SettingsTabContent";
import { cn } from "./SettingsShared";

const SM_QUERY = "(min-width: 640px)";

/**
 * One compact type scale for every settings tab: controls (selects, inputs,
 * buttons) read at text-sub instead of each component's own text-sm, so
 * values don't outgrow their boxes ("Preferred (+50" clipping) or dwarf the
 * labels next to them. Scoped here so the rest of the app is untouched.
 */
const SETTINGS_SCALE =
  "[&_[data-slot=select-trigger]]:text-sub [&_[data-slot=input]]:text-sub [&_[data-slot=button]]:text-sub";

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

/** Save spinner in the global header; the result itself is a toast. */
function SaveStatus() {
  const { saving } = useSettings();
  if (!saving) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 pl-2" role="status" aria-label="Saving">
      <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Mobile overlay for one section: bottom sheet or full-screen drill-down.
 * Portaled to <body>: the page container keeps a transform from its
 * enter animation, which turns `position: fixed` into "fixed to the
 * scrolling page" — the sheet then sat inside the z-10 content layer,
 * scrolled with the list, and the list + bottom nav showed through.
 */
function MobileSection(props: { id: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(<MobileSectionInner {...props} />, document.body);
}

function MobileSectionInner({ id, onClose, children }: { id: string; onClose: () => void; children: React.ReactNode }) {
  const def = findTab(id);
  const Icon = def?.icon;
  const iconBtn = "flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.05] hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-signal/70";

  if (def?.mobileStyle === "sheet") {
    return (
      <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={def.label}>
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.15s_ease-out]" onClick={onClose} />
        <div
          className="safe-x absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-2xl border-t border-white/10 bg-[#1c2028] pb-[env(safe-area-inset-bottom)] shadow-2xl"
          style={{ animation: "slideUp 0.25s ease-out" }}
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
      className="safe-x fixed inset-0 z-[60] flex flex-col bg-[#1c2028]"
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
      <div className="flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><div className="space-y-6">{children}</div></div>
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

  const [mobileSection, setMobileSection] = React.useState<string | null>(initialTab || null);
  const isDesktop = useIsDesktop();

  // An in-app link to another tab (e.g. Source Status -> Configure) while a
  // mobile section is open should follow the URL, not stay on the old one.
  React.useEffect(() => {
    setMobileSection((cur) => (cur && tabProp && cur !== tabProp ? tabProp : cur));
  }, [tabProp]);

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
    <div className={cn("space-y-6", SETTINGS_SCALE)}>
      <SettingsTabContent id={id} scrollToSection={scrollToSection} onReRunWizard={onReRunWizard} />
    </div>
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
        // Side nav only once there's room for it next to the app sidebar;
        // in between it collapses to a dropdown above the content.
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:gap-6">
          <SettingsSideNav tab={tab} onSelect={setTab} />
          <SettingsCompactNav tab={tab} onSelect={setTab} />
          <div className="min-w-0 flex-1">{body(tab)}</div>
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
