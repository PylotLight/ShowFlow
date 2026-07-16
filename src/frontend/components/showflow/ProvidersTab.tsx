import { EyeIcon, EyeOffIcon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { FieldRow } from "./SettingsShared";

export function ProvidersTab({ config, updateApiKey, showTmdbKey, setShowTmdbKey, showTvdbKey, setShowTvdbKey, showTvdbPin, setShowTvdbPin }: {
  config: any;
  updateApiKey: (provider: string, value: string) => void;
  showTmdbKey: boolean;
  setShowTmdbKey: (v: boolean) => void;
  showTvdbKey: boolean;
  setShowTvdbKey: (v: boolean) => void;
  showTvdbPin: boolean;
  setShowTvdbPin: (v: boolean) => void;
}) {
  return (
    <GlassPanel className="p-6 space-y-5">
      <div>
        <h3 className="font-display text-base font-semibold tracking-wide text-white/90">API Keys</h3>
        <p className="text-muted-foreground text-xs mt-0.5">Credentials for metadata providers. These replace values in your .env file.</p>
      </div>
      <FieldRow label="TMDB API Key" description="themoviedb.org API key for show metadata">
        <div className="relative">
          <Input
            type={showTmdbKey ? "text" : "password"}
            value={config.apiKeys?.tmdb || ""}
            onChange={e => updateApiKey("tmdb", e.target.value)}
            placeholder="TMDB_API_KEY"
          />
          <button
            type="button"
            onClick={() => setShowTmdbKey(!showTmdbKey)}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            {showTmdbKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
      </FieldRow>
      <FieldRow label="TVDB API Key" description="thetvdb.com API key for show metadata">
        <div className="relative">
          <Input
            type={showTvdbKey ? "text" : "password"}
            value={config.apiKeys?.tvdb || ""}
            onChange={e => updateApiKey("tvdb", e.target.value)}
            placeholder="TVDB_API_KEY"
          />
          <button
            type="button"
            onClick={() => setShowTvdbKey(!showTvdbKey)}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            {showTvdbKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
      </FieldRow>
      <FieldRow label="TVDB PIN" description="PIN for TVDB v4 API authentication (optional)">
        <div className="relative">
          <Input
            type={showTvdbPin ? "text" : "password"}
            value={config.apiKeys?.tvdb_pin || ""}
            onChange={e => updateApiKey("tvdb_pin", e.target.value)}
            placeholder="TVDB_PIN"
          />
          <button
            type="button"
            onClick={() => setShowTvdbPin(!showTvdbPin)}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            {showTvdbPin ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
      </FieldRow>
    </GlassPanel>
  );
}
