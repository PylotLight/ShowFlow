import * as React from "react";
import { Loader2Icon, RefreshCwIcon, DownloadIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Button } from "@frontend/components/ui/button";
import { formatBytes } from "./SettingsShared";

export function BackupPanel() {
  const [backups, setBackups] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [confirmRestore, setConfirmRestore] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    fetch('/api/backup').then(r => r.json()).then(setBackups).finally(() => setLoading(false));
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
      .then(r => r.json()).then(() => load())
      .finally(() => setUploading(false));
  }

  function handleRestore() {
    if (!confirmRestore) return;
    setRestoring(true);
    fetch(`/api/backups/${confirmRestore}/restore`, { method: 'POST' })
      .then(r => r.json()).then(data => {
        if (data.ok) {
          window.location.reload();
        }
      }).finally(() => {
        setRestoring(false);
        setConfirmRestore(null);
      });
  }

  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
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
                  <span className="text-signal font-mono text-[10px] font-bold leading-none">DB</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-medium truncate">{b.name}</div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-3 text-xs">
                    <span>{formatBytes(b.size)}</span>
                    <span>{new Date(b.date).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setConfirmRestore(b.name)}
                    title="Restore from this backup"
                    className="text-amber-500/60 hover:text-amber-400"
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                  <a
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
                      <span className="text-[10px] font-mono font-bold px-1">SQL</span>
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      {confirmRestore && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
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
    </>
  );
}
