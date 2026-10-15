import type { ColumnDef } from "@frontend/components/showflow/EpisodeRow";

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: "airDate", label: "Air Date", visible: true },
  { id: "status", label: "Status", visible: true },
  { id: "actions", label: "Actions", visible: true },
  // This column is the auto/interactive search-mode toggle, not the search
  // action itself (that lives in "Actions"), so it stays opt-in.
  { id: "search", label: "Search mode", visible: false },
];

export function loadColumns(): ColumnDef[] {
  try {
    const saved = localStorage.getItem("showflow-columns");
    if (saved) {
      const parsed = JSON.parse(saved) as ColumnDef[];
      return DEFAULT_COLUMNS.map((def) => ({ ...def, visible: parsed.find((p) => p.id === def.id)?.visible ?? def.visible }));
    }
  } catch {}
  return DEFAULT_COLUMNS;
}

export function saveColumns(cols: ColumnDef[]) {
  try { localStorage.setItem("showflow-columns", JSON.stringify(cols)); } catch {}
}
