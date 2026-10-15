import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";

import { cn } from "../SettingsShared";
import { SETTINGS_GROUPS, SETTINGS_TABS } from "./tabs";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-signal/70";

/**
 * Desktop: grouped vertical nav. Twelve tabs never fit a 1440px header strip
 * (they clipped at "Analyt…"), so they live in a sticky left column instead.
 */
export function SettingsSideNav({ tab, onSelect }: { tab: string; onSelect: (id: string) => void }) {
  return (
    <nav aria-label="Settings sections" className="sticky top-4 hidden w-[200px] shrink-0 flex-col gap-3 self-start xl:flex">
      {SETTINGS_GROUPS.map(group => (
        <div key={group.label}>
          <div className="px-2.5 pb-1 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{group.label}</div>
          <ul className="space-y-0.5">
            {group.tabs.map(t => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sub transition-colors",
                      ring,
                      active
                        ? "bg-signal/15 text-signal font-semibold shadow-[inset_0_0_0_0.5px_var(--signal)]"
                        : "text-foreground/80 hover:bg-white/[0.05] hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("size-3.5 shrink-0", active ? "text-signal" : "text-muted-foreground")} />
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Mid widths (sm..xl): the side nav would squeeze content between it and the
 * app sidebar, so it collapses to a native grouped select above the content.
 */
export function SettingsCompactNav({ tab, onSelect }: { tab: string; onSelect: (id: string) => void }) {
  const Icon = findTab(tab)?.icon;
  return (
    <div className="relative w-full max-w-xs xl:hidden">
      {Icon && <Icon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-signal" />}
      <select
        aria-label="Settings section"
        value={tab}
        onChange={e => onSelect(e.target.value)}
        className={cn("h-9 w-full appearance-none rounded-md border border-white/10 bg-white/[0.04] [color-scheme:dark] [&_option]:bg-[#1c2028] pr-8 pl-9 text-sub font-medium text-foreground hover:bg-white/[0.06]", ring)}
      >
        {SETTINGS_GROUPS.map(group => (
          <optgroup key={group.label} label={group.label}>
            {group.tabs.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </optgroup>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/** Mobile: tappable section list, grouped the same way. */
export function SettingsMobileList({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <div className="space-y-5">
      {SETTINGS_GROUPS.map(group => (
        <div key={group.label} className="space-y-1">
          <div className="px-1 pb-1 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{group.label}</div>
          {group.tabs.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                className={cn("flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3.5 text-left transition-colors hover:bg-white/[0.05] active:bg-white/[0.08]", ring)}
              >
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <span className="flex-1 font-sans text-sm font-medium text-white">{t.label}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function findTab(id: string | null | undefined) {
  return SETTINGS_TABS.find(t => t.id === id);
}
