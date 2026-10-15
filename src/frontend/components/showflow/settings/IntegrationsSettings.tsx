import * as React from "react";

import { IntegrationsTab } from "../IntegrationsTab";
import { useSaveSetting, useSettings } from "./SettingsContext";

type SonarrTypeConfig = Record<string, { included: boolean; showProfileId: string; qualityProfileId: string; libraryTypeId: string }>;

export function IntegrationsSettings() {
  const { config, updateApiKey, getSetting } = useSettings();
  const saveSetting = useSaveSetting();

  // ---- Sonarr ----
  const [sonarr, setSonarr] = React.useState(() => {
    const s = getSetting("sonarr");
    return { enabled: !!s?.enabled, baseUrl: s?.baseUrl || "", apiKey: s?.apiKey || "", apiVersion: (s?.apiVersion === "v5" ? "v5" : "v3") as "v3" | "v5" };
  });
  const [showSonarrKey, setShowSonarrKey] = React.useState(false);
  const [sonarrTesting, setSonarrTesting] = React.useState(false);
  const [sonarrStatus, setSonarrStatus] = React.useState<{ ok: boolean; message?: string; version?: string } | null>(null);
  const [sonarrSeries, setSonarrSeries] = React.useState<any[] | null>(null);
  const [sonarrSeriesLoading, setSonarrSeriesLoading] = React.useState(false);
  const [sonarrImporting, setSonarrImporting] = React.useState(false);
  const [sonarrImportJobId, setSonarrImportJobId] = React.useState<string | null>(null);
  const [selectedSonarrSeries, setSelectedSonarrSeries] = React.useState<Set<number>>(new Set());
  const [sonarrTypeConfig, setSonarrTypeConfig] = React.useState<SonarrTypeConfig>({});

  // Lookup lists for the Sonarr import type mapping.
  const [showProfilesList, setShowProfilesList] = React.useState<any[]>([]);
  const [qualityProfilesList, setQualityProfilesList] = React.useState<any[]>([]);
  const [libraryTypesList, setLibraryTypesList] = React.useState<any[]>([]);

  // ---- Jellyfin ----
  const [jellyfin, setJellyfin] = React.useState(() => {
    const j = getSetting("jellyfin");
    return { enabled: !!j?.enabled, baseUrl: j?.baseUrl || "", apiKey: j?.apiKey || "" };
  });
  const [showJellyfinKey, setShowJellyfinKey] = React.useState(false);
  const [jellyfinTesting, setJellyfinTesting] = React.useState(false);
  const [jellyfinStatus, setJellyfinStatus] = React.useState<{ ok: boolean; message?: string; version?: string } | null>(null);
  const [jellyfinSyncing, setJellyfinSyncing] = React.useState(false);
  const [jellyfinSyncResult, setJellyfinSyncResult] = React.useState<{ totalEpisodes?: number; matchedEpisodes?: number; errors?: string[] } | null>(null);

  React.useEffect(() => {
    const list = (url: string) => fetch(url).then(r => r.json()).then(d => (Array.isArray(d) ? d : [])).catch(() => []);
    list("/api/show-profiles").then(setShowProfilesList);
    list("/api/profiles").then(setQualityProfilesList);
    list("/api/library-types").then(setLibraryTypesList);
  }, []);

  const visibleSonarrSeries = React.useMemo(() => {
    if (!sonarrSeries) return [];
    return sonarrSeries.filter((s: any) => sonarrTypeConfig[s.seriesType || "standard"]?.included !== false);
  }, [sonarrSeries, sonarrTypeConfig]);

  const sonarrTypesPresent = React.useMemo(() => {
    if (!sonarrSeries) return [];
    const counts: Record<string, number> = {};
    for (const s of sonarrSeries) {
      const t = s.seriesType || "standard";
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [sonarrSeries]);

  function saveSonarr() {
    saveSetting("sonarr", sonarr, { quiet: true });
  }

  function testSonarr() {
    setSonarrTesting(true);
    setSonarrStatus(null);
    fetch("/api/sonarr/test").then(r => r.json()).then(setSonarrStatus)
      .catch(() => setSonarrStatus({ ok: false, message: "Connection failed" }))
      .finally(() => setSonarrTesting(false));
  }

  function fetchSonarrSeries() {
    setSonarrSeriesLoading(true);
    setSonarrSeries(null);
    setSelectedSonarrSeries(new Set());
    fetch("/api/sonarr/series").then(r => r.json()).then(res => {
      setSonarrSeries(Array.isArray(res) ? res : []);
    }).catch(() => setSonarrSeries([]))
      .finally(() => setSonarrSeriesLoading(false));
  }

  function importSonarrSeries() {
    setSonarrImporting(true);
    setSonarrImportJobId(null);
    fetch("/api/sonarr/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesIds: [...selectedSonarrSeries], typeMapping: sonarrTypeConfig }),
    }).then(r => r.json()).then(data => {
      if (data.jobId) setSonarrImportJobId(data.jobId);
    }).catch(() => {})
      .finally(() => setSonarrImporting(false));
  }

  function testJellyfin() {
    setJellyfinTesting(true);
    setJellyfinStatus(null);
    fetch("/api/jellyfin/test").then(r => r.json()).then(setJellyfinStatus)
      .catch(() => setJellyfinStatus({ ok: false, message: "Connection failed" }))
      .finally(() => setJellyfinTesting(false));
  }

  function syncJellyfin() {
    setJellyfinSyncing(true);
    setJellyfinSyncResult(null);
    fetch("/api/jellyfin/sync", { method: "POST" }).then(r => r.json()).then(setJellyfinSyncResult)
      .catch(() => setJellyfinSyncResult({ totalEpisodes: 0, matchedEpisodes: 0, errors: ["Sync request failed"] }))
      .finally(() => setJellyfinSyncing(false));
  }

  return (
    <IntegrationsTab
      sonarr={sonarr}
      setSonarr={setSonarr}
      showSonarrKey={showSonarrKey}
      setShowSonarrKey={setShowSonarrKey}
      sonarrTesting={sonarrTesting}
      sonarrStatus={sonarrStatus}
      sonarrTestingFn={testSonarr}
      sonarrSeries={sonarrSeries}
      sonarrSeriesLoading={sonarrSeriesLoading}
      sonarrFetchSeries={fetchSonarrSeries}
      sonarrImporting={sonarrImporting}
      sonarrImportJobId={sonarrImportJobId}
      onSonarrImportDone={() => setSonarrImportJobId(null)}
      selectedSonarrSeries={selectedSonarrSeries}
      setSelectedSonarrSeries={setSelectedSonarrSeries}
      showProfilesList={showProfilesList}
      qualityProfilesList={qualityProfilesList}
      libraryTypesList={libraryTypesList}
      sonarrTypeConfig={sonarrTypeConfig}
      setSonarrTypeConfig={setSonarrTypeConfig}
      sonarrTypesPresent={sonarrTypesPresent}
      visibleSonarrSeries={visibleSonarrSeries}
      sonarrImportFn={importSonarrSeries}
      jellyfin={jellyfin}
      setJellyfin={setJellyfin}
      showJellyfinKey={showJellyfinKey}
      setShowJellyfinKey={setShowJellyfinKey}
      jellyfinTesting={jellyfinTesting}
      jellyfinStatus={jellyfinStatus}
      jellyfinTestingFn={testJellyfin}
      jellyfinSyncing={jellyfinSyncing}
      jellyfinSyncResult={jellyfinSyncResult}
      jellyfinSyncFn={syncJellyfin}
      saveSonarr={saveSonarr}
      config={config}
      updateApiKey={updateApiKey}
    />
  );
}
