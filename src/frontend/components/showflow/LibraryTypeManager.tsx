import * as React from "react";
import { PlusIcon, Loader2Icon, CheckIcon, XIcon, Trash2Icon, StarIcon } from "lucide-react";
import { Input } from "@frontend/components/ui/input";
import { Button } from "@frontend/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { FolderPicker } from "./FolderPicker";

interface LibraryType {
  id: string;
  name: string;
  root_folder_path: string | null;
  quality_profile_id: string | null;
  indexers: string[];
  is_default: number;
}

interface QualityProfile {
  id: string;
  name: string;
}

export function LibraryTypeManager() {
  const [types, setTypes] = React.useState<LibraryType[]>([]);
  const [qualityProfiles, setQualityProfiles] = React.useState<QualityProfile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [newName, setNewName] = React.useState("");
  const [newPath, setNewPath] = React.useState("");
  const [newQualityProfileId, setNewQualityProfileId] = React.useState("");

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch("/api/library-types").then(r => r.json()),
      fetch("/api/profiles").then(r => r.json()),
    ])
      .then(([libraryTypesData, profilesData]) => {
        setTypes(Array.isArray(libraryTypesData) ? libraryTypesData : []);
        const profiles = Array.isArray(profilesData) ? profilesData : [];
        setQualityProfiles(profiles);
        if (!newQualityProfileId && profiles.length > 0) {
          setNewQualityProfileId(profiles[0].id);
        }
      })
      .catch(() => {
        setTypes([]);
        setError("Failed to load library types.");
      })
      .finally(() => setLoading(false));
  }

  React.useEffect(load, []);

  function slugify(name: string) {
    return (
      name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
      crypto.randomUUID().slice(0, 8)
    );
  }

  async function saveType(payload: {
    id: string;
    name: string;
    rootFolderPath?: string;
    qualityProfileId?: string;
    isDefault?: boolean;
  }) {
    setSaving(payload.id);
    setError(null);
    try {
      const res = await fetch("/api/library-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to save library type");
      }

      // Backend doesn't enforce single-default itself - if this one is now
      // the default, unset the previous default(s) so only one sticks.
      if (payload.isDefault) {
        const others = types.filter(t => t.id !== payload.id && t.is_default === 1);
        for (const other of others) {
          await fetch("/api/library-types", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: other.id,
              name: other.name,
              rootFolderPath: other.root_folder_path ?? undefined,
              qualityProfileId: other.quality_profile_id ?? undefined,
              isDefault: false,
            }),
          }).catch(() => {});
        }
      }

      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save library type");
    } finally {
      setSaving(null);
    }
  }

  async function removeType(id: string) {
    setSaving(id);
    setError(null);
    try {
      const res = await fetch(`/api/library-types/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete library type");
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete library type");
    } finally {
      setSaving(null);
    }
  }

  function createType() {
    if (!newName.trim() || !newPath.trim()) return;
    const id = `lt_${slugify(newName)}_${crypto.randomUUID().slice(0, 6)}`;
    saveType({
      id,
      name: newName.trim(),
      rootFolderPath: newPath.trim(),
      qualityProfileId: newQualityProfileId || undefined,
      isDefault: types.length === 0,
    });
    setNewName("");
    setNewPath("");
    setAdding(false);
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <XIcon className="size-3.5 shrink-0" />
              {error}
            </div>
          )}

          {types.length > 0 && (
            <div className="space-y-2">
              {types.map(t => (
                <LibraryTypeRow
                  key={t.id}
                  type={t}
                  qualityProfiles={qualityProfiles}
                  saving={saving === t.id}
                  onSave={updates => saveType({ id: t.id, ...updates })}
                  onRemove={() => removeType(t.id)}
                />
              ))}
            </div>
          )}

          {!adding ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/5 px-3 py-1.5 font-mono text-xs text-foreground/80 transition-colors"
              >
                <PlusIcon className="size-3" />
                {types.length === 0 ? "Add a library" : "Add library"}
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg px-4 py-3 bg-white/[0.04]">
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Library name (e.g. TV Shows)"
                  className="w-48"
                />
                <FolderPicker value={newPath} onChange={setNewPath} />
                <Select value={newQualityProfileId} onValueChange={setNewQualityProfileId}>
                  <SelectTrigger className="w-36">
                    <SelectValue placeholder="Quality profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {qualityProfiles.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={createType} disabled={saving !== null || !newName.trim() || !newPath.trim()}>
                  {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                  Add
                </Button>
                <button
                  type="button"
                  onClick={() => { setAdding(false); setNewName(""); setNewPath(""); }}
                  className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            </div>
          )}

          {types.length === 0 && !adding && (
            <p className="text-muted-foreground py-2 text-center text-xs">
              No libraries yet. Create one above to start organizing your shows.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function LibraryTypeRow({ type, qualityProfiles, saving, onSave, onRemove }: {
  type: LibraryType;
  qualityProfiles: QualityProfile[];
  saving: boolean;
  onSave: (updates: { name: string; rootFolderPath?: string; qualityProfileId?: string; isDefault?: boolean }) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(type.name);
  const [path, setPath] = React.useState(type.root_folder_path ?? "");
  const [qualityProfileId, setQualityProfileId] = React.useState(type.quality_profile_id ?? "");

  React.useEffect(() => {
    setName(type.name);
    setPath(type.root_folder_path ?? "");
    setQualityProfileId(type.quality_profile_id ?? "");
  }, [type.name, type.root_folder_path, type.quality_profile_id]);

  const profileName = qualityProfiles.find(p => p.id === type.quality_profile_id)?.name ?? "—";

  if (!editing) {
    return (
      <div className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
        <div className="size-8 rounded-lg bg-signal/10 grid place-items-center shrink-0">
          <span className="text-signal font-mono text-[10px] font-bold uppercase leading-none">{type.name.slice(0, 2)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-medium flex items-center gap-1.5">
            {type.name}
            {type.is_default === 1 && (
              <span className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-signal">
                <StarIcon className="size-3 fill-signal" /> Default
              </span>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 font-mono text-xs truncate">
            {type.root_folder_path || "No root folder set"} · {profileName}
          </div>
        </div>
        {type.is_default !== 1 && (
          <button
            type="button"
            onClick={() => onSave({ name: type.name, rootFolderPath: type.root_folder_path ?? undefined, qualityProfileId: type.quality_profile_id ?? undefined, isDefault: true })}
            disabled={saving}
            className="text-muted-foreground hover:text-foreground text-xs font-mono uppercase tracking-wider transition-colors shrink-0"
          >
            Make default
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-muted-foreground hover:text-foreground text-xs font-mono uppercase tracking-wider transition-colors shrink-0"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={saving}
          className="text-muted-foreground hover:text-red-400 shrink-0 transition-colors"
        >
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : <Trash2Icon className="size-4" />}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg px-4 py-3 bg-white/[0.04]">
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Library name"
          className="w-32"
        />
        <FolderPicker value={path} onChange={setPath} />
        <Select value={qualityProfileId} onValueChange={setQualityProfileId}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Quality profile" />
          </SelectTrigger>
          <SelectContent>
            {qualityProfiles.map(p => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          onClick={() => { onSave({ name, rootFolderPath: path, qualityProfileId: qualityProfileId || undefined, isDefault: type.is_default === 1 }); setEditing(false); }}
          disabled={saving || !name.trim() || !path.trim()}
        >
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
        </Button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
