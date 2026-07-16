import * as React from "react";
import { PlusIcon, Loader2Icon, CheckIcon, XIcon, Trash2Icon } from "lucide-react";
import { Input } from "@frontend/components/ui/input";
import { Button } from "@frontend/components/ui/button";
import { FolderPicker } from "./FolderPicker";

export function ShowProfileManager() {
  const [profiles, setProfiles] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newPath, setNewPath] = React.useState("");

  function load() {
    setLoading(true);
    fetch("/api/show-profiles")
      .then(r => r.json())
      .then(data => { setProfiles(Array.isArray(data) ? data : []); })
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  }

  React.useEffect(load, []);

  function saveProfile(id: string, name: string, rootFolderPath: string) {
    setSaving(id);
    fetch("/api/show-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, rootFolderPath }),
    }).then(r => { if (r.ok) load(); })
    .finally(() => setSaving(null));
  }

  function removeProfile(id: string) {
    setSaving(id);
    fetch(`/api/show-profiles/${id}`, { method: "DELETE" })
      .then(r => { if (r.ok) load(); })
      .finally(() => setSaving(null));
  }

  function slugify(name: string) {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID().slice(0, 8);
  }

  function createProfile() {
    if (!newName.trim() || !newPath.trim()) return;
    const id = slugify(newName);
    saveProfile(id, newName.trim(), newPath.trim());
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
          {profiles.length > 0 && (
            <div className="space-y-2">
              {profiles.map(p => (
                <ProfileRow
                  key={p.id}
                  profile={p}
                  saving={saving === p.id}
                  onSave={(name, path) => saveProfile(p.id, name, path)}
                  onRemove={() => removeProfile(p.id)}
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
                {profiles.length === 0 ? "Add a profile" : "Add profile"}
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg px-4 py-3 bg-white/[0.04]">
              <div className="flex items-center gap-2">
                <Input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Profile name (e.g. TV Shows)"
                  className="w-48"
                />
                <FolderPicker value={newPath} onChange={setNewPath} />
                <Button size="sm" onClick={createProfile} disabled={saving !== null || !newName.trim() || !newPath.trim()}>
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

          {profiles.length === 0 && !adding && (
            <p className="text-muted-foreground py-2 text-center text-xs">
              No profiles yet. Create one above to start organizing your shows.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ProfileRow({ profile, saving, onSave, onRemove }: {
  profile: { id: string; name: string; root_folder_path: string };
  saving: boolean;
  onSave: (name: string, path: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(profile.name);
  const [path, setPath] = React.useState(profile.root_folder_path);

  React.useEffect(() => {
    setName(profile.name);
    setPath(profile.root_folder_path);
  }, [profile.name, profile.root_folder_path]);

  if (!editing) {
    return (
      <div className="flex items-center gap-3 rounded-lg px-4 py-3 bg-white/[0.03]">
        <div className="size-8 rounded-lg bg-signal/10 grid place-items-center shrink-0">
          <span className="text-signal font-mono text-[10px] font-bold uppercase leading-none">{profile.id.slice(0, 2)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-medium">{profile.name}</div>
          <div className="text-muted-foreground mt-0.5 font-mono text-xs truncate">{profile.root_folder_path}</div>
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-muted-foreground hover:text-foreground text-xs font-mono uppercase tracking-wider transition-colors"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={saving}
          className="text-muted-foreground hover:text-red-400 shrink-0 transition-colors"
        >
          <Trash2Icon className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg px-4 py-3 bg-white/[0.04]">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Profile name"
          className="w-32"
        />
        <FolderPicker value={path} onChange={setPath} />
        <Button size="sm" onClick={() => { onSave(name, path); setEditing(false); }} disabled={saving || !name.trim() || !path.trim()}>
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
