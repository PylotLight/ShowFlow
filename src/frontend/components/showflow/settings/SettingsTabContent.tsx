import * as React from "react";

import { AnalyticsPanel } from "../AnalyticsPanel";
import { BackupPanel } from "../BackupPanel";
import { DebugSettings } from "../DebugSettings";
import { NamingTab } from "../NamingTab";
import { QualityProfilesTab } from "../QualityProfiles";
import { SourcesPage } from "../SourcesPage";
import { navigate, pageHash } from "@frontend/lib/router";
import { AppearanceSettings } from "./AppearanceSettings";
import { ConnectSettings } from "./ConnectSettings";
import { DownloadsSettings } from "./DownloadsSettings";
import { GeneralSettings } from "./GeneralSettings";
import { IndexersSettings } from "./IndexersSettings";
import { IntegrationsSettings } from "./IntegrationsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { useSettings } from "./SettingsContext";
import { TasksSettings } from "./TasksSettings";

function NamingSettings() {
  const { config, saveConfig } = useSettings();
  return <NamingTab config={config} saveConfig={saveConfig} />;
}

/** Body for one settings tab. Each tab owns its own state. */
export function SettingsTabContent({ id, scrollToSection, onReRunWizard }: {
  id: string;
  scrollToSection?: string;
  onReRunWizard?: () => void;
}) {
  switch (id) {
    case "general": return <GeneralSettings scrollToSection={scrollToSection} onReRunWizard={onReRunWizard} />;
    case "providers": return <ProvidersSettings />;
    case "indexers": return <IndexersSettings />;
    case "integrations": return <IntegrationsSettings />;
    case "connect": return <ConnectSettings />;
    case "appearance": return <AppearanceSettings />;
    case "quality": return <QualityProfilesTab />;
    case "naming": return <NamingSettings />;
    case "downloads": return <DownloadsSettings />;
    case "tasks": return <TasksSettings />;
    case "backup": return <BackupPanel />;
    case "analytics": return <AnalyticsPanel />;
    case "debug": return <DebugSettings />;
    case "sources": return <SourcesPage onOpenSettings={() => navigate(pageHash("settings", "indexers"))} />;
    default: return null;
  }
}
