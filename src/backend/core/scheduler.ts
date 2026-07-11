import { db, type Config } from '../db';
import { SyncManager } from './sync_manager';
import { LibraryScanner } from './library_scanner';
import { debugLog } from './debug';

export type TaskName = 'sync-shows' | 'scan-library';

export interface TaskDefinition {
  name: TaskName;
  intervalMinutes: number;
  action: (config: Config) => Promise<void>;
}

const TASKS: Record<TaskName, TaskDefinition> = {
  'sync-shows': {
    name: 'sync-shows',
    intervalMinutes: 1440, // Daily
    action: async (config) => {
      const sync = new SyncManager(config);
      const result = await sync.syncAllShows();
      debugLog(`Task sync-shows complete: ${result.syncedCount} synced, ${result.errorCount} errors.`);
    },
  },
  'scan-library': {
    name: 'scan-library',
    intervalMinutes: 60, // Hourly
    action: async (config) => {
      const scanner = new LibraryScanner(config);
      await scanner.scan();
    },
  },
};

export class Scheduler {
  constructor(private config: Config) {}

  async runPendingTasks() {
    const tasks = db.listTasks();
    
    // Ensure all defined tasks exist in DB
    for (const taskDef of Object.values(TASKS)) {
      const exists = tasks.find(t => t.name === taskDef.name);
      if (!exists) {
        db.saveTask({
          name: taskDef.name,
          intervalMinutes: taskDef.intervalMinutes,
          enabled: true,
        });
      }
    }

    // Re-fetch tasks from DB after potential insertions
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
        }
      }
    }
  }

  start() {
    // Check every minute
    setInterval(() => this.runPendingTasks(), 60 * 1000);
    // Run once at startup
    this.runPendingTasks();
  }
}
