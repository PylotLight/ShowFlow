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
} from "lucide-react";
import type { StepProps } from "../types";

export function StepRootFolders({ data, setData, onNext }: StepProps) {
  const [browseOpen, setBrowseOpen] = React.useState(false);
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

  const addFolder = React.useCallback((folderPath: string) => {
    if (!data.rootFolders.includes(folderPath)) {
      setData({ rootFolders: [...data.rootFolders, folderPath] });
    }
    setBrowseOpen(false);
    setCustomPath("");
  }, [data.rootFolders, setData]);

  const removeFolder = React.useCallback((folderPath: string) => {
    setData({ rootFolders: data.rootFolders.filter(f => f !== folderPath) });
  }, [data.rootFolders, setData]);

  return (
    <div className="py-4">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Root Folders</h2>
        <p className="text-muted-foreground">
          Choose where your media lives. Add at least one root folder for your
          shows to get started.
        </p>
      </div>

      {data.rootFolders.length > 0 && (
        <div className="space-y-2 mb-6">
          {data.rootFolders.map((folder, i) => (
            <div
              key={folder}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-xl border",
                "bg-white/[0.02] border-white/10"
              )}
            >
              <FolderIcon className="size-4 shrink-0 text-signal" />
              <span className="flex-1 text-sm font-mono truncate">{folder}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => removeFolder(folder)}
                className="text-muted-foreground/50 hover:text-red-400 shrink-0"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="gap-2 w-full h-12 rounded-xl border-dashed border-white/20">
            <PlusIcon className="size-4" />
            {data.rootFolders.length === 0 ? "Add a root folder" : "Add another folder"}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Browse Directories</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
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
              <Button
                variant="outline"
                className="shrink-0"
                disabled={!customPath}
                onClick={() => loadDir(customPath)}
              >
                Go
              </Button>
            </div>

            <div className="max-h-96 overflow-y-auto space-y-0.5 rounded-xl border border-white/10">
              {loading ? (
                <div className="flex items-center justify-center py-8">
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
                      <span className="flex-1 truncate">{dir}</span>
                      <ChevronRightIcon className="size-3.5 text-muted-foreground/40 shrink-0" />
                    </button>
                  ))}
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {newFolderOpen ? (
                <div className="flex items-center gap-2 flex-1 p-1.5 rounded-lg border border-white/10 bg-white/[0.02]">
                  <Input
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") { setNewFolderOpen(false); setNewFolderName(""); setNewFolderError(null); } }}
                    placeholder="Folder name"
                    className="flex-1 font-mono text-sm h-8"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setNewFolderOpen(false); setNewFolderName(""); setNewFolderError(null); }}
                    disabled={newFolderSaving}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={!newFolderName.trim() || newFolderSaving}
                    onClick={createFolder}
                  >
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
              {newFolderError && (
                <span className="text-xs text-red-400 ml-2">{newFolderError}</span>
              )}
              <Button
                variant="glass"
                className="ml-auto gap-2 h-10 rounded-xl"
                onClick={() => addFolder(currentPath)}
              >
                <FolderIcon className="size-4" />
                Select this folder
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="mt-8 flex items-center justify-between">
        <div>
          {data.rootFolders.length === 0 && (
            <p className="text-xs text-muted-foreground/50">
              You need at least one root folder to continue
            </p>
          )}
        </div>
        <Button
          variant="glass"
          onClick={onNext}
          disabled={data.rootFolders.length === 0}
          className="gap-2 h-11 px-6 rounded-xl"
        >
          Next step
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
