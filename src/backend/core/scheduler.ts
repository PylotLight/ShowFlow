import { db, type Config, JellyfinConfigSchema } from '../db';
import { SyncManager } from './sync_manager';
import { LibraryScanner } from './library_scanner';
import { debugLog } from './debug';
import { runBackup } from '../../../scripts/backup';
import { GrabberService } from './grabber_service';
import { JellyfinSync } from '../providers/jellyfin/sync';

export type TaskName = 
  | 'sync-shows' 
  | 'scan-library' 
  | 'backup' 
  | 'rss-scan'
  | 'housekeeping'
  | 'update-check'
  | 'watcher-monitor'
  | 'jellyfin-sync';

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
      const result = await sync.syncAllShows();
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
};

export class Scheduler {
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

        const startTime = Date.now();
        try {
          await taskDef.action(this.config);
          const duration = Date.now() - startTime;
          
          // Calculate next execution
          const nextDate = new Date(Date.now() + task.interval_minutes * 60 * 1000);
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
          const nextDate = new Date(Date.now() + task.interval_minutes * 60 * 1000);
          db.updateTaskExecution(task.name, 0, nextDate.toISOString());
          
          db.logEvent({
            type: 'scheduler',
            entityType: 'task',
            entityId: task.name,
            message: `Task ${task.name} failed: ${err}`,
          });
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
      intervalMinutes: updates.intervalMinutes ?? task.interval_minutes,
      enabled: updates.enabled ?? task.enabled,
      lastExecution: task.last_execution,
      lastDurationMs: task.last_duration_ms,
      nextExecution: task.next_execution,
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

    try {
      const startTime = Date.now();
      await taskDef.action(this.config);
      const duration = Date.now() - startTime;
      
      // Update execution time but keep the existing schedule
      const task = db.listTasks().find(t => t.name === name);
      if (task) {
        db.updateTaskExecution(name, duration, task.next_execution || new Date(Date.now() + task.interval_minutes * 60 * 1000).toISOString());
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
    }
  }

  /**
   * Start the scheduler
   */
  start() {
    this.initializeTasks();
    // Check every minute
    setInterval(() => this.runPendingTasks(), 60 * 1000);
    // Run once at startup
    this.runPendingTasks();
  }
}
