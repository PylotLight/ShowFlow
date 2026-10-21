import { SearchIcon, XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../SettingsShared";
import { searchSettings, type SettingMeta } from "./registry";
import { findTab } from "./SettingsNav";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Search box for every setting across all Settings tabs (settings/registry.ts).
 * Combobox: ↑/↓ move, Enter opens, Esc clears then blurs. "/" focuses it from
 * anywhere on the page; ⌘F / Ctrl+F focuses it too, and a second press while
 * it's focused falls through to the browser's find.
 */
export function SettingsSearch({ onPick, className, dropdownClassName }: {
  onPick: (entry: SettingMeta) => void;
  className?: string;
  dropdownClassName?: string;
}) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();

  const results = React.useMemo(() => searchSettings(q, { limit: 12 }), [q]);
  const showList = open && q.trim().length > 0;

  React.useEffect(() => { setActive(0); }, [q]);

  // Page-level shortcuts.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const input = inputRef.current;
      if (!input) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        input.focus();
        input.select();
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close on outside pointer.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  React.useEffect(() => {
    if (!showList) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, showList]);

  const pick = (entry: SettingMeta) => {
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
    onPick(entry);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      setOpen(true);
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive(a => (a + d + results.length) % results.length);
    } else if (e.key === "Home" && showList && results.length) {
      e.preventDefault(); setActive(0);
    } else if (e.key === "End" && showList && results.length) {
      e.preventDefault(); setActive(results.length - 1);
    } else if (e.key === "Enter") {
      const r = results[active];
      if (r) { e.preventDefault(); pick(r.entry); }
    } else if (e.key === "Escape") {
      // Don't let the mobile sheet / page Esc handlers close things too.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      if (q) setQ("");
      else inputRef.current?.blur();
    }
  };

  const activeId = showList && results[active] ? `${listId}-${active}` : undefined;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search settings"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="Search settings…"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={cn(
          "h-8 w-full rounded-lg border border-white/10 bg-white/[0.04] pr-8 pl-8 text-sub text-foreground placeholder:text-muted-foreground",
          "outline-none transition-colors hover:bg-white/[0.06] focus:border-signal/50 focus:ring-1 focus:ring-signal/30",
          "[&::-webkit-search-cancel-button]:appearance-none",
        )}
      />
      {q ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => { setQ(""); inputRef.current?.focus(); }}
          className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-signal/70"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-white/10 px-1.5 font-mono text-[11px] leading-4 text-muted-foreground sm:block" title={`/ or ${isMac ? "⌘F" : "Ctrl+F"}`}>/</kbd>
      )}

      {showList && (
        <div
          className={cn(
            "absolute top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-white/10 bg-popover/95 shadow-2xl shadow-black/50 backdrop-blur-md",
            "left-0 w-full",
            dropdownClassName,
          )}
        >
          {results.length === 0 ? (
            <p className="px-3 py-4 text-center text-caption text-muted-foreground">No settings match “{q.trim()}”.</p>
          ) : (
            <ul ref={listRef} id={listId} role="listbox" aria-label="Settings results" className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-1">
              {results.map((r, i) => {
                const tab = findTab(r.entry.tab);
                const Icon = tab?.icon;
                const isTab = r.entry.id.startsWith("tab:");
                return (
                  <li
                    key={r.entry.id}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onPointerDown={e => e.preventDefault()}
                    onPointerMove={() => setActive(i)}
                    onClick={() => pick(r.entry)}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2",
                      i === active ? "bg-signal/15" : "hover:bg-white/[0.04]",
                    )}
                  >
                    {Icon && <Icon className={cn("mt-0.5 size-3.5 shrink-0", i === active ? "text-signal" : "text-muted-foreground")} />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className={cn("truncate text-sub font-medium", i === active ? "text-white" : "text-foreground")}>{r.entry.label}</span>
                        <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">{isTab ? "Tab" : r.path}</span>
                      </div>
                      {!isTab && <p className="truncate text-caption text-muted-foreground">{r.entry.description}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
