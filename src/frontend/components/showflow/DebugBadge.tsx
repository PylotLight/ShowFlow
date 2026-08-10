import { BugIcon } from "lucide-react";
import * as React from "react";

// Small red badge shown in the app header while Debug Mode is on. Polls the
// setting so toggling it in Settings > Debug is reflected without a reload,
// and clicking the badge jumps straight to the Debug settings tab.
export function DebugBadge({ onOpenDebug, className }: { onOpenDebug?: () => void; className?: string }) {
  const [enabled, setEnabled] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    const poll = () =>
      fetch("/api/settings")
        .then((r) => r.json())
        .then((settings: any[]) => {
          if (!mounted) return;
          const raw = (settings ?? []).find((s) => s.key === "debug_enabled");
          setEnabled(raw?.value === "true");
        })
        .catch(() => {});
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  if (!enabled) return null;

  return (
    <button
      type="button"
      onClick={onOpenDebug}
      title="Debug mode is on — click to configure"
      className={`inline-flex size-4 items-center justify-center ${className ?? ""}`}
      aria-label="Debug mode enabled"
    >
      <BugIcon className="size-3.5 text-red-400" />
    </button>
  );
}