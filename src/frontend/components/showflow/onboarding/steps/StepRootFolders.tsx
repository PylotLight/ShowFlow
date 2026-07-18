import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@frontend/components/ui/select";
import {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@frontend/components/ui/dialog";
import { cn } from "@frontend/lib/utils";
import {
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  Trash2Icon,
  ChevronRightIcon,
  ArrowRightIcon,
  FileIcon,
  HardDriveIcon,
  AlertCircleIcon,
} from "lucide-react";
import type { StepProps } from "../types";

export function StepRootFolders({ data, setData, onNext }: StepProps) {
  const [browseOpen, setBrowseOpen] = React.useState(false);
  const [currentPath, setCurrentPath] = React.useState("/");
  const [entries, setEntries] = React.useState<{ name: string; isDirectory: boolean }[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [customPath, setCustomPath] = React.useState("");

  const fetchEntries = React.useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/browse?path=${encodeURIComponent(path)}`);
      if (!res.ok) { setError("Could not browse this directory"); setEntries([]); return; }
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch {
      setError("Failed to browse directory");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (browseOpen) fetchEntries(currentPath);
  }, [browseOpen, currentPath, fetchEntries]);

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
        <DialogPortal>
          <DialogOverlay />
          <DialogContent className="max-w-lg">
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
                  placeholder="Or type a path..."
                  className="flex-1 font-mono text-sm"
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    if (customPath) {
                      setCurrentPath(customPath);
                      fetchEntries(customPath);
                    }
                  }}
                >
                  Go
                </Button>
              </div>

              <div className="max-h-64 overflow-y-auto space-y-0.5 rounded-xl border border-white/10">
                {loading && (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    Loading...
                  </div>
                )}
                {error && (
                  <div className="p-4 flex items-center gap-2 text-sm text-red-400">
                    <AlertCircleIcon className="size-4" />
                    {error}
                  </div>
                )}
                {!loading && !error && entries.length === 0 && (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    Empty directory
                  </div>
                )}
                {!loading && !error && entries.filter(e => e.isDirectory).map(entry => (
                  <button
                    key={entry.name}
                    onClick={() => setCurrentPath(
                      currentPath === "/"
                        ? `/${entry.name}`
                        : `${currentPath}/${entry.name}`
                    )}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/[0.03] transition-colors text-left"
                  >
                    <FolderOpenIcon className="size-4 shrink-0 text-amber-400/70" />
                    <span className="flex-1 truncate">{entry.name}</span>
                    <ChevronRightIcon className="size-3.5 text-muted-foreground/40" />
                  </button>
                ))}
              </div>

              <Button
                className="w-full gap-2 h-10 rounded-xl"
                onClick={() => addFolder(currentPath)}
              >
                <FolderIcon className="size-4" />
                Select this folder
              </Button>
            </div>
          </DialogContent>
        </DialogPortal>
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
