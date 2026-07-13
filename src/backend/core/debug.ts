export type DebugLogLevel = 'info' | 'warn' | 'error' | 'debug';

export type DebugLogType = 'api' | 'system' | 'provider' | 'scheduler' | 'grabber' | 'database' | 'sync' | 'websocket' | 'config' | 'user';

export interface DebugLogEntry {
  id: string;
  timestamp: string;
  type: DebugLogType;
  level: DebugLogLevel;
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
  message?: string;
  source?: string;
  url?: string;
  headers?: Record<string, string>;
}

export type DebugLogListener = (entry: DebugLogEntry) => void;

const MAX_LOG_ENTRIES = 2000;
const ring: DebugLogEntry[] = [];
let nextId = 0;
const listeners = new Set<DebugLogListener>();

function generateId(): string {
  return `dbg_${(++nextId).toString(36)}_${Date.now().toString(36)}`;
}

export function isDebugEnabled(): boolean {
  try {
    const { db } = require('../db');
    const val = db.getSetting('debug_enabled');
    return val === 'true' || val === true;
  } catch {
    return false;
  }
}

export function logDebug(entry: Omit<DebugLogEntry, 'id' | 'timestamp'>): void {
  if (!isDebugEnabled()) return;

  const full: DebugLogEntry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  ring.push(full);
  if (ring.length > MAX_LOG_ENTRIES) {
    ring.shift();
  }

  for (const listener of listeners) {
    try {
      listener(full);
    } catch {}
  }
}

export function subscribeDebugLogs(listener: DebugLogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDebugLogs(filters?: {
  type?: DebugLogType;
  level?: DebugLogLevel;
  method?: string;
  path?: string;
  source?: string;
  search?: string;
  since?: string;
  limit?: number;
}): DebugLogEntry[] {
  let results = ring;

  if (filters) {
    if (filters.type) results = results.filter(e => e.type === filters.type);
    if (filters.level) results = results.filter(e => e.level === filters.level);
    if (filters.method) results = results.filter(e => e.method?.toUpperCase() === filters.method?.toUpperCase());
    if (filters.path) results = results.filter(e => e.path?.includes(filters.path!));
    if (filters.source) results = results.filter(e => e.source === filters.source);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      results = results.filter(e =>
        e.message?.toLowerCase().includes(q) ||
        e.path?.toLowerCase().includes(q) ||
        e.source?.toLowerCase().includes(q) ||
        e.error?.toLowerCase().includes(q)
      );
    }
    if (filters.since) {
      const since = new Date(filters.since).getTime();
      results = results.filter(e => new Date(e.timestamp).getTime() >= since);
    }
  }

  results = [...results].reverse();

  if (filters?.limit && filters.limit > 0) {
    results = results.slice(0, filters.limit);
  }

  return results;
}

export function clearDebugLogs(): void {
  ring.length = 0;
}

export const DEBUG = process.env.SHOWFLOW_DEBUG === 'true';

export function debugLog(message: string, ...args: any[]) {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    console.log(`[DEBUG ${timestamp}] ${message}`, ...args);
  }
}

export function createApiDebugLog(
  method: string,
  path: string,
  status: number,
  duration: number,
  requestBody?: unknown,
  responseBody?: unknown,
  error?: string,
  url?: string,
  headers?: Record<string, string>,
): void {
  logDebug({
    type: 'api',
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    method,
    path,
    status,
    duration,
    requestBody,
    responseBody,
    error,
    source: 'api',
    message: `${method} ${path} → ${status} (${duration}ms)`,
    url,
    headers,
  });
}
