import { BugIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, CheckIcon, Loader2Icon, PauseIcon, PlayIcon, Trash2Icon, XIcon, FilterIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import { cn } from "@frontend/lib/utils";

interface DebugLogEntry {
  id: string;
  timestamp: string;
  type: string;
  level: string;
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
  message?: string;
  source?: string;
  url?: string;
  headers?: Record<string, string>;
}

function buildCurlCommand(entry: DebugLogEntry): string {
  const method = entry.method || 'GET';
  let url = entry.url || (entry.path?.startsWith('/') ? `http://localhost:3000${entry.path}` : entry.path || '/');

  const hasBody = entry.requestBody != null;
  const isJsonBody = hasBody && typeof entry.requestBody === 'object';

  const parts: string[] = ['curl', '-s'];

  if (method !== 'GET') {
    parts.push('-X', method);
  }

  parts.push(`'${url}'`);

  if (isJsonBody) {
    parts.push('-H', "'Content-Type: application/json'");
    const body = JSON.stringify(entry.requestBody);
    parts.push('-d', `'${body}'`);
  }

  return parts.join(' ');
}

const TYPE_COLORS: Record<string, string> = {
  api: "text-sky-400",
  system: "text-violet-400",
  provider: "text-amber-400",
  scheduler: "text-emerald-400",
  grabber: "text-orange-400",
  database: "text-blue-400",
  sync: "text-cyan-400",
  websocket: "text-pink-400",
  config: "text-slate-400",
  user: "text-white",
};

const LEVEL_COLORS: Record<string, string> = {
  error: "bg-red-500/15 text-red-400 border-red-500/20",
  warn: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  info: "bg-signal/10 text-signal border-signal/10",
  debug: "bg-white/5 text-muted-foreground border-white/5",
};

const LEVEL_DOT: Record<string, string> = {
  error: "bg-red-400",
  warn: "bg-amber-400",
  info: "bg-signal",
  debug: "bg-muted-foreground/40",
};

export function DebugPage({ onDone }: { onDone: () => void }) {
  const [logs, setLogs] = React.useState<DebugLogEntry[]>([]);
  const [paused, setPaused] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = React.useState(true);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const wsRef = React.useRef<WebSocket | null>(null);

  const [filterType, setFilterType] = React.useState("");
  const [filterLevel, setFilterLevel] = React.useState("");
  const [filterMethod, setFilterMethod] = React.useState("");
  const [filterPath, setFilterPath] = React.useState("");
  const [filterSearch, setFilterSearch] = React.useState("");
  const [showFilters, setShowFilters] = React.useState(false);

  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/debug/logs?limit=500")
      .then(r => r.json())
      .then((data: DebugLogEntry[]) => {
        setLogs(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/api/debug/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data) as DebugLogEntry;
        setLogs(prev => {
          const next = [entry, ...prev];
          if (next.length > 2000) next.length = 2000;
          return next;
        });
      } catch {}
    };

    return () => {
      ws.close();
    };
  }, []);

  React.useEffect(() => {
    if (autoScroll && containerRef.current && !paused) {
      containerRef.current.scrollTop = 0;
    }
  }, [logs, autoScroll, paused]);

  const handleScroll = React.useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop } = containerRef.current;
    setAutoScroll(scrollTop < 50);
  }, []);

  const filteredLogs = React.useMemo(() => {
    if (!filterType && !filterLevel && !filterMethod && !filterPath && !filterSearch) return logs;
    return logs.filter(e => {
      if (filterType && e.type !== filterType) return false;
      if (filterLevel && e.level !== filterLevel) return false;
      if (filterMethod && e.method?.toUpperCase() !== filterMethod.toUpperCase()) return false;
      if (filterPath && !e.path?.toLowerCase().includes(filterPath.toLowerCase())) return false;
      if (filterSearch) {
        const q = filterSearch.toLowerCase();
        return (
          e.message?.toLowerCase().includes(q) ||
          e.path?.toLowerCase().includes(q) ||
          e.source?.toLowerCase().includes(q) ||
          e.error?.toLowerCase().includes(q) ||
          e.method?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [logs, filterType, filterLevel, filterMethod, filterPath, filterSearch]);

  const clearLogs = () => {
    fetch("/api/debug/clear", { method: "POST" }).catch(() => {});
    setLogs([]);
  };

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const types = React.useMemo(() => {
    const s = new Set(logs.map(l => l.type));
    return [...s].sort();
  }, [logs]);

  const methods = React.useMemo(() => {
    const s = new Set(logs.map(l => l.method).filter(Boolean) as string[]);
    return [...s].sort();
  }, [logs]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-3">
          <BugIcon className={cn("size-4", connected ? "text-signal" : "text-muted-foreground")} />
          <h2 className="font-display text-xl font-bold text-white">Debug Console</h2>
          <span className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest",
            connected ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400",
          )}>
            <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-red-400")} />
            {connected ? "Live" : "Disconnected"}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {logs.length} entries
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShowFilters(!showFilters)}
            title="Toggle filters"
          >
            <FilterIcon className={cn("size-3.5", showFilters && "text-signal")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPaused(!paused)}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={clearLogs} title="Clear">
            <Trash2Icon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDone} title="Close">
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 px-6 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 font-mono text-[11px] text-muted-foreground outline-none focus:border-signal/50"
          >
            <option value="">All Types</option>
            {types.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select
            value={filterLevel}
            onChange={e => setFilterLevel(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 font-mono text-[11px] text-muted-foreground outline-none focus:border-signal/50"
          >
            <option value="">All Levels</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
          <select
            value={filterMethod}
            onChange={e => setFilterMethod(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 font-mono text-[11px] text-muted-foreground outline-none focus:border-signal/50"
          >
            <option value="">All Methods</option>
            {methods.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <Input
            value={filterPath}
            onChange={e => setFilterPath(e.target.value)}
            placeholder="Filter path..."
            className="h-7 w-40 font-mono text-[11px]"
          />
          <Input
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            placeholder="Search..."
            className="h-7 w-40 font-mono text-[11px]"
          />
          {(filterType || filterLevel || filterMethod || filterPath || filterSearch) && (
            <button
              onClick={() => { setFilterType(""); setFilterLevel(""); setFilterMethod(""); setFilterPath(""); setFilterSearch(""); }}
              className="text-[11px] font-mono text-muted-foreground hover:text-foreground px-2"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Log entries */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed"
      >
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <BugIcon className="size-8 mb-3 opacity-30" />
            <p className="font-mono text-xs">No debug entries</p>
          </div>
        ) : (
          filteredLogs.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                "border-b border-white/[0.02] transition-colors hover:bg-white/[0.02]",
                entry.level === "error" && "bg-red-500/[0.03]",
                entry.level === "warn" && "bg-amber-500/[0.02]",
              )}
            >
              <button
                onClick={() => toggleExpanded(entry.id)}
                className="flex items-start gap-2 w-full text-left px-4 py-1.5"
              >
                {/* Level dot */}
                <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", LEVEL_DOT[entry.level] || "bg-muted-foreground/40")} />

                {/* Timestamp */}
                <span className="shrink-0 text-muted-foreground/60 w-20 tabular-nums">
                  {formatTime(entry.timestamp)}
                </span>

                {/* Type badge */}
                <span className={cn("shrink-0 font-bold tracking-wide w-16 uppercase", TYPE_COLORS[entry.type] || "text-muted-foreground")}>
                  {entry.type}
                </span>

                {/* Level */}
                <span className={cn(
                  "shrink-0 rounded px-1 py-0.5 font-bold uppercase tracking-wider text-[9px] leading-none border",
                  LEVEL_COLORS[entry.level] || "text-muted-foreground border-white/5",
                )}>
                  {entry.level}
                </span>

                {/* Method + Path */}
                {entry.method && (
                  <span className="shrink-0 font-bold text-muted-foreground/80 w-10">
                    {entry.method}
                  </span>
                )}
                {entry.path && (
                  <span className="flex-1 truncate text-foreground/70 min-w-0">
                    {entry.path}
                  </span>
                )}

                {/* Status */}
                {entry.status && (
                  <span className={cn(
                    "shrink-0 font-bold tabular-nums w-10 text-right",
                    entry.status >= 500 ? "text-red-400" :
                    entry.status >= 400 ? "text-amber-400" :
                    entry.status >= 300 ? "text-blue-400" :
                    "text-emerald-400",
                  )}>
                    {entry.status}
                  </span>
                )}

                {/* Duration */}
                {entry.duration !== undefined && (
                  <span className="shrink-0 text-muted-foreground/60 w-16 text-right tabular-nums">
                    {entry.duration}ms
                  </span>
                )}

                {/* Expand indicator */}
                {(entry.requestBody || entry.responseBody || entry.error) && (
                  expanded.has(entry.id) ? <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40" /> : <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
                )}
              </button>

              {/* Expanded details */}
              {expanded.has(entry.id) && (
                <div className="px-4 pb-2 space-y-1.5 pl-[92px]">
                  {/* URL bar + cURL copy */}
                  {(entry.url || (entry.method && entry.path)) && (
                    <div className="flex items-start gap-2 rounded bg-white/[0.03] px-3 py-2">
                      <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted-foreground shrink-0 mt-0.5">URL</span>
                      <span className="font-mono text-[11px] text-foreground/60 break-all min-w-0 flex-1">
                        {entry.url || `http://localhost:3000${entry.path}`}
                      </span>
                      <CopyCurlButton entry={entry} />
                    </div>
                  )}

                  {entry.error && (
                    <div className="rounded bg-red-500/5 border border-red-500/10 px-3 py-2 text-red-400 text-[11px] font-mono whitespace-pre-wrap break-all">
                      {entry.error}
                    </div>
                  )}
                  {!!entry.message && entry.message !== `${entry.method} ${entry.path} \u2192 ${entry.status} (${entry.duration}ms)` ? (
                    <div className="rounded bg-white/[0.03] px-3 py-2 text-foreground/60 text-[11px] font-mono whitespace-pre-wrap break-all">
                      {entry.message}
                    </div>
                  ) : null}
                  {renderBodyBlock("Request Body", entry.requestBody)}
                  {renderBodyBlock("Response", entry.responseBody)}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center gap-3 px-6 py-2 border-t border-white/5 shrink-0 bg-white/[0.02]">
        <span className={cn(
          "font-mono text-[10px]",
          paused ? "text-accent-amber" : "text-muted-foreground",
        )}>
          {paused ? "PAUSED" : "STREAMING"}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {filteredLogs.length} / {logs.length} shown
        </span>
        {!autoScroll && !paused && (
          <button
            onClick={() => { containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); setAutoScroll(true); }}
            className="font-mono text-[10px] text-signal hover:underline"
          >
            Scroll to latest
          </button>
        )}
      </div>
    </div>
  );
}

function CopyCurlButton({ entry }: { entry: DebugLogEntry }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(async () => {
    const cmd = buildCurlCommand(entry);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [entry]);

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-signal hover:bg-signal/10 transition-colors flex items-center gap-1"
      title="Copy as cURL command"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {copied ? 'Copied' : 'cURL'}
    </button>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
      "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch {
    return ts;
  }
}

function renderBodyBlock(label: string, data: unknown): React.ReactElement | null {
  if (data === undefined || data === null) return null;
  return (
    <div className="space-y-1">
      <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      <pre className="rounded bg-white/[0.03] px-3 py-2 text-[11px] text-foreground/60 overflow-x-auto">{formatJSON(data)}</pre>
    </div>
  );
}

function formatJSON(data: unknown): string {
  try {
    if (typeof data === "string") {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    }
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
