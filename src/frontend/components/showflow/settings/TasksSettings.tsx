import * as React from "react";

import { TasksPanel } from "../TasksPanel";
import { useSettings } from "./SettingsContext";

export function TasksSettings() {
  const { saving, setSaving, setSaveMsg } = useSettings();
  const [tasks, setTasks] = React.useState<any[]>([]);
  const [tasksLoading, setTasksLoading] = React.useState(true);
  const [taskRunning, setTaskRunning] = React.useState<Record<string, boolean>>({});

  function loadTasks() {
    setTasksLoading(true);
    fetch("/api/tasks").then(r => r.json()).then(data => {
      setTasks(Array.isArray(data) ? data : []);
    }).catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  }

  React.useEffect(loadTasks, []);

  function updateTaskConfig(name: string, updates: { enabled?: boolean; intervalMinutes?: number }) {
    setSaving(`task-${name}`);
    setSaveMsg(null);
    fetch(`/api/tasks/${name}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then(r => {
      if (r.ok) {
        setSaveMsg({ ok: true, text: "Task updated" });
        loadTasks();
      } else {
        setSaveMsg({ ok: false, text: "Failed to update task" });
      }
    }).catch(() => setSaveMsg({ ok: false, text: "Network error" }))
      .finally(() => setSaving(null));
  }

  function runTaskNow(name: string) {
    setTaskRunning(prev => ({ ...prev, [name]: true }));
    setSaveMsg(null);
    fetch(`/api/tasks/${name}`, { method: "POST" }).then(r => r.json()).then(res => {
      setSaveMsg({ ok: res.success, text: res.message || "Task completed" });
      loadTasks();
    }).catch(() => setSaveMsg({ ok: false, text: "Failed to run task" }))
      .finally(() => setTaskRunning(prev => ({ ...prev, [name]: false })));
  }

  return <TasksPanel tasks={tasks} loading={tasksLoading} onRunTask={runTaskNow} onUpdateTask={updateTaskConfig} taskRunning={taskRunning} saving={saving} />;
}
