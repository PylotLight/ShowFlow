import * as React from "react";
import { Loader2Icon, RefreshCwIcon, DownloadIcon, Trash2Icon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";
import { formatBytes } from "./SettingsShared";

interface Retention { recent: number; daily: number; weekly: number }
const DEFAULT_RETENTION: Retention = { recent: 2, daily: 7, weekly: 4 };
const RETENTION_FIELDS: { key: keyof Retention; label: string; hint: string }[] = [
  { key: "recent", label: "Recent", hint: "newest backups, always kept" },
  { key: "daily", label: "Daily", hint: "newest per day" },
  { key: "weekly", label: "Weekly", hint: "newest per week" },
];
const KEPT_LABEL: Record<string, string> = { recent: "recent", daily: "daily", weekly: "weekly" };

function sameRetention(a: Retention, b: Record<keyof Retention, string>) {
  return RETENTION_FIELDS.every(f => String(a[f.key]) === b[f.key]);
}

export function BackupPanel() {
  const [backups, setBackups] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [confirmRestore, setConfirmRestore] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [retention, setRetention] = React.useState<Retention>(DEFAULT_RETENTION);
  const [draft, setDraft] = React.useState<Record<keyof Retention, string>>({ recent: "2", daily: "7", weekly: "4" });
  const [images, setImages] = React.useState<{ files: number; bytes: number } | null>(null);
  const [savingKeep, setSavingKeep] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    fetch('/api/backup').then(r => r.json()).then(setBackups).finally(() => setLoading(false));
    fetch('/api/backup/summary').then(r => r.json()).then((data: { retention?: Retention; images?: { files: number; bytes: number } }) => {
      if (data.retention) applyRetention(data.retention);
      if (data.images) setImages(data.images);
    }).catch(() => {});
  }

  function applyRetention(r: Retention) {
    setRetention(r);
    setDraft({ recent: String(r.recent), daily: String(r.daily), weekly: String(r.weekly) });
  }

  React.useEffect(() => { load(); }, []);

  function createBackup() {
    setCreating(true);
    fetch('/api/backup', { method: 'POST' }).then(r => r.json()).then(data => {
      if (data.entries) setBackups(data.entries);
    }).finally(() => setCreating(false));
  }

  function handleUpload(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    fetch('/api/backups/upload', { method: 'POST', body: form })
      .then(async r => {
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          throw new Error(text || `Upload failed (HTTP ${r.status})`);
        }
        return r.json();
      })
      .then(() => load())
      .catch(err => {
        window.alert(`Backup upload failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setUploading(false));
  }

  function handleRestore() {
    if (!confirmRestore) return;
    setRestoring(true);
    fetch(`/api/backups/${encodeURIComponent(confirmRestore)}/restore`, { method: 'POST' })
      .then(r => r.json()).then(data => {
        if (data.ok) {
          window.location.reload();
        }
      }).finally(() => {
        setRestoring(false);
        setConfirmRestore(null);
      });
  }

  function handleDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    fetch(`/api/backups/${encodeURIComponent(confirmDelete)}`, { method: 'DELETE' })
      .then(r => r.json()).then(data => {
        if (data.entries) setBackups(data.entries);
        else load();
      }).finally(() => {
        setDeleting(false);
        setConfirmDelete(null);
      });
  }

  function saveRetention() {
    const next = {} as Retention;
    for (const f of RETENTION_FIELDS) {
      const n = parseInt(draft[f.key], 10);
      if (!Number.isFinite(n) || n < 0 || n > 100) return;
      next[f.key] = n;
    }
    setSavingKeep(true);
    fetch('/api/backup/prune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retention: next }),
    })
      .then(r => r.json())
      .then(data => {
        if (data?.retention) applyRetention(data.retention);
        if (data?.images) setImages(data.images);
        if (data?.entries) setBackups(data.entries);
        else load();
      })
      .finally(() => setSavingKeep(false));
  }

  const totalBackupBytes = backups.reduce((n, b) => n + (b.size ?? 0) + (b.sqlSize ?? 0), 0);

  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[12rem] flex-1">
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Database Backups</h3>
            <p className="text-muted-foreground text-xs mt-0.5">Full snapshots of your database and settings — used for recovery or seeding fresh instances</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".db,.sql"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5 rotate-180" />}
              Upload
            </Button>
            <Button size="sm" onClick={createBackup} disabled={creating}>
              {creating ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
              Create Backup
            </Button>
          </div>
        </div>

        <div className="rounded-lg px-4 py-3 bg-white/[0.03] space-y-3">
          <div>
            <div className="text-sm font-medium text-white/80">Retention</div>
            <p className="text-muted-foreground text-xs mt-0.5">
              Keeps the newest {retention.recent}, plus the newest backup of each of the last {retention.daily} day{retention.daily === 1 ? '' : 's'} and {retention.weekly} week{retention.weekly === 1 ? '' : 's'} (.db + seed SQL count as one). Lower a number and the excess is deleted immediately.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {RETENTION_FIELDS.map(f => (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-xs text-white/70">{f.label} <span className="text-muted-foreground">· {f.hint}</span></span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={draft[f.key]}
                  onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
                  aria-label={`${f.label} backups to keep`}
                  className="w-20 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-sm text-white/90 outline-none focus:border-white/25 focus-visible:ring-2 focus-visible:ring-signal"
                />
              </label>
            ))}
            <Button size="sm" variant="outline" onClick={saveRetention} disabled={savingKeep || sameRetention(retention, draft)}>
              {savingKeep ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Apply
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {backups.length} backup{backups.length === 1 ? '' : 's'} · {formatBytes(totalBackupBytes)}
            {images && images.files > 0 && (
              <> · artwork {formatBytes(images.bytes)} ({images.files} files, shared by all backups)</>
            )}
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : backups.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">No backups yet. Create your first one above.</p>
        ) : (
          <div className="space-y-1.5">
            {backups.map(b => (
              <div key={b.name} className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
                <div className="size-8 rounded-lg bg-signal/10 grid place-items-center shrink-0">
                  <span className="text-signal font-mono text-[11px] font-bold leading-none">DB</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-medium truncate">{b.name}</div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                    <span title={b.hasSql ? `.db ${formatBytes(b.size)} + seed SQL ${formatBytes(b.sqlSize ?? 0)}` : undefined}>
                      {formatBytes((b.size ?? 0) + (b.sqlSize ?? 0))}
                    </span>
                    <span>{new Date(b.date).toLocaleString()}</span>
                    {b.keptBy ? (
                      <span className="font-mono text-[11px] uppercase tracking-wide text-white/70">{KEPT_LABEL[b.keptBy] ?? b.keptBy}</span>
                    ) : b.keptBy === null ? (
                      <span className="font-mono text-[11px] uppercase tracking-wide text-amber-400/90">next prune</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button aria-label="Restore from this backup"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setConfirmRestore(b.name)}
                    title="Restore from this backup"
                    className="text-amber-500/90 hover:text-amber-400"
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                  <a aria-label="Download .db"
                    href={`/api/backups/${b.name}`}
                    download
                    className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
                    title="Download .db"
                  >
                    <DownloadIcon className="size-4" />
                  </a>
                  {b.hasSql && (
                    <a
                      href={`/api/backups/${b.name.replace(/\.db$/, '.sql')}`}
                      download
                      className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
                      title="Download seed SQL"
                    >
                      <span className="text-[11px] font-mono font-bold px-1">SQL</span>
                    </a>
                  )}
                  <Button aria-label="Delete this backup"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(b.name)}
                    title="Delete this backup"
                    className="text-red-500/90 hover:text-red-400"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      {confirmRestore && (
        <div role="dialog" aria-modal="true" aria-label="Restore backup" className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#0a0a0f] p-6 shadow-2xl space-y-4">
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Restore Backup</h3>
            <p className="text-muted-foreground text-sm">
              This will replace your current database with <span className="font-mono text-white/70">{confirmRestore}</span>. 
              Current data will be lost. The page will reload after restoration.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmRestore(null)} disabled={restoring}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={handleRestore} disabled={restoring}>
                {restoring ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Restore
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div role="dialog" aria-modal="true" aria-label="Delete backup" className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#0a0a0f] p-6 shadow-2xl space-y-4">
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Delete Backup</h3>
            <p className="text-muted-foreground text-sm">
              Permanently delete <span className="font-mono text-white/70">{confirmDelete}</span>
              <span className="text-white/60"> + its seed SQL companion, if present</span>? This can't be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
