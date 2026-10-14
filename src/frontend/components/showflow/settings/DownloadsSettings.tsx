import * as React from "react";

import { DownloadsTab } from "../DownloadsTab";
import { useSettings } from "./SettingsContext";

export function DownloadsSettings() {
  const { config, saveConfig } = useSettings();
  const [showTorboxKey, setShowTorboxKey] = React.useState(false);
  return <DownloadsTab config={config} saveConfig={saveConfig} showTorboxKey={showTorboxKey} setShowTorboxKey={setShowTorboxKey} />;
}
