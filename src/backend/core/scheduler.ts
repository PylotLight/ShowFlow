import { db, type Config, JellyfinConfigSchema } from '../db';
import { SyncManager } from './sync_manager';
import { LibraryScanner } from './library_scanner';
import { debugLog } from './debug';
import { maybeForcedGc } from './memory_guard';
import { runBackup } from "./backup";
import { GrabberService } from './grabber_service';
import { JellyfinSync } from '../providers/jellyfin/sync';
import { pollSystemHealth } from './pipeline/health_poller';

export type TaskName = 
  | 'sync-shows' 
  | 'scan-library' 
  | 'backup' 
  | 'rss-scan'
  | 'housekeeping'
  | 'pipeline-cleanup'
  | 'quarantine-cleanup'
  | 'health-check'
  | 'update-check'
  | 'watcher-monitor'
  | 'jellyfin-sync'
  | 'episode-mapping-refresh';

export interface TaskDefinition {
  name: TaskName;
  displayName: string;
  description: string;
  category: 'sync' | 'maintenance' | 'downloading' | 'system';
  intervalMinutes: number;
  defaultEnabled: boolean;
  action: (config: Config) => Promise<void>;
}

const TASKS: Record<TaskName, TaskDefinition> = {
  'sync-shows': {
    name: 'sync-shows',
    displayName: 'Sync Shows',
    description: 'Sync show metadata and episode information from providers',
    category: 'sync',
    intervalMinutes: 1440, // Daily
    defaultEnabled: true,
    action: async (config) => {
      const sync = new SyncManager(config);
      const result = await sync.syncAllShows(false); // Use intelligent sync for scheduled tasks
      debugLog(`Task sync-shows complete: ${result.syncedCount} synced, ${result.errorCount} errors.`);
    },
  },
  'scan-library': {
    name: 'scan-library',
    displayName: 'Scan Library',
    description: 'Scan media folders for new and updated files',
    category: 'maintenance',
    intervalMinutes: 60, // Hourly
    defaultEnabled: true,
    action: async (config) => {
      const scanner = new LibraryScanner(config);
      await scanner.scan();
    },
  },
  'backup': {
    name: 'backup',
    displayName: 'Database Backup',
    description: 'Create backup of the ShowFlow database',
    category: 'maintenance',
    intervalMinutes: 1440, // Daily
    defaultEnabled: true,
    action: async () => {
      const result = await runBackup();
      debugLog(`Task backup complete: ${(result.dbSize / 1024 / 1024).toFixed(1)} MB DB, ${(result.sqlSize / 1024).toFixed(1)} KB seed`);
    },
  },
  'rss-scan': {
    name: 'rss-scan',
    displayName: 'RSS Feed Scan',
    description: 'Scan RSS feeds from configured indexers for new releases',
    category: 'downloading',
    intervalMinutes: 30, // Every 30 minutes
    defaultEnabled: false,
    action: async (config) => {
      // No long-lived DownloadManager in this context — the grabber will
      // spin up an ephemeral TorBox client if a grab is needed.
      const grabber = new GrabberService(config);
      // RSS scanning logic would go here
      debugLog('Task rss-scan complete: RSS feeds scanned');
    },
  },
  'housekeeping': {
    name: 'housekeeping',
    displayName: 'Housekeeping',
    description: 'Clean up old logs, cache entries, and temporary files',
    category: 'maintenance',
    intervalMinutes: 10080, // Weekly
    defaultEnabled: true,
    action: async () => {
      // Clean up old debug logs
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      db.cleanupOldLogs(weekAgo);
      
      // Clean up expired cache entries
      db.cleanupExpiredCache();
      
      debugLog('Task housekeeping complete: Old logs and cache cleaned');
    },
  },
  'update-check': {
    name: 'update-check',
    displayName: 'Update Check',
    description: 'Check for ShowFlow updates',
    category: 'system',
    intervalMinutes: 10080, // Weekly
    defaultEnabled: true,
    action: async () => {
      debugLog('Task update-check complete: Update check performed');
    },
  },
  'pipeline-cleanup': {
    name: 'pipeline-cleanup',
    displayName: 'Pipeline Event Cleanup',
    description: 'Purge old pipeline event log entries (search/grab/rejection history) - this table is the highest-volume in the DB, so it gets its own daily cadence rather than waiting on weekly housekeeping',
    category: 'maintenance',
    intervalMinutes: 1440, // Daily
    defaultEnabled: true,
    action: async () => {
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const result = db.cleanupOldPipelineEvents(cutoff);
      // Superseded episode_files rows (upgrade history beyond the latest)
      // accumulate one per episode per non-idempotent scan — prune daily so
      // the table can't bloat to millions of dead rows again (#28).
      const pruned = db.pruneSupersededEpisodeFiles();
      // Scan-type audit rows are per-file noise ("Mapped file X"); steady
      // state writes ~zero of them since scans went idempotent, but sweep
      // anything older than 7d so a future storm self-drains (#29).
      const scanCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const purgedScans = db.purgeOldScanLogs(scanCutoff);
      debugLog(`Task pipeline-cleanup complete: removed ${result.changes} pipeline event(s) older than 14 days, pruned ${pruned} superseded episode file row(s), purged ${purgedScans} scan log row(s)`);
    },
  },
  'quarantine-cleanup': {
    name: 'quarantine-cleanup',
    displayName: 'Quarantine Cleanup',
    description: 'Permanently delete junk files quarantined from library roots more than 1 day ago (downloads/.quarantine) - quarantined video is never auto-deleted',
    category: 'maintenance',
    intervalMinutes: 1440, // Daily
    defaultEnabled: true,
    action: async (config) => {
      const { resolveQuarantineDir, cleanupQuarantine } = await import('./junk_quarantine');
      const dir = resolveQuarantineDir(config);
      if (!dir) {
        debugLog('Task quarantine-cleanup skipped: no downloads folder configured');
        return;
      }
      const result = await cleanupQuarantine(dir);
      debugLog(`Task quarantine-cleanup complete: deleted ${result.deleted}, kept ${result.kept} (fresh), skipped ${result.skippedVideo} video file(s)`);
    },
  },
  'health-check': {
    name: 'health-check',
    displayName: 'System Health Check',
    description: 'Poll every configured indexer, download client, and import path and record current status - powers the unified health dashboard\'s "is everything fine" signal',
    category: 'system',
    intervalMinutes: 5, // Frequent - staleness matters more here than for most other tasks
    defaultEnabled: true,
    action: async (config) => {
      await pollSystemHealth(config);
      const snapshot = db.getHealthSnapshot();
      // Name the failing components, not just "down" — a bare "overall
      // down" line sends everyone hunting through the dashboard (#29).
      const bad: string[] = [];
      (Object.keys(snapshot.byType) as (keyof typeof snapshot.byType)[]).forEach((type) => {
        for (const row of snapshot.byType[type]) {
          if (row.status !== 'healthy') bad.push(`${type}:${row.component_id}(${row.status})`);
        }
      });
      const suffix = bad.length > 0 ? ` — failing: ${bad.join(', ')}` : '';
      debugLog(`Task health-check complete: overall ${snapshot.overallStatus}${suffix}`);
    },
  },
  'watcher-monitor': {
    name: 'watcher-monitor',
    displayName: 'Watcher Monitor',
    description: 'Monitor download watcher health and restart if needed',
    category: 'downloading',
    intervalMinutes: 15, // Every 15 minutes
    defaultEnabled: false,
    action: async (config) => {
      debugLog('Task watcher-monitor complete: Watcher health checked');
    },
  },
  'jellyfin-sync': {
    name: 'jellyfin-sync',
    displayName: 'Jellyfin Sync',
    description: 'Sync watched state from Jellyfin to ShowFlow',
    category: 'sync',
    intervalMinutes: 1440, // Daily
    defaultEnabled: false,
    action: async () => {
      const raw = db.getSetting('jellyfin');
      if (!raw) {
        debugLog('Task jellyfin-sync skipped: Jellyfin not configured');
        return;
      }
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const config = JellyfinConfigSchema.parse(parsed);
        if (!config.enabled || !config.baseUrl || !config.apiKey) {
          debugLog('Task jellyfin-sync skipped: Jellyfin not fully configured');
          return;
        }
        const syncer = new JellyfinSync(config.baseUrl, config.apiKey);
        const result = await syncer.sync();
        debugLog(`Task jellyfin-sync complete: ${result.totalEpisodes} total, ${result.matchedEpisodes} matched, ${result.errors.length} errors`);
      } catch (err) {
        debugLog(`Task jellyfin-sync error: ${err}`);
      }
    },
  },
  'episode-mapping-refresh': {
    name: 'episode-mapping-refresh',
    displayName: 'Episode Mapping Refresh',
    description: 'Refresh TheXem episode mappings (anime season-splits) for shows with the mapping enabled - clears stale scene-to-provider translations while preserving user-locked rows',
    category: 'sync',
    intervalMinutes: 10080, // Weekly, aligned with TheXem's 7-day cache TTL (issues-tracking.md #4 Q1)
    defaultEnabled: true,
    action: async () => {
      const { syncMappingsForAnimeShows } = await import('./episode_mappings');
      const result = await syncMappingsForAnimeShows();
      debugLog(`Task episode-mapping-refresh complete: ${result.synced} synced, ${result.failed} failed`);
    },
  },
};

export class Scheduler {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private gcHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * Overlap guard (issues-tracking #28): a task whose action outlives its
   * interval must not pile up. Previously a 9.8-hour scan-library run was
   * re-fired on every 60s tick (next_execution only advances on completion),
   * stacking ~92 concurrent full scans that contended on synchronous SQLite
   * writes until the event loop starved and readiness probes failed (502s).
   * A due task that is already running is skipped; its next_execution still
   * advances when the in-flight run settles.
   */
  private running = new Set<TaskName>();

  constructor(private config: Config) {}

  /**
   * Get all available task definitions
   */
  getTaskDefinitions(): TaskDefinition[] {
    return Object.values(TASKS);
  }

  /**
   * Get a specific task definition by name
   */
  getTaskDefinition(name: TaskName): TaskDefinition | undefined {
    return TASKS[name];
  }

  /**
   * Initialize tasks in database if they don't exist
   */
  initializeTasks() {
    const tasks = db.listTasks();
    
    for (const taskDef of Object.values(TASKS)) {
      const exists = tasks.find(t => t.name === taskDef.name);
      if (!exists) {
        db.saveTask({
          name: taskDef.name,
          intervalMinutes: taskDef.intervalMinutes,
          enabled: taskDef.defaultEnabled,
        });
      }
    }
  }

  /**
   * Run all pending tasks that are due for execution
   */
  async runPendingTasks() {
    this.initializeTasks();
    
    const dbTasks = db.listTasks();
    const now = new Date();

    for (const task of dbTasks) {
      if (!task.enabled) continue;

      const nextExecution = task.next_execution ? new Date(task.next_execution) : new Date(0);
      if (now >= nextExecution) {
        const taskDef = TASKS[task.name as TaskName];
        if (!taskDef) continue;

        if (this.running.has(task.name as TaskName)) {
          debugLog(`Scheduler skipping task ${task.name}: previous run still in flight`);
          continue;
        }
        this.running.add(task.name as TaskName);

        const startTime = Date.now();
        try {
          await taskDef.action(this.config);
          const duration = Date.now() - startTime;
          
          // Calculate next execution
          const nextDate = new Date(Date.now() + (task.interval_minutes ?? 1440) * 60 * 1000);
          db.updateTaskExecution(task.name, duration, nextDate.toISOString());

          db.logEvent({
            type: 'scheduler',
            entityType: 'task',
            entityId: task.name,
            message: `Task ${task.name} completed successfully in ${duration}ms`,
          });
        } catch (err) {
          debugLog(`Scheduler error running task ${task.name}: ${err}`);
          // Still move next execution forward to avoid tight-looping on error
          const nextDate = new Date(Date.now() + (task.interval_minutes ?? 1440) * 60 * 1000);
          db.updateTaskExecution(task.name, 0, nextDate.toISOString());
          
          db.logEvent({
            type: 'scheduler',
            entityType: 'task',
            entityId: task.name,
            message: `Task ${task.name} failed: ${err}`,
          });
        } finally {
          this.running.delete(task.name as TaskName);
        }
      }
    }
  }

  /**
   * Update task configuration
   */
  updateTaskConfig(name: string, updates: { enabled?: boolean; intervalMinutes?: number }) {
    const task = db.listTasks().find(t => t.name === name);
    if (!task) return;

    db.saveTask({
      name: task.name,
      intervalMinutes: updates.intervalMinutes ?? task.interval_minutes ?? 1440,
      enabled: updates.enabled ?? task.enabled === 1,
      lastExecution: task.last_execution ?? undefined,
      lastDurationMs: task.last_duration_ms ?? undefined,
      nextExecution: task.next_execution ?? undefined,
    });
  }

  /**
   * Run a specific task immediately (manual trigger)
   */
  async runTaskNow(name: string): Promise<{ success: boolean; message: string }> {
    const taskDef = TASKS[name as TaskName];
    if (!taskDef) {
      return { success: false, message: `Task ${name} not found` };
    }
    if (this.running.has(name as TaskName)) {
      return { success: false, message: `Task ${name} is already running — wait for the in-flight run to finish` };
    }

    this.running.add(name as TaskName);
    try {
      const startTime = Date.now();
      await taskDef.action(this.config);
      const duration = Date.now() - startTime;
      
      // Update execution time but keep the existing schedule
      const task = db.listTasks().find(t => t.name === name);
      if (task) {
        db.updateTaskExecution(name, duration, task.next_execution ?? new Date(Date.now() + (task.interval_minutes ?? 1440) * 60 * 1000).toISOString());
      }
      
      db.logEvent({
        type: 'scheduler',
        entityType: 'task',
        entityId: name,
        message: `Task ${name} ran manually in ${duration}ms`,
      });
      
      return { success: true, message: `Task ${name} completed successfully in ${duration}ms` };
    } catch (err) {
      debugLog(`Manual task run error for ${name}: ${err}`);
      return { success: false, message: `Task ${name} failed: ${err}` };
    } finally {
      this.running.delete(name as TaskName);
    }
  }

  /**
   * Start the scheduler
   */
  start() {
    this.initializeTasks();
    // Check every minute — the first run happens after the first interval
    // (60 seconds), not synchronously at boot, so heavy tasks (scan-library,
    // sync-shows, backup, etc.) don't block startup.
    this.intervalHandle = setInterval(() => this.runPendingTasks(), 60 * 1000);
    this.gcHandle = setInterval(() => maybeForcedGc(), 15 * 1000);
  }

  /**
   * Stop the scheduler's interval timer. Called during graceful shutdown so
   * SIGTERM handling doesn't race a task against process exit — this only
   * stops new runs from being scheduled, it doesn't cancel a task that's
   * already mid-execution.
   */
  async stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.gcHandle) {
      clearInterval(this.gcHandle);
      this.gcHandle = null;
    }
  }
}
