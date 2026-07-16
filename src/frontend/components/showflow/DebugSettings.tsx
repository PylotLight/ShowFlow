import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Switch } from "@frontend/components/ui/switch";
import { FieldRow } from "./SettingsShared";
import { DebugPage } from "@frontend/components/showflow/DebugPage";

export function DebugSettings() {
  const [debugEnabled, setDebugEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(settings => {
        const raw = settings.find((s: any) => s.key === "debug_enabled");
        setDebugEnabled(raw?.value === "true");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function toggleDebug(v: boolean) {
    setDebugEnabled(v);
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "debug_enabled", value: v }),
    }).catch(() => setDebugEnabled(!v));
  }

  if (loading) {
    return (
      <GlassPanel className="p-6 flex items-center justify-center py-12">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </GlassPanel>
    );
  }

  return (
    <div className="space-y-5">
      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Debug Mode</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Capture API calls, system events, and provider activity for live inspection</p>
        </div>

        <FieldRow label="Debug Enabled" description="When on, all API calls and system events are logged to the live console below">
          <Switch
            checked={debugEnabled}
            onCheckedChange={toggleDebug}
          />
        </FieldRow>
      </GlassPanel>

      {debugEnabled && (
        <div className="rounded-lg border border-white/5 overflow-hidden h-[600px]">
          <DebugPage onDone={() => {}} />
        </div>
      )}
    </div>
  );
}
