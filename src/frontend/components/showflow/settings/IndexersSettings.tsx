import * as React from "react";

import { IndexersTab } from "../IndexersTab";
import { useSaveSetting, useSettings } from "./SettingsContext";

export function IndexersSettings() {
  const { getSetting, saving, setSaving } = useSettings();
  const saveSetting = useSaveSetting();

  const [prowlarr, setProwlarr] = React.useState(() => {
    const p = getSetting("prowlarr");
    return p
      ? { enabled: p.enabled !== false, baseUrl: p.baseUrl || "", apiKey: p.apiKey || "", syncLevel: p.syncLevel || "full", tags: (p.tags || []) as number[] }
      : { enabled: true, baseUrl: "", apiKey: "", syncLevel: "full", tags: [] as number[] };
  });
  const [showProwlarrKey, setShowProwlarrKey] = React.useState(false);
  const [prowlarrTesting, setProwlarrTesting] = React.useState(false);
  const [prowlarrStatus, setProwlarrStatus] = React.useState<{ ok: boolean; message?: string } | null>(null);
  const [indexers, setIndexers] = React.useState<any[] | null>(null);
  const [indexersLoading, setIndexersLoading] = React.useState(false);

  const [nativeIndexers, setNativeIndexers] = React.useState<any[]>(() => {
    const n = getSetting("nativeIndexers");
    return Array.isArray(n) ? n : [];
  });
  const [nativeMeta, setNativeMeta] = React.useState<any[]>([]);
  const [nativeSaving, setNativeSaving] = React.useState(false);
  const [nativeTesting, setNativeTesting] = React.useState<Record<string, boolean>>({});
  const [nativeStatuses, setNativeStatuses] = React.useState<Record<string, { ok: boolean; message?: string }>>({});

  React.useEffect(() => {
    fetch("/api/indexers/native/meta").then(r => r.json())
      .then(data => setNativeMeta(Array.isArray(data) ? data : []))
      .catch(() => setNativeMeta([]));
  }, []);

  function saveProwlarr() {
    setSaving("prowlarr");
    saveSetting("prowlarr", prowlarr).finally(() => setSaving(null));
  }

  function saveProwlarrWithDefaults(overrides: any) {
    saveSetting("prowlarr", overrides, { quiet: true });
  }

  function testProwlarr() {
    setProwlarrTesting(true);
    setProwlarrStatus(null);
    fetch("/api/indexers/prowlarr/status").then(r => r.json()).then(setProwlarrStatus)
      .catch(() => setProwlarrStatus({ ok: false, message: "Connection failed" }))
      .finally(() => setProwlarrTesting(false));
  }

  function loadIndexers() {
    setIndexersLoading(true);
    setIndexers(null);
    fetch("/api/indexers/prowlarr/indexers").then(r => r.json()).then(res => {
      setIndexers(Array.isArray(res) ? res : []);
    }).catch(() => setIndexers([]))
      .finally(() => setIndexersLoading(false));
  }

  function saveNativeIndexers(configs: any[]) {
    setNativeSaving(true);
    setNativeIndexers(configs);
    saveSetting("nativeIndexers", configs).finally(() => setNativeSaving(false));
  }

  function toggleNativeIndexer(id: string, enabled: boolean) {
    const next = nativeIndexers.map((n: any) => n.id === id ? { ...n, enabled } : n);
    if (!next.find((n: any) => n.id === id)) next.push({ id, enabled, baseUrl: undefined });
    saveNativeIndexers(next);
  }

  function updateNativeBaseUrl(id: string, baseUrl: string) {
    const next = nativeIndexers.map((n: any) => n.id === id ? { ...n, baseUrl: baseUrl || undefined } : n);
    if (!next.find((n: any) => n.id === id)) next.push({ id, enabled: false, baseUrl: baseUrl || undefined });
    saveNativeIndexers(next);
  }

  function testNativeIndexer(id: string) {
    setNativeTesting(prev => ({ ...prev, [id]: true }));
    setNativeStatuses(prev => ({ ...prev, [id]: undefined as any }));
    fetch(`/api/indexers/native/test/${id}`).then(r => r.json()).then(res => {
      setNativeStatuses(prev => ({ ...prev, [id]: res }));
    }).catch(() => setNativeStatuses(prev => ({ ...prev, [id]: { ok: false, message: "Connection failed" } })))
      .finally(() => setNativeTesting(prev => ({ ...prev, [id]: false })));
  }


  return (
    <IndexersTab
      prowlarr={prowlarr}
      setProwlarr={setProwlarr}
      saveProwlarr={saveProwlarr}
      saveProwlarrWithDefaults={saveProwlarrWithDefaults}
      testProwlarr={testProwlarr}
      prowlarrTesting={prowlarrTesting}
      prowlarrStatus={prowlarrStatus}
      loadIndexers={loadIndexers}
      indexers={indexers}
      indexersLoading={indexersLoading}
      showProwlarrKey={showProwlarrKey}
      setShowProwlarrKey={setShowProwlarrKey}
      nativeIndexers={nativeIndexers}
      nativeMeta={nativeMeta}
      nativeSaving={nativeSaving}
      nativeTesting={nativeTesting}
      nativeStatuses={nativeStatuses}
      toggleNativeIndexer={toggleNativeIndexer}
      updateNativeBaseUrl={updateNativeBaseUrl}
      testNativeIndexer={testNativeIndexer}
      saving={saving}
    />
  );
}
