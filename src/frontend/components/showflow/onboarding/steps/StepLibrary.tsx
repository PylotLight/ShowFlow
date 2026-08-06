import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@frontend/components/ui/dialog";
import { cn } from "@frontend/lib/utils";
import {
  FolderIcon,
  PlusIcon,
  Trash2Icon,
  ChevronRightIcon,
  ArrowRightIcon,
  HardDriveIcon,
  Loader2Icon,
  FolderInputIcon,
  CheckIcon,
  XIcon,
  BookIcon,
  SparklesIcon,
  StarIcon,
  InfoIcon,
} from "lucide-react";
import type { StepProps } from "../types";

const NAMING_OPTIONS = [
  { id: 'Standard', label: 'Standard', icon: BookIcon },
  { id: 'Anime', label: 'Anime', icon: SparklesIcon },
  { id: 'Movies', label: 'Movies', icon: StarIcon },
] as const;

export function StepLibrary({ data, setData, onNext, onSkip }: StepProps) {
  const [browseOpen, setBrowseOpen] = React.useState(false);
  const [browseTarget, setBrowseTarget] = React.useState<string | null>(null);
  const [currentPath, setCurrentPath] = React.useState("");
  const [dirs, setDirs] = React.useState<string[]>([]);
  const [parentPath, setParentPath] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [customPath, setCustomPath] = React.useState("");
  const [newFolderOpen, setNewFolderOpen] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState("");
  const [newFolderSaving, setNewFolderSaving] = React.useState(false);
  const [newFolderError, setNewFolderError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [libraryNames, setLibraryNames] = React.useState<Record<string, string>>({});
  const [namingByFolder, setNamingByFolder] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!data.rootFolders.length) return;
    setLibraryNames(prev => {
      const next = { ...prev };
      for (const folder of data.rootFolders) {
        if (!next[folder]) {
          const folderName = folder.split('/').pop() ?? 'My Library';
          next[folder] = folderName;
        }
      }
      return next;
    });
    setNamingByFolder(prev => {
      const next = { ...prev };
      for (const folder of data.rootFolders) {
        if (!next[folder]) next[folder] = 'Standard';
      }
      return next;
    });
  }, [data.rootFolders]);

  const loadDir = React.useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/browse?path=${encodeURIComponent(dirPath || "")}`);
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Failed to load directory");
      }
      const data = await res.json();
      setCurrentPath(data.path);
      setDirs(data.directories);
      setParentPath(data.parentPath);
      setCustomPath("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse directory");
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (browseOpen) loadDir("");
  }, [browseOpen, loadDir]);

  const createFolder = React.useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderSaving(true);
    setNewFolderError(null);
    try {
      const res = await fetch("/api/files/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: currentPath, name }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Failed to create folder");
      }
      setNewFolderOpen(false);
      setNewFolderName("");
      loadDir(currentPath);
    } catch (err) {
      setNewFolderError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setNewFolderSaving(false);
    }
  }, [newFolderName, currentPath, loadDir]);

  const openBrowser = (existingFolder?: string) => {
    setBrowseTarget(existingFolder ?? null);
    setBrowseOpen(true);
  };

  const selectFolder = (folderPath: string) => {
    if (browseTarget) {
      setData({ rootFolders: data.rootFolders.map(f => f === browseTarget ? folderPath : f) });
    } else if (!data.rootFolders.includes(folderPath)) {
      setData({ rootFolders: [...data.rootFolders, folderPath] });
    }
    setBrowseOpen(false);
    setBrowseTarget(null);
    setCustomPath("");
  };

  const removeFolder = React.useCallback((folderPath: string) => {
    setData({ rootFolders: data.rootFolders.filter(f => f !== folderPath) });
    setLibraryNames(prev => { const n = { ...prev }; delete n[folderPath]; return n; });
    setNamingByFolder(prev => { const n = { ...prev }; delete n[folderPath]; return n; });
  }, [data.rootFolders, setData]);

  const handleContinue = async () => {
    setSaving(true);
    setSaveError(null);
    const failures: string[] = [];
    try {
      for (let i = 0; i < data.rootFolders.length; i++) {
        const folder = data.rootFolders[i]!;
        const libName = libraryNames[folder]?.trim() || (folder.split('/').pop() ?? 'Library');
        const namingType = namingByFolder[folder] ?? 'Standard';
        const slug = `lt_${libName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
        const uniqueSlug = `${slug}_${folder.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
        try {
          const res = await fetch("/api/library-types", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: uniqueSlug,
              name: libName,
              namingConvention: namingType,
              rootFolderPath: folder,
              qualityProfileId: 'standard',
              // First library created becomes the default so grabber/resolve
              // logic has something to fall back to (see resolveLibraryTypeId).
              isDefault: i === 0,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            failures.push(`"${libName}": ${body.error || res.statusText}`);
          }
        } catch (err) {
          failures.push(`"${libName}": ${err instanceof Error ? err.message : 'network error'}`);
        }
      }

      if (failures.length > 0) {
        setSaveError(`Couldn't save ${failures.length} librar${failures.length === 1 ? 'y' : 'ies'}: ${failures.join('; ')}`);
        return;
      }

      onNext();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-4 flex flex-col" style={{ maxHeight: 'calc(100vh - 220px)' }}>
      <div className="mb-6 shrink-0">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Create Libraries</h2>
        <p className="text-muted-foreground">
          Define your media libraries. Each library has a name, a folder on disk,
          and a naming convention that controls how files are organised.
        </p>
      </div>

      {data.rootFolders.length > 0 && (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3 mb-4 -mx-1 px-1">
          {data.rootFolders.map(folder => {
            const libName = libraryNames[folder] ?? (folder.split('/').pop() ?? '');
            const namingType = namingByFolder[folder] ?? 'Standard';
            return (
              <div
                key={folder}
                className="p-5 rounded-xl border bg-white/[0.02] border-white/10 space-y-4"
              >
                {/* Library name + delete */}
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/50 mb-1.5 block">
                      Library Name
                    </label>
                    <Input
                      value={libName}
                      onChange={e => setLibraryNames(prev => ({ ...prev, [folder]: e.target.value }))}
                      placeholder="e.g. TV Shows, Anime, Movies"
                      className="font-medium text-sm"
                    />
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => removeFolder(folder)}
                    className="text-muted-foreground/50 hover:text-red-400 shrink-0 mt-5"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>

                {/* Root folder */}
                <div>
                  <label className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/50 mb-1.5 block">
                    Root Folder
                  </label>
                  <button
                    onClick={() => openBrowser(folder)}
                    className="w-full flex items-center gap-3 p-3 rounded-lg bg-black/30 border border-white/10 hover:border-white/20 transition-colors text-left"
                  >
                    <FolderIcon className="size-4 shrink-0 text-signal" />
                    <span className="flex-1 text-sm font-mono truncate text-muted-foreground/80">{folder}</span>
                    <ChevronRightIcon className="size-3.5 text-muted-foreground/40 shrink-0" />
                  </button>
                </div>

                {/* Naming convention */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/50">
                      Naming Convention
                    </label>
                    <span className="text-[10px] text-muted-foreground/30">(can be changed later)</span>
                  </div>
                  <div className="flex gap-1.5">
                    {NAMING_OPTIONS.map(opt => {
                      const isActive = namingType === opt.id;
                      const OptIcon = opt.icon;
                      return (
                        <button
                          key={opt.id}
                          onClick={() => setNamingByFolder(prev => ({ ...prev, [folder]: opt.id }))}
                          className={cn(
                            "flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-all duration-200",
                            isActive
                              ? "bg-signal/10 text-signal ring-1 ring-signal/30"
                              : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/[0.03]"
                          )}
                        >
                          <OptIcon className="size-3.5" />
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground/30 mt-1.5">
                    Controls episode/file naming format per {namingType.toLowerCase()} standard. Configured per-series in Sonarr.
                  </p>
                </div>

                {/* Quality profile */}
                <div className="flex items-start gap-2.5 p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <InfoIcon className="size-3.5 text-muted-foreground/40 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground/70">Quality Profile: Standard (default)</p>
                    <p className="text-[10px] text-muted-foreground/30 mt-0.5">
                      Controls resolution &amp; file format preferences. Additional profiles
                      can be created and assigned in Settings later.
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="shrink-0">
      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="gap-2 w-full h-12 rounded-xl border-dashed border-white/20">
            <PlusIcon className="size-4" />
            {data.rootFolders.length === 0 ? "Add a library folder" : "Add another library"}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-xl p-0 max-h-[90vh] overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-white/10">
            <DialogTitle>Browse Directories</DialogTitle>
          </DialogHeader>

          <div className="px-6 py-4 space-y-4 overflow-hidden flex flex-col" style={{ maxHeight: 'calc(90vh - 140px)' }}>
            <div className="flex items-center gap-2 p-3 rounded-lg bg-white/[0.03] border border-white/10 font-mono text-xs text-muted-foreground">
              <HardDriveIcon className="size-3.5 shrink-0" />
              <span className="truncate">{currentPath}</span>
            </div>

            <div className="flex gap-2">
              <Input
                value={customPath}
                onChange={e => setCustomPath(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && customPath) loadDir(customPath); }}
                placeholder="Or type a path..."
                className="flex-1 font-mono text-sm"
              />
              <Button variant="outline" className="shrink-0" disabled={!customPath} onClick={() => loadDir(customPath)}>
                Go
              </Button>
            </div>

            <div className="flex-1 min-h-0 border border-white/10 rounded-xl overflow-hidden bg-black/30">
              <div className="h-full overflow-auto space-y-0.5 overflow-x-hidden">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : error ? (
                  <div className="p-4 text-sm text-red-400 text-center">{error}</div>
                ) : dirs.length === 0 && !parentPath ? (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    No subdirectories
                  </div>
                ) : (
                  <>
                    {parentPath && (
                      <button
                        onClick={() => loadDir(parentPath)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/[0.03] transition-colors text-left text-muted-foreground"
                      >
                        <ChevronRightIcon className="size-4 -rotate-90 shrink-0" />
                        <span className="font-mono">.. (parent)</span>
                      </button>
                    )}

                    {dirs.map(dir => (
                      <button
                        key={dir}
                        onClick={() => loadDir(`${currentPath.replace(/\/$/, "")}/${dir}`)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/[0.03] transition-colors text-left"
                      >
                        <FolderIcon className="size-4 shrink-0 text-amber-400/70" />
                        <span className="flex-1 truncate min-w-0">{dir}</span>
                        <ChevronRightIcon className="size-3.5 text-muted-foreground/40 shrink-0" />
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2 flex-shrink-0">
              {newFolderOpen ? (
                <div className="flex items-center gap-2 flex-1 p-1.5 rounded-lg border border-white/10 bg-white/[0.02]">
                  <Input
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") createFolder();
                      if (e.key === "Escape") {
                        setNewFolderOpen(false);
                        setNewFolderName("");
                        setNewFolderError(null);
                      }
                    }}
                    placeholder="Folder name"
                    className="flex-1 font-mono text-sm h-8"
                    autoFocus
                  />
                  <Button size="sm" variant="ghost" onClick={() => { setNewFolderOpen(false); setNewFolderName(""); setNewFolderError(null); }} disabled={newFolderSaving}>
                    <XIcon className="size-3.5" />
                  </Button>
                  <Button size="sm" className="shrink-0" disabled={!newFolderName.trim() || newFolderSaving} onClick={createFolder}>
                    {newFolderSaving ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setNewFolderOpen(true); setNewFolderError(null); }}
                  className="gap-1.5 text-muted-foreground/60 hover:text-muted-foreground"
                >
                  <FolderInputIcon className="size-3.5" />
                  New Folder
                </Button>
              )}

              {newFolderError && <span className="text-xs text-red-400 ml-2">{newFolderError}</span>}

              <Button
                variant="glass"
                className="ml-auto gap-2 h-10 rounded-xl"
                onClick={() => selectFolder(currentPath)}
              >
                <FolderIcon className="size-4" />
                Select this folder
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {saveError && (
        <div className="mt-4 shrink-0 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-xs text-red-400">
          {saveError}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between shrink-0">
        <div>
          {data.rootFolders.length === 0 && (
            <p className="text-xs text-muted-foreground/50">
              Add at least one library to continue
            </p>
          )}
        </div>
        <Button
          variant="glass"
          onClick={handleContinue}
          disabled={data.rootFolders.length === 0 || saving}
          className="gap-2 h-11 px-6 rounded-xl"
        >
          {saving ? "Saving..." : "Next step"}
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
      </div>
    </div>
  );
}
