import * as React from "react";

/** Transient status line in the top bar (auto-clears after 6s). */
export function useStatusFlash() {
  const [status, setStatus] = React.useState<{ ok: boolean; text: string } | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashStatus = React.useCallback((text: string, ok = true) => {
    setStatus({ ok, text });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus(null), 6000);
  }, []);

  React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { status, flashStatus };
}
