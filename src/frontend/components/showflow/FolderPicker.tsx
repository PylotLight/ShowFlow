import * as React from "react";
import { createPortal } from "react-dom";
import { FolderOpenIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { Input } from "@frontend/components/ui/input";
import { Button } from "@frontend/components/ui/button";

export function FolderPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [currentPath, setCurrentPath] = React.useState(value || "/");
  const [dirs, setDirs] = React.useState<string[]>([]);
  const [parentPath, setParentPath] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [customPath, setCustomPath] = React.useState("");
  const [position, setPosition] = React.useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  function loadDir(dirPath: string) {
    setLoading(true);
    setError(null);
    fetch(`/api/files/browse?path=${encodeURIComponent(dirPath)}`)
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || "Failed to load directory"); });
        return r.json();
      })
      .then(data => {
        setCurrentPath(data.path);
        setDirs(data.directories);
        setParentPath(data.parentPath);
        setCustomPath("");
        setError(null);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }

  function openPanel() {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: rect.left, width: Math.max(rect.width, 320) });
    }
    setOpen(true);
    setCustomPath("");
    loadDir(value || "/");
  }

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick);
      window.addEventListener('scroll', () => setOpen(false), { once: true });
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative flex-1" ref={containerRef}>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="/path/to/root/folder"
          className="flex-1 font-mono h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />
        <button
          type="button"
          onClick={openPanel}
          className="flex items-center gap-1.5 rounded-md border border-input bg-transparent hover:bg-white/[0.04] text-muted-foreground hover:text-foreground h-9 px-3 font-mono text-xs uppercase tracking-wider transition-colors shrink-0"
        >
          <FolderOpenIcon className="size-3.5" />
          Browse
        </button>
      </div>

      {open && position && createPortal(
        <div ref={panelRef} className="fixed z-[9999] rounded-lg border border-white/10 bg-[#15181f] shadow-xl p-3 max-h-80 overflow-y-auto"
          style={{ top: position.top, left: position.left, width: position.width, backdropFilter: "blur(16px)" }}>
          <div className="px-2 py-1 font-mono text-caption text-muted-foreground/60 truncate" title={currentPath}>
            {currentPath}
          </div>

          <div className="flex gap-2 mt-2 mb-2">
            <Input
              value={customPath}
              onChange={e => setCustomPath(e.target.value)}
              placeholder="Or type a path..."
              className="flex-1 font-mono text-sm h-8"
            />
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 h-8"
              onClick={() => { if (customPath) loadDir(customPath); }}
            >
              Go
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="px-2 py-3 text-xs text-red-400">{error}</div>
          ) : dirs.length === 0 && !parentPath ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No subdirectories</div>
          ) : (
            <div className="mt-1 space-y-0.5">
              {parentPath && (
                <button
                  onClick={() => loadDir(parentPath!)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronRightIcon className="size-3.5 -rotate-90" />
                  ..
                </button>
              )}
              {dirs.map(dir => (
                <button
                  key={dir}
                  onClick={() => loadDir(`${currentPath.replace(/\/$/, "")}/${dir}`)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] text-sm text-foreground/80 hover:text-foreground transition-colors text-left"
                >
                  <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{dir}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-2 border-t border-white/5 pt-1.5">
            <button
              type="button"
              onClick={() => { onChange(currentPath); setOpen(false); }}
              className="flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-1.5 transition-colors"
            >
              Select this folder
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground text-sm py-1.5 px-3 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
