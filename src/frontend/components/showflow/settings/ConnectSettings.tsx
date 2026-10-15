import { BellIcon, CheckIcon, Loader2Icon, PencilIcon, PlusIcon, SendIcon, Trash2Icon, XIcon } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { readJsonResponse } from "@frontend/lib/api";
import { FieldRow, cn } from "../SettingsShared";
import { ErrorNotice } from "./errors";

type EventId = "grabbed" | "imported" | "failed" | "health" | "update";
type TargetType = "ntfy" | "discord" | "apprise" | "webhook";

interface Target {
  id?: string;
  name: string;
  type: TargetType;
  enabled: boolean;
  events: Record<EventId, boolean>;
  url?: string;
  topic?: string;
  token?: string;
  webhookUrl?: string;
  tags?: string;
  authHeader?: string;
}

interface PathMap { from: string; to: string }
interface MediaRefresh {
  jellyfin: { enabled: boolean; pathMap: PathMap };
  plex: { enabled: boolean; baseUrl: string; token: string; pathMap: PathMap };
  debounceSeconds: number;
}
interface RefreshRun {
  at: string;
  dirs: string[];
  jellyfin?: { mode: string; ok: boolean; error?: string };
  plex?: { ok: boolean; refreshed: { section: string; path: string }[]; unmatched: string[]; error?: string };
}
interface ConnectView {
  targets: Target[];
  mediaRefresh: MediaRefresh;
  events: { id: EventId; label: string }[];
  lastRefresh: RefreshRun | null;
}
type Status = { ok: boolean; message?: string } | null;

const TYPE_LABELS: Record<TargetType, string> = {
  ntfy: "ntfy",
  discord: "Discord webhook",
  apprise: "Apprise API",
  webhook: "Generic webhook",
};
const ALL_ON: Record<EventId, boolean> = { grabbed: true, imported: true, failed: true, health: true, update: true };
const ring = "outline-none focus-visible:ring-2 focus-visible:ring-signal/70";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await readJsonResponse<any>(res);
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}
const post = <T,>(url: string, body: unknown) =>
  api<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <p role="status" className={cn("flex items-start gap-1.5 text-sm", status.ok ? "text-emerald-300" : "text-red-300")}>
      {status.ok ? <CheckIcon className="mt-0.5 size-4 shrink-0" /> : <XIcon className="mt-0.5 size-4 shrink-0" />}
      <span className="min-w-0 break-words">{status.message || (status.ok ? "OK" : "Failed")}</span>
    </p>
  );
}

function blankTarget(type: TargetType = "ntfy"): Target {
  return { name: "", type, enabled: true, events: { ...ALL_ON }, url: type === "ntfy" ? "https://ntfy.sh" : "", topic: "", token: "", webhookUrl: "", tags: "", authHeader: "" };
}

/** Only send the fields that belong to the chosen type. */
function payloadFor(t: Target) {
  const base = { id: t.id, name: t.name, type: t.type, enabled: t.enabled, events: t.events };
  switch (t.type) {
    case "ntfy": return { ...base, url: t.url, topic: t.topic, token: t.token ?? "" };
    case "discord": return { ...base, webhookUrl: t.webhookUrl };
    case "apprise": return { ...base, url: t.url, tags: t.tags ?? "" };
    case "webhook": return { ...base, url: t.url, authHeader: t.authHeader ?? "" };
  }
}

function TargetEditor({ initial, events, onSaved, onCancel }: {
  initial: Target;
  events: ConnectView["events"];
  onSaved: (v: ConnectView) => void;
  onCancel: () => void;
}) {
  const [t, setT] = React.useState<Target>(initial);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [status, setStatus] = React.useState<Status>(null);
  const set = (patch: Partial<Target>) => setT(prev => ({ ...prev, ...patch }));
  const isNew = !initial.id;

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      onSaved(await post<ConnectView>("/api/connect/targets", payloadFor(t)));
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setStatus(null);
    try {
      setStatus(await post<Status>("/api/connect/targets/test", payloadFor(t)));
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <h4 className="text-sm font-semibold text-foreground">{isNew ? "Add notification target" : `Edit ${initial.name}`}</h4>
      <FieldRow label="Type" description="Where notifications go">
        <Select value={t.type} onValueChange={v => setT(prev => ({ ...blankTarget(v as TargetType), id: prev.id, name: prev.name, enabled: prev.enabled, events: prev.events }))} disabled={!isNew}>
          <SelectTrigger className="w-56" aria-label="Target type"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(TYPE_LABELS) as TargetType[]).map(k => <SelectItem key={k} value={k}>{TYPE_LABELS[k]}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Name" description="Shown in this list only">
        <Input value={t.name} onChange={e => set({ name: e.target.value })} placeholder="Phone" aria-label="Target name" />
      </FieldRow>

      {t.type === "ntfy" && (
        <>
          <FieldRow label="Server URL" description="ntfy.sh or your own server">
            <Input value={t.url ?? ""} onChange={e => set({ url: e.target.value })} placeholder="https://ntfy.sh" aria-label="ntfy server URL" />
          </FieldRow>
          <FieldRow label="Topic" description="Letters, numbers, - and _">
            <Input value={t.topic ?? ""} onChange={e => set({ topic: e.target.value })} placeholder="showflow" aria-label="ntfy topic" />
          </FieldRow>
          <FieldRow label="Token" description="Optional. Access token (tk_…) or user:password">
            <Input type="password" value={t.token ?? ""} onChange={e => set({ token: e.target.value })} placeholder="optional" aria-label="ntfy token" autoComplete="off" />
          </FieldRow>
        </>
      )}
      {t.type === "discord" && (
        <FieldRow label="Webhook URL" description="Channel settings → Integrations → Webhooks">
          <Input type="password" value={t.webhookUrl ?? ""} onChange={e => set({ webhookUrl: e.target.value })} placeholder="https://discord.com/api/webhooks/…" aria-label="Discord webhook URL" autoComplete="off" />
        </FieldRow>
      )}
      {t.type === "apprise" && (
        <>
          <FieldRow label="Notify URL" description="Apprise API endpoint, incl. config key">
            <Input value={t.url ?? ""} onChange={e => set({ url: e.target.value })} placeholder="http://apprise:8000/notify/showflow" aria-label="Apprise notify URL" />
          </FieldRow>
          <FieldRow label="Tags" description="Optional. Only notify services with these tags">
            <Input value={t.tags ?? ""} onChange={e => set({ tags: e.target.value })} placeholder="optional" aria-label="Apprise tags" />
          </FieldRow>
        </>
      )}
      {t.type === "webhook" && (
        <>
          <FieldRow label="URL" description="Receives a JSON POST per event">
            <Input value={t.url ?? ""} onChange={e => set({ url: e.target.value })} placeholder="https://example.com/hook" aria-label="Webhook URL" />
          </FieldRow>
          <FieldRow label="Authorization" description="Optional header value, e.g. Bearer abc">
            <Input type="password" value={t.authHeader ?? ""} onChange={e => set({ authHeader: e.target.value })} placeholder="optional" aria-label="Webhook authorization header" autoComplete="off" />
          </FieldRow>
        </>
      )}

      <FieldRow label="Events" description="What this target hears about">
        <div className="grid gap-2 sm:grid-cols-2">
          {events.map(ev => (
            <label key={ev.id} className="flex items-center gap-2.5 text-sm text-foreground">
              <Switch
                checked={t.events[ev.id]}
                onCheckedChange={v => set({ events: { ...t.events, [ev.id]: v } })}
                aria-label={`Notify on ${ev.label}`}
              />
              {ev.label}
            </label>
          ))}
        </div>
      </FieldRow>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" onClick={save} disabled={saving || !t.name.trim()}>
          {saving && <Loader2Icon className="size-3.5 animate-spin" />} {isNew ? "Add target" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onClick={test} disabled={testing}>
          {testing ? <Loader2Icon className="size-3.5 animate-spin" /> : <SendIcon className="size-3.5" />} Test
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <StatusLine status={status} />
    </div>
  );
}

function TargetRow({ target, events, onEdit, onChanged }: {
  target: Target;
  events: ConnectView["events"];
  onEdit: () => void;
  onChanged: (v: ConnectView) => void;
}) {
  const [status, setStatus] = React.useState<Status>(null);
  const [busy, setBusy] = React.useState<"test" | "delete" | "toggle" | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  async function run(kind: "test" | "delete" | "toggle", fn: () => Promise<void>) {
    setBusy(kind);
    setStatus(null);
    try { await fn(); } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally { setBusy(null); }
  }

  const on = events.filter(e => target.events[e.id]);
  return (
    <li className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Switch
          checked={target.enabled}
          disabled={busy === "toggle"}
          onCheckedChange={v => run("toggle", async () => onChanged(await post<ConnectView>("/api/connect/targets", payloadFor({ ...target, enabled: v }))))}
          aria-label={`${target.enabled ? "Disable" : "Enable"} ${target.name}`}
        />
        <div className="min-w-0 flex-1 basis-[calc(100%-4rem)] sm:basis-auto">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{target.name}</span>
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{TYPE_LABELS[target.type]}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {on.length === events.length ? "All events" : on.length === 0 ? "No events selected" : on.map(e => e.label).join(" · ")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" disabled={busy === "test"} onClick={() => run("test", async () => setStatus(await post<Status>("/api/connect/targets/test", payloadFor(target))))}>
            {busy === "test" ? <Loader2Icon className="size-3.5 animate-spin" /> : <SendIcon className="size-3.5" />} Test
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${target.name}`} className={ring}>
            <PencilIcon className="size-4" />
          </Button>
          {confirmDelete ? (
            <>
              <Button size="sm" variant="destructive" disabled={busy === "delete"}
                onClick={() => run("delete", async () => onChanged(await api<ConnectView>(`/api/connect/targets/${encodeURIComponent(target.id!)}`, { method: "DELETE" })))}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          ) : (
            <Button size="icon-sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${target.name}`} className={ring}>
              <Trash2Icon className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {status && <div className="mt-2"><StatusLine status={status} /></div>}
    </li>
  );
}

function PathMapFields({ value, onChange, server }: { value: PathMap; onChange: (v: PathMap) => void; server: string }) {
  return (
    <FieldRow label="Path mapping" description={`Only if ${server} sees your library at a different path`}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={value.from} onChange={e => onChange({ ...value, from: e.target.value })} placeholder="ShowFlow path, e.g. /data/tv" aria-label={`${server} path mapping: ShowFlow path`} />
        <Input value={value.to} onChange={e => onChange({ ...value, to: e.target.value })} placeholder={`${server} path, e.g. /media/tv`} aria-label={`${server} path mapping: ${server} path`} />
      </div>
    </FieldRow>
  );
}

function MediaRefreshPanel({ initial, lastRefresh, onSaved }: { initial: MediaRefresh; lastRefresh: RefreshRun | null; onSaved: (v: ConnectView) => void }) {
  const [m, setM] = React.useState<MediaRefresh>(initial);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<Status>(null);
  const [testing, setTesting] = React.useState<"jellyfin" | "plex" | null>(null);
  const [testStatus, setTestStatus] = React.useState<{ server: string; status: Status } | null>(null);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      onSaved(await post<ConnectView>("/api/connect/media", m));
      setStatus({ ok: true, message: "Saved" });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally { setSaving(false); }
  }

  async function test(server: "jellyfin" | "plex") {
    setTesting(server);
    setTestStatus(null);
    try {
      setTestStatus({ server, status: await post<Status>("/api/connect/media/test", { server, plex: m.plex }) });
    } catch (err) {
      setTestStatus({ server, status: { ok: false, message: err instanceof Error ? err.message : String(err) } });
    } finally { setTesting(null); }
  }

  return (
    <GlassPanel className="space-y-5 p-6">
      <div>
        <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Media server refresh</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          After an import, ask Jellyfin and Plex to rescan just that folder. Imports landing close together share one refresh.
        </p>
      </div>

      <div className="space-y-4 border-t border-white/10 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">Jellyfin</h4>
            <p className="text-xs text-muted-foreground">Uses the URL and API key from Integrations → Jellyfin.</p>
          </div>
          <Switch checked={m.jellyfin.enabled} onCheckedChange={v => setM({ ...m, jellyfin: { ...m.jellyfin, enabled: v } })} aria-label="Refresh Jellyfin after import" />
        </div>
        {m.jellyfin.enabled && (
          <>
            <PathMapFields server="Jellyfin" value={m.jellyfin.pathMap} onChange={pathMap => setM({ ...m, jellyfin: { ...m.jellyfin, pathMap } })} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => test("jellyfin")} disabled={testing === "jellyfin"}>
                {testing === "jellyfin" && <Loader2Icon className="size-3.5 animate-spin" />} Test Jellyfin
              </Button>
              {testStatus?.server === "jellyfin" && <StatusLine status={testStatus.status} />}
            </div>
          </>
        )}
      </div>

      <div className="space-y-4 border-t border-white/10 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">Plex</h4>
            <p className="text-xs text-muted-foreground">Refreshes the library section that contains the imported folder.</p>
          </div>
          <Switch checked={m.plex.enabled} onCheckedChange={v => setM({ ...m, plex: { ...m.plex, enabled: v } })} aria-label="Refresh Plex after import" />
        </div>
        {m.plex.enabled && (
          <>
            <FieldRow label="Plex URL" description="e.g. http://plex:32400">
              <Input value={m.plex.baseUrl} onChange={e => setM({ ...m, plex: { ...m.plex, baseUrl: e.target.value } })} placeholder="http://plex:32400" aria-label="Plex URL" />
            </FieldRow>
            <FieldRow label="Plex token" description="Your X-Plex-Token">
              <Input type="password" value={m.plex.token} onChange={e => setM({ ...m, plex: { ...m.plex, token: e.target.value } })} placeholder="X-Plex-Token" aria-label="Plex token" autoComplete="off" />
            </FieldRow>
            <PathMapFields server="Plex" value={m.plex.pathMap} onChange={pathMap => setM({ ...m, plex: { ...m.plex, pathMap } })} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => test("plex")} disabled={testing === "plex" || !m.plex.baseUrl}>
                {testing === "plex" && <Loader2Icon className="size-3.5 animate-spin" />} Test Plex
              </Button>
              {testStatus?.server === "plex" && <StatusLine status={testStatus.status} />}
            </div>
          </>
        )}
      </div>

      <div className="border-t border-white/10 pt-4">
        <FieldRow label="Batch window" description="Seconds to wait for more imports before refreshing">
          <Input type="number" min={1} max={600} className="w-28" value={m.debounceSeconds}
            onChange={e => setM({ ...m, debounceSeconds: Math.max(1, Math.min(600, Number(e.target.value) || 30)) })} aria-label="Batch window in seconds" />
        </FieldRow>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving}>{saving && <Loader2Icon className="size-3.5 animate-spin" />} Save</Button>
        <StatusLine status={status} />
      </div>

      {lastRefresh && (
        <p className="text-xs text-muted-foreground">
          Last refresh {new Date(lastRefresh.at).toLocaleString()} · {lastRefresh.dirs.length} folder{lastRefresh.dirs.length === 1 ? "" : "s"}
          {lastRefresh.jellyfin && ` · Jellyfin ${lastRefresh.jellyfin.ok ? (lastRefresh.jellyfin.mode === "full" ? "full scan" : "ok") : `failed: ${lastRefresh.jellyfin.error}`}`}
          {lastRefresh.plex && ` · Plex ${lastRefresh.plex.ok ? "ok" : `failed: ${lastRefresh.plex.error}`}`}
        </p>
      )}
    </GlassPanel>
  );
}

/** Settings → Connect: outbound notifications + media-server refresh. */
export function ConnectSettings() {
  const [view, setView] = React.useState<ConnectView | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [editing, setEditing] = React.useState<Target | null>(null);

  const load = React.useCallback(() => {
    setError(null);
    api<ConnectView>("/api/connect").then(setView).catch(setError);
  }, []);
  React.useEffect(load, [load]);

  if (error) return <ErrorNotice error={error} what="Connect settings" onRetry={load} />;
  if (!view) {
    return (
      <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <>
      <GlassPanel className="space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Notifications</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Send grabs, imports, failures, health issues and updates to your phone or chat.
            </p>
          </div>
          {!editing && (
            <Button size="sm" onClick={() => setEditing(blankTarget())}>
              <PlusIcon className="size-4" /> Add target
            </Button>
          )}
        </div>

        {editing && (
          <TargetEditor
            key={editing.id ?? "new"}
            initial={editing}
            events={view.events}
            onSaved={v => { setView(v); setEditing(null); }}
            onCancel={() => setEditing(null)}
          />
        )}

        {view.targets.length === 0 && !editing ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/10 px-4 py-8 text-center">
            <BellIcon className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No targets yet. Add ntfy, Discord, Apprise or a webhook.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {view.targets.filter(t => t.id !== editing?.id).map(t => (
              <TargetRow key={t.id} target={t} events={view.events} onEdit={() => setEditing({ ...blankTarget(t.type), ...t })} onChanged={setView} />
            ))}
          </ul>
        )}
      </GlassPanel>

      <MediaRefreshPanel initial={view.mediaRefresh} lastRefresh={view.lastRefresh} onSaved={setView} />
    </>
  );
}
