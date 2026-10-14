import * as React from "react";

import { ProvidersTab } from "../ProvidersTab";
import { useSettings } from "./SettingsContext";

export function ProvidersSettings() {
  const { config, updateApiKey, saveConfig } = useSettings();
  const [showTmdbKey, setShowTmdbKey] = React.useState(false);
  const [showTvdbKey, setShowTvdbKey] = React.useState(false);
  const [showTvdbPin, setShowTvdbPin] = React.useState(false);
  return (
    <ProvidersTab
      config={config}
      updateApiKey={updateApiKey}
      showTmdbKey={showTmdbKey}
      setShowTmdbKey={setShowTmdbKey}
      showTvdbKey={showTvdbKey}
      setShowTvdbKey={setShowTvdbKey}
      showTvdbPin={showTvdbPin}
      setShowTvdbPin={setShowTvdbPin}
      saveImdb={(imdb: any) => saveConfig({ imdb })}
    />
  );
}
