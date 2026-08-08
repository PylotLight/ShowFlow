import { readFileSync } from 'node:fs';

const HIGH_WATER_FRACTION = 0.5;
const LOW_WATER_FRACTION = 0.35;
let lastForcedGcMs = 0;
let lastLoggedGcMs = 0;
let armed = true;
const MIN_GC_INTERVAL_MS = 2000;
const MIN_LOG_INTERVAL_MS = 30 * 1000;

export interface CgroupMemory {
  currentBytes: number;
  maxBytes: number;
}

/** Reads cgroup v2 (fallback v1) memory usage. Returns null when unavailable. */
export function readCgroupMemory(): CgroupMemory | null {
  try {
    const currentBytes = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const maxBytes = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
    if (!Number.isFinite(currentBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      return null;
    }
    return { currentBytes, maxBytes };
  } catch {
    try {
      const currentBytes = Number(readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'));
      const maxBytes = Number(readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'));
      if (!Number.isFinite(currentBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) {
        return null;
      }
      return { currentBytes, maxBytes };
    } catch {
      return null;
    }
  }
}

/**
 * Forces a full JSC GC when cgroup memory usage crosses a high-water mark.
 *
 * Background: JSC (Bun's engine) only runs a major GC when the heap approaches
 * its *engine-configured* ceiling (e.g. ~2.4GB). When the pod's cgroup limit
 * (e.g. 4Gi) is larger than that engine ceiling, the process can approach the
 * cgroup cap with gigabytes of reclaimable garbage still resident, and the
 * container OOM-kills the process before JSC bothers to collect. Idle drops to
 * ~100MB only because a GC eventually fires.
 *
 * Proactively forcing a GC near the high-water mark keeps the working set well
 * under the cgroup limit. Returns true if a GC was triggered.
 */
export function maybeForcedGc(now = Date.now()): boolean {
  const mem = readCgroupMemory();
  if (!mem) return false;

  const fraction = mem.currentBytes / mem.maxBytes;

  // Hysteresis: once we force a GC, re-arm only after usage drops below a
  // lower water mark. This prevents an endless "collect every ~2s" storm when
  // usage hovers near the limit.
  if (!armed) {
    if (fraction < LOW_WATER_FRACTION) armed = true;
    return false;
  }

  if (lastForcedGcMs !== 0 && now - lastForcedGcMs < MIN_GC_INTERVAL_MS) {
    return false;
  }

  if (fraction < HIGH_WATER_FRACTION) {
    return false;
  }

  lastForcedGcMs = now;
  armed = false;
  try {
    (globalThis as any).gc?.(true);
  } catch {}
  try {
    (Bun as any).gc?.(true);
  } catch {}
  if (now - lastLoggedGcMs >= MIN_LOG_INTERVAL_MS) {
    lastLoggedGcMs = now;
    const pct = Math.round(fraction * 100);
    console.log(`[memory-guard] Forced GC at ${pct}% of cgroup limit (${(mem.currentBytes / 1048576).toFixed(0)}/${(mem.maxBytes / 1048576).toFixed(0)}MB)`);
  }
  return true;
}

export function resetGcGuard(): void {
  lastForcedGcMs = 0;
  armed = true;
}