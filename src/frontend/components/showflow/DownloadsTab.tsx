import { EyeIcon, EyeOffIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { FieldRow } from "./SettingsShared";
import { FolderPicker } from "./FolderPicker";

export function DownloadsTab({ config, saveConfig, showTorboxKey, setShowTorboxKey }: {
  config: any;
  saveConfig: (updates: Record<string, any>) => void;
  showTorboxKey: boolean;
  setShowTorboxKey: (v: boolean) => void;
}) {
  const clientType = config.downloadClient?.type || "blackhole";

  return (
    <GlassPanel className="p-6 space-y-5">
      <div>
        <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Downloads</h3>
        <p className="text-muted-foreground text-xs mt-0.5">Configure download client and completed download handling</p>
      </div>

      <FieldRow label="Download Client" description="How releases are submitted for downloading">
        <Select
          value={clientType}
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

      {clientType === "blackhole" && (
        <p className="text-xs text-muted-foreground -mt-3">
          Blackhole writes .torrent and .magnet files to disk for your torrent client to pick up.
        </p>
      )}

      {clientType === "torbox" && (
        <>
          <FieldRow label="TorBox API Key" description="Your TorBox API key for direct downloads">
            <div className="relative">
              <Input
                type={showTorboxKey ? "text" : "password"}
                value={config.downloadClient?.torbox?.apiKey || config.apiKeys?.torbox || ""}
                onChange={e => {
                  const dc = { ...(config.downloadClient || {}), torbox: { ...(config.downloadClient?.torbox || {}), apiKey: e.target.value || undefined } };
                  saveConfig({ downloadClient: dc });
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
          <FieldRow label="Download Directory" description="Where TorBox saves files locally (optional)">
            <FolderPicker
              value={config.downloadClient?.torbox?.outputFolder || ""}
              onChange={v => {
                const dc = { ...(config.downloadClient || {}), torbox: { ...(config.downloadClient?.torbox || {}), outputFolder: v || undefined } };
                saveConfig({ downloadClient: dc });
              }}
            />
          </FieldRow>
        </>
      )}

      {clientType === "sabnzbd" && (
        <>
          <FieldRow label="SABnzbd URL" description="e.g. http://localhost:8080">
            <Input
              value={config.downloadClient?.sabnzbd?.url || ""}
              onChange={e => saveConfig({ downloadClient: { ...(config.downloadClient || {}), sabnzbd: { ...(config.downloadClient?.sabnzbd || {}), url: e.target.value } } })}
              placeholder="http://localhost:8080"
            />
          </FieldRow>
          <FieldRow label="SABnzbd API Key" description="Found in SABnzbd Config > General">
            <Input
              type="password"
              value={config.downloadClient?.sabnzbd?.apiKey || ""}
              onChange={e => saveConfig({ downloadClient: { ...(config.downloadClient || {}), sabnzbd: { ...(config.downloadClient?.sabnzbd || {}), apiKey: e.target.value } } })}
              placeholder="SABnzbd API key"
            />
          </FieldRow>
        </>
      )}

      <div className="border-t border-white/5 pt-5 space-y-5">
        <div>
          <h4 className="font-mono text-sm font-semibold text-white/90">Completed Downloads</h4>
          <p className="text-muted-foreground text-xs mt-0.5">Where finished downloads are picked up and organized</p>
        </div>
        <FieldRow label="Watch Folder" description="Directory where download clients place completed files">
          <FolderPicker
            value={config.downloadClient?.blackhole?.watchFolder || ""}
            onChange={v => saveConfig({
              downloadClient: {
                ...(config.downloadClient || {}),
                blackhole: {
                  ...(config.downloadClient?.blackhole || {}),
                  watchFolder: v || undefined,
                },
              },
            })}
          />
        </FieldRow>
      </div>
    </GlassPanel>
  );
}
