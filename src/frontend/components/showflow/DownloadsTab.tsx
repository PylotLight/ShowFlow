import { EyeIcon, EyeOffIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { FieldRow } from "./SettingsShared";
import { FolderPicker } from "./FolderPicker";

export function DownloadsTab({ config, saveConfig, showTorboxKey, setShowTorboxKey }: {
  config: any;
  saveConfig: (updates: Record<string, any>) => void;
  showTorboxKey: boolean;
  setShowTorboxKey: (v: boolean) => void;
}) {
  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Import Folder</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Where completed downloads are picked up from</p>
        </div>
        <FieldRow label="Watch Folder" description="Directory where download clients place completed files">
          <FolderPicker
            value={config.importFolder || ""}
            onChange={v => saveConfig({ importFolder: v })}
          />
        </FieldRow>
        <FieldRow label="Season Folder Format" description="Template for season subdirectories">
          <Input
            value={config.seasonFolderFormat || "Season {season}"}
            onChange={e => saveConfig({ seasonFolderFormat: e.target.value })}
            placeholder="Season {season}"
          />
        </FieldRow>
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">TorBox</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Cloud-based torrent download via TorBox.app</p>
        </div>
        <FieldRow label="TorBox API Key" description="Your TorBox API key for direct downloads">
          <div className="relative">
            <Input
              type={showTorboxKey ? "text" : "password"}
              value={config.apiKeys?.torbox || ""}
              onChange={e => {
                const newKeys = { ...(config.apiKeys || {}), torbox: e.target.value || undefined };
                saveConfig({ apiKeys: Object.fromEntries(Object.entries(newKeys).filter(([_, v]) => v)) });
              }}
              placeholder="TorBox API key"
            />
            <button
              type="button"
              onClick={() => setShowTorboxKey(!showTorboxKey)}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
            >
              {showTorboxKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
          </div>
        </FieldRow>
        <FieldRow label="TorBox Download Directory" description="Where TorBox saves files locally (optional)">
          <FolderPicker
            value={config.torbox?.downloadDir || ""}
            onChange={v => saveConfig({ torbox: { ...(config.torbox || {}), downloadDir: v } })}
          />
        </FieldRow>
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">External Download Client</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Configure how releases are submitted to your download client</p>
        </div>
        <FieldRow label="Download Client" description="Which client to use for download submission">
          <Select
            value={config.downloadClient?.type || "blackhole"}
            onValueChange={v => saveConfig({ downloadClient: { ...(config.downloadClient || {}), type: v } })}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="blackhole">Blackhole (.torrent/.magnet)</SelectItem>
              <SelectItem value="torbox">TorBox API</SelectItem>
              <SelectItem value="sabnzbd">SABnzbd</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        {config.downloadClient?.type === "sabnzbd" && (
          <>
            <FieldRow label="SABnzbd URL" description="e.g. http://localhost:8080">
              <Input
                value={config.downloadClient?.url || ""}
                onChange={e => saveConfig({ downloadClient: { ...(config.downloadClient || {}), url: e.target.value } })}
                placeholder="http://localhost:8080"
              />
            </FieldRow>
            <FieldRow label="SABnzbd API Key" description="Found in SABnzbd Config > General">
              <Input
                type="password"
                value={config.downloadClient?.apiKey || ""}
                onChange={e => saveConfig({ downloadClient: { ...(config.downloadClient || {}), apiKey: e.target.value } })}
                placeholder="SABnzbd API key"
              />
            </FieldRow>
          </>
        )}
      </GlassPanel>
    </>
  );
}
