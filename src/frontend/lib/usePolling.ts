import * as React from "react";

/**
 * Run `fn` now and then every `intervalMs`, but only while the tab is
 * visible: hidden tabs stop polling entirely, and coming back to the tab
 * fires one immediate refresh before the interval resumes. `fn` is read
 * through a ref, so passing an inline closure doesn't restart the timer.
 */
export function usePolling(fn: () => void, intervalMs: number, enabled = true) {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;

  React.useEffect(() => {
    if (!enabled) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => fnRef.current();
    const start = () => {
      if (id !== null) return;
      tick();
      id = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}

/**
 * Wrap a useState setter so a poll that returns the same data keeps the
 * previous reference — no re-render (and no downstream useMemo/effect churn)
 * when nothing changed. Structural compare via JSON, which is fine for the
 * plain API payloads this is meant for.
 */
export function setIfChanged<T>(set: React.Dispatch<React.SetStateAction<T>>) {
  return (next: T) =>
    set((prev) => (prev === next || JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
}
