import * as React from "react";
import { ClockIcon, CalendarIcon, DownloadIcon, RefreshCwIcon, PlayIcon, CheckIcon, XIcon, Loader2Icon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Switch } from "@frontend/components/ui/switch";
import { Button } from "@frontend/components/ui/button";

export function TasksPanel({ tasks, loading, onRunTask, onUpdateTask, taskRunning, saving }: {
  tasks: any[];
  loading: boolean;
  onRunTask: (name: string) => void;
  onUpdateTask: (name: string, updates: any) => void;
  taskRunning: Record<string, boolean>;
  saving: string | null;
}) {
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editInterval, setEditInterval] = React.useState<number>(60);

  const groupedTasks = React.useMemo(() => {
    const groups: Record<string, any[]> = {
      sync: [],
      maintenance: [],
      downloading: [],
      system: [],
    };
    tasks.forEach((task: any) => {
      const cat = task.category as keyof typeof groups;
      if (cat in groups) {
        groups[cat]!.push(task);
      } else {
        groups.system!.push(task);
      }
    });
    return groups;
  }, [tasks]);

  const categoryLabels: Record<string, { label: string; icon: any }> = {
    sync: { label: "Sync Tasks", icon: RefreshCwIcon },
    maintenance: { label: "Maintenance", icon: CalendarIcon },
    downloading: { label: "Downloading", icon: DownloadIcon },
    system: { label: "System", icon: ClockIcon },
  };

  function formatInterval(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  function formatLastExecution(task: any): string {
    if (!task.lastExecution) return "Never";
    const date = new Date(task.lastExecution);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  }

  function formatNextExecution(task: any): string {
    if (!task.nextExecution) return "Not scheduled";
    const date = new Date(task.nextExecution);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins <= 0) return "Due now";
    if (diffMins < 60) return `In ${diffMins}m`;
    if (diffMins < 1440) return `In ${Math.floor(diffMins / 60)}h`;
    return `In ${Math.floor(diffMins / 1440)}d`;
  }

  function startEdit(task: any) {
    setEditing(task.name);
    setEditInterval(task.intervalMinutes);
  }

  function saveEdit(task: any) {
    onUpdateTask(task.name, { intervalMinutes: editInterval });
    setEditing(null);
  }

  function cancelEdit() {
    setEditing(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Object.entries(groupedTasks).map(([category, categoryTasks]) => {
        if (categoryTasks.length === 0) return null;
        const { label, icon: Icon } = categoryLabels[category] || { label: category, icon: ClockIcon };
        
        return (
          <GlassPanel key={category} className="overflow-hidden">
            <div className="px-6 py-4 border-b border-white/5">
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-signal" />
                <h3 className="font-display text-lg font-bold text-white">{label}</h3>
              </div>
            </div>
            <div className="divide-y divide-white/5">
              {categoryTasks.map(task => (
                <div key={task.name} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-mono text-sm font-medium text-white">{task.displayName}</h4>
                        {!task.enabled && (
                          <span className="px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground text-[10px] font-mono uppercase">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs mt-1">{task.description}</p>
                      <div className="flex items-center gap-4 mt-3 text-xs font-mono text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <ClockIcon className="size-3" />
                          Interval: {editing === task.name ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                value={editInterval}
                                onChange={e => setEditInterval(parseInt(e.target.value) || 1)}
                                className="w-16 bg-white/5 border border-white/10 rounded px-2 py-0.5 text-foreground"
                                min="1"
                              />
                              <span>minutes</span>
                              <button
                                onClick={() => saveEdit(task)}
                                disabled={saving === `task-${task.name}`}
                                className="text-emerald-400 hover:text-emerald-300"
                              >
                                <CheckIcon className="size-3" />
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <XIcon className="size-3" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(task)}
                              className="hover:text-foreground transition-colors"
                            >
                              {formatInterval(task.intervalMinutes)}
                            </button>
                          )}
                        </span>
                        <span className="flex items-center gap-1.5">
                          Last run: {formatLastExecution(task)}
                        </span>
                        <span className="flex items-center gap-1.5">
                          Next run: {formatNextExecution(task)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={task.enabled}
                        onCheckedChange={(checked) => onUpdateTask(task.name, { enabled: checked })}
                        disabled={saving === `task-${task.name}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRunTask(task.name)}
                        disabled={taskRunning[task.name] || !task.enabled}
                        className="h-8 px-2"
                      >
                        {taskRunning[task.name] ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <PlayIcon className="size-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </GlassPanel>
        );
      })}
    </div>
  );
}
