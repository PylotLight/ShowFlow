import {
  Archive, BarChart3, Bug, Clock, Database, Download, FileText, Gauge, KeyRound, Palette, Plug, Settings2,
} from "lucide-react";
import type * as React from "react";

export interface SettingsTabDef {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Mobile presentation: bottom sheet or full-screen drill-down. */
  mobileStyle: "sheet" | "drill";
}

/**
 * Tabs grouped for the vertical nav. Ids are stable (deep links, Sidebar,
 * HealthDashboard and the routing work all refer to them).
 */
export const SETTINGS_GROUPS: { label: string; tabs: SettingsTabDef[] }[] = [
  {
    label: "Library",
    tabs: [
      { id: "general", label: "General", icon: Settings2, mobileStyle: "sheet" },
      { id: "quality", label: "Quality", icon: Gauge, mobileStyle: "sheet" },
      { id: "naming", label: "Naming", icon: FileText, mobileStyle: "drill" },
      { id: "downloads", label: "Downloads", icon: Download, mobileStyle: "drill" },
    ],
  },
  {
    label: "Sources",
    tabs: [
      { id: "providers", label: "Providers", icon: KeyRound, mobileStyle: "sheet" },
      { id: "indexers", label: "Indexers", icon: Database, mobileStyle: "sheet" },
      { id: "integrations", label: "Integrations", icon: Plug, mobileStyle: "sheet" },
    ],
  },
  {
    label: "Interface",
    tabs: [{ id: "appearance", label: "Appearance", icon: Palette, mobileStyle: "drill" }],
  },
  {
    label: "System",
    tabs: [
      { id: "tasks", label: "Tasks", icon: Clock, mobileStyle: "drill" },
      { id: "backup", label: "Backup", icon: Archive, mobileStyle: "drill" },
      { id: "analytics", label: "Analytics", icon: BarChart3, mobileStyle: "drill" },
      { id: "debug", label: "Debug", icon: Bug, mobileStyle: "drill" },
    ],
  },
];

export const SETTINGS_TABS: SettingsTabDef[] = SETTINGS_GROUPS.flatMap(g => g.tabs);
