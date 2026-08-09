import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Input } from "@frontend/components/ui/input";
import { FieldRow } from "./SettingsShared";

export function ProvidersTab({ config, updateApiKey, showTmdbKey, setShowTmdbKey, showTvdbKey, setShowTvdbKey, showTvdbPin, setShowTvdbPin, saveImdb }: {
  config: any;
  updateApiKey: (provider: string, value: string) => void;
  showTmdbKey: boolean;
  setShowTmdbKey: (v: boolean) => void;
  showTvdbKey: boolean;
  setShowTvdbKey: (v: boolean) => void;
  showTvdbPin: boolean;
  setShowTvdbPin: (v: boolean) => void;
  saveImdb: (imdb: any) => void;
}) {
  const [showImdbKey, setShowImdbKey] = React.useState(false);
  const [showAwsSecret, setShowAwsSecret] = React.useState(false);
  const [draft, setDraft] = React.useState<any>(null);
  const imdb = draft ?? config.imdb ?? {};

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

      <div>
        <h4 className="font-display text-sm font-semibold tracking-wide text-white/90">IMDb API (AWS Data Exchange)</h4>
        <p className="text-muted-foreground text-xs mt-0.5">
          Optional. Signed GraphQL ratings lookup by IMDb ID. Requires an AWS Data Exchange subscription, its
          dataset/revision/asset IDs, the IMDb API key, and AWS credentials.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="checkbox"
          className="size-4"
          checked={!!imdb.enabled}
          onChange={e => setDraft({ ...imdb, enabled: e.target.checked })}
        />
        <span className="text-sm">Enable IMDb ratings lookup</span>
      </div>

      <FieldRow label="IMDb API Key" description="API key from your IMDb API subscription email">
        <div className="relative">
          <Input
            type={showImdbKey ? "text" : "password"}
            value={imdb.apiKey || ""}
            onChange={e => setDraft({ ...imdb, apiKey: e.target.value })}
            placeholder="IMDB_API_KEY"
          />
          <button
            type="button"
            onClick={() => setShowImdbKey(!showImdbKey)}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            {showImdbKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
      </FieldRow>

      <FieldRow label="AWS Access Key ID" description="Long-term AWS credential for Data Exchange access">
        <Input
          type="text"
          value={imdb.awsAccessKeyId || ""}
          onChange={e => setDraft({ ...imdb, awsAccessKeyId: e.target.value })}
          placeholder="AKIA..."
        />
      </FieldRow>

      <FieldRow label="AWS Secret Access Key" description="Long-term AWS secret for Data Exchange access">
        <div className="relative">
          <Input
            type={showAwsSecret ? "text" : "password"}
            value={imdb.awsSecretAccessKey || ""}
            onChange={e => setDraft({ ...imdb, awsSecretAccessKey: e.target.value })}
            placeholder="••••••••••••••••••••••••••••••••"
          />
          <button
            type="button"
            onClick={() => setShowAwsSecret(!showAwsSecret)}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            {showAwsSecret ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
      </FieldRow>

      <FieldRow label="AWS Region" description="Region of the Data Exchange asset (usually us-east-1)">
        <Input
          type="text"
          value={imdb.region || "us-east-1"}
          onChange={e => setDraft({ ...imdb, region: e.target.value })}
          placeholder="us-east-1"
        />
      </FieldRow>

      <FieldRow label="Dataset / Revision / Asset IDs" description="From your Data Exchange subscription (data-set-id, revision-id, asset-id)">
        <div className="flex gap-2">
          <Input
            type="text"
            value={imdb.dataSetId || ""}
            onChange={e => setDraft({ ...imdb, dataSetId: e.target.value })}
            placeholder="data-set-id"
          />
          <Input
            type="text"
            value={imdb.revisionId || ""}
            onChange={e => setDraft({ ...imdb, revisionId: e.target.value })}
            placeholder="revision-id"
          />
          <Input
            type="text"
            value={imdb.assetId || ""}
            onChange={e => setDraft({ ...imdb, assetId: e.target.value })}
            placeholder="asset-id"
          />
        </div>
      </FieldRow>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => { saveImdb(imdb); setDraft(null); }}
          className="bg-signal text-white text-sm font-medium px-4 py-1.5 rounded-md hover:opacity-90"
        >
          Save IMDb API
        </button>
      </div>
    </GlassPanel>
  );
}