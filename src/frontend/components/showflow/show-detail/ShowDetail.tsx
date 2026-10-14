import { Loader2Icon } from "lucide-react";
import * as React from "react";

import { EpisodeDuplicatesDialog } from "@frontend/components/showflow/EpisodeDuplicatesDialog";
import type { ColumnDef } from "@frontend/components/showflow/EpisodeRow";
import { EpisodeMappingDialog } from "@frontend/components/showflow/EpisodeMappingDialog";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { ManageSourcesDialog } from "@frontend/components/showflow/ManageSourcesDialog";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { ReleaseSearchDialog } from "@frontend/components/showflow/ReleaseSearchDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@frontend/components/ui/tabs";

import { loadColumns, saveColumns } from "./columns";
import { MoveFilesDialog } from "./dialogs/MoveFilesDialog";
import { OrganizeDialog } from "./dialogs/OrganizeDialog";
import { RemoveShowDialog } from "./dialogs/RemoveShowDialog";
import { RenameFolderDialog } from "./dialogs/RenameFolderDialog";
import { RenameSeriesDialog } from "./dialogs/RenameSeriesDialog";
import { EpisodeToolbar } from "./EpisodeToolbar";
import { FilesTab } from "./FilesTab";
import { useShowConfig } from "./hooks/useShowConfig";
import { useShowEpisodes } from "./hooks/useShowEpisodes";
import { useShowFileOps } from "./hooks/useShowFileOps";
import { useStatusFlash } from "./hooks/useStatusFlash";
import { MoviePanel } from "./MoviePanel";
import { SeasonList } from "./SeasonList";
import { ShowActionBar } from "./ShowActionBar";
import { ShowHero } from "./ShowHero";
import { ShowSettingsTab } from "./ShowSettingsTab";
import { ShowTopBar } from "./ShowTopBar";
import type { SearchTarget } from "./types";

type DetailTab = "episodes" | "files" | "settings";

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function ShowDetail({ show, onBack, modal = false, onToggleExpand, expanded }: {
  show: ShowSummary;
  onBack: () => void;
  modal?: boolean;
  onToggleExpand?: () => void;
  expanded?: boolean;
}) {
  const { status, flashStatus } = useStatusFlash();
  const episodes = useShowEpisodes(show, flashStatus);
  const config = useShowConfig(show, flashStatus);

  // Films render a dedicated panel (no seasons/episodes exist for them).
  const isMovie = (show.seriesType ?? config.seriesType) === "movie";
  // Bumps to re-fetch the movie panel after a grab/import.
  const [movieRefresh, setMovieRefresh] = React.useState(0);
  const reload = React.useCallback(() => {
    if (isMovie) setMovieRefresh((n) => n + 1);
    else episodes.loadAllEpisodes();
  }, [isMovie, episodes.loadAllEpisodes]);
  const fileOps = useShowFileOps(show, flashStatus, reload, { onBack, onToggleExpand });

  const [tab, setTab] = React.useState<DetailTab>("episodes");
  React.useEffect(() => { setTab("episodes"); }, [show.id]);

  const [columnConfig, setColumnConfig] = React.useState<ColumnDef[]>(loadColumns);
  function toggleColumn(id: string) {
    setColumnConfig(prev => {
      const next = prev.map(c => c.id === id ? { ...c, visible: !c.visible } : c);
      saveColumns(next);
      return next;
    });
  }

  const [manageSourcesOpen, setManageSourcesOpen] = React.useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = React.useState(false);
  const [mappingOpen, setMappingOpen] = React.useState(false);
  const [searchTarget, setSearchTarget] = React.useState<SearchTarget | null>(null);

  async function autoGrabMovie() {
    episodes.setGrabTarget("movie");
    try {
      const res = await fetch(`/api/shows/${show.id}/movie/grab`, { method: "POST" });
      const data = await res.json();
      flashStatus(data.message ?? (data.success ? "Grabbed" : "Grab failed"), !!data.success);
      if (data.success) setMovieRefresh((n) => n + 1);
    } catch (err: any) {
      flashStatus(err.message ?? "Grab failed", false);
    } finally {
      episodes.setGrabTarget(null);
    }
  }

  const episodeListBody = episodes.loadingEpisodes || !episodes.episodesLoaded ? (
    <div className="p-10"><Spinner label="Loading episodes..." /></div>
  ) : episodes.sections.every((s) => s.episodes.length === 0) ? (
    <div className="p-10 text-center text-sm text-muted-foreground">
      {episodes.filter === "all" ? "No episodes loaded." : episodes.filter === "available" ? "No available episodes." : "No missing episodes."}
    </div>
  ) : (
    <SeasonList
      sections={episodes.sections}
      collapsed={episodes.collapsed}
      forceExpand={episodes.forceExpand}
      filter={episodes.filter}
      columns={columnConfig}
      grabTarget={episodes.grabTarget}
      onToggleCollapsed={episodes.toggleCollapsed}
      onToggleSeasonTracked={episodes.toggleSeasonTracked}
      onAutoGrabSeason={episodes.autoGrabSeason}
      onOpenSearch={setSearchTarget}
      toggleTracked={episodes.toggleTracked}
      changeSearchMode={episodes.changeSearchMode}
      autoGrabEpisode={episodes.autoGrabEpisode}
    />
  );

  const settingsTab = (
    <ShowSettingsTab
      config={config}
      onFixMatch={() => setManageSourcesOpen(true)}
      onMapping={() => setMappingOpen(true)}
      onRemove={() => fileOps.setRemoveOpen(true)}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-y-auto relative">
      <ShowTopBar
        title={show.title}
        status={status}
        onBack={onBack}
        modal={modal}
        onToggleExpand={onToggleExpand}
        expanded={expanded}
      />

      <ShowHero show={show} modal={modal} seasons={episodes.seasons} releaseDelayMinutes={config.releaseDelayMinutes}>
        <ShowActionBar
          isMovie={isMovie}
          missingCount={episodes.missingEpisodes.length}
          searchingMissing={episodes.grabTarget === "missing"}
          onSearchMissing={episodes.searchMissing}
          onFixMatch={() => setManageSourcesOpen(true)}
          refreshing={fileOps.refreshing}
          onRefresh={fileOps.refreshMetadata}
          organizing={fileOps.organizing}
          onOrganize={fileOps.openOrganize}
          renamingFolder={fileOps.renamingFolder}
          onRenameFolder={fileOps.openRenameFolder}
          onRenameSeries={fileOps.openRenameSeries}
          onMapping={() => setMappingOpen(true)}
          mappingHealth={config.mappingHealth}
          onDedupe={() => setDuplicatesOpen(true)}
          onScan={fileOps.scanDir}
          onRemove={() => fileOps.setRemoveOpen(true)}
          monitorNewEpisodes={config.monitorNewEpisodes}
          onMonitorNewEpisodes={config.changeMonitorNewEpisodes}
        />
      </ShowHero>

      <div className="relative z-10 flex-1 px-4 md:px-8 pt-3 pb-4 md:pb-8 flex flex-col min-h-0">
        <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="min-h-0 flex-1">
          <TabsList className="self-start">
            <TabsTrigger value="episodes" className="text-xs focus-visible:ring-2 focus-visible:ring-signal/70">{isMovie ? "Movie" : "Episodes"}</TabsTrigger>
            {!isMovie && <TabsTrigger value="files" className="text-xs focus-visible:ring-2 focus-visible:ring-signal/70">Files</TabsTrigger>}
            <TabsTrigger value="settings" className="text-xs focus-visible:ring-2 focus-visible:ring-signal/70">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="episodes" className="flex flex-col min-h-0 gap-4">
            {isMovie ? (
              <MoviePanel
                key={movieRefresh}
                showId={show.id}
                showTitle={show.title}
                onBrowse={() => setSearchTarget({ season: 0 })}
                onAutoGrab={autoGrabMovie}
                grabbing={episodes.grabTarget === "movie"}
              />
            ) : episodes.seasons === null ? (
              <Spinner label="Loading seasons..." />
            ) : episodes.seasons.length === 0 ? (
              <GlassPanel className="p-10 text-center text-sm text-muted-foreground">
                No episodes synced yet for this show.
              </GlassPanel>
            ) : (
              <>
                <EpisodeToolbar
                  available={episodes.overallAvailable}
                  total={episodes.overallTotal}
                  filter={episodes.filter}
                  onFilter={episodes.setFilter}
                  columns={columnConfig}
                  onToggleColumn={toggleColumn}
                />
                <GlassPanel className="flex-1 overflow-hidden min-h-0 flex flex-col">{episodeListBody}</GlassPanel>
              </>
            )}
          </TabsContent>

          {!isMovie && (
            <TabsContent value="files">
              <FilesTab
                sections={episodes.sections}
                loading={episodes.loadingEpisodes && !episodes.episodesLoaded}
                organizing={fileOps.organizing}
                renamingFolder={fileOps.renamingFolder}
                onOrganize={fileOps.openOrganize}
                onRenameFolder={fileOps.openRenameFolder}
                onDedupe={() => setDuplicatesOpen(true)}
                onScan={fileOps.scanDir}
              />
            </TabsContent>
          )}

          <TabsContent value="settings">{settingsTab}</TabsContent>
        </Tabs>
      </div>

      {/* ---- Dialogs ---- */}
      {searchTarget && (
        <ReleaseSearchDialog
          open={searchTarget !== null}
          onOpenChange={(open) => { if (!open) setSearchTarget(null); }}
          showId={show.id}
          showTitle={show.title}
          season={searchTarget.season}
          episode={searchTarget.episode}
          kind={isMovie ? "movie" : "tv"}
          onGrabbed={(message, success) => {
            flashStatus(message, success);
            if (isMovie) {
              if (success) setMovieRefresh((n) => n + 1);
            } else {
              episodes.loadAllEpisodes();
            }
          }}
          autoCloseOnSuccess
        />
      )}

      <ManageSourcesDialog
        showId={show.id}
        showTitle={show.title}
        open={manageSourcesOpen}
        onOpenChange={setManageSourcesOpen}
        // Refresh the whole list after source changes (new episodes might appear)
        onSourcesChanged={() => episodes.loadAllEpisodes()}
      />

      {fileOps.organizePreview && (
        <OrganizeDialog
          preview={fileOps.organizePreview}
          applying={fileOps.organizeApplying}
          onApply={fileOps.applyOrganize}
          onCancel={() => fileOps.setOrganizePreview(null)}
        />
      )}

      {fileOps.renamePreview && (
        <RenameFolderDialog
          preview={fileOps.renamePreview}
          applying={fileOps.renamingFolder}
          onApply={fileOps.applyRenameFolder}
          onCancel={() => fileOps.setRenamePreview(null)}
        />
      )}

      {fileOps.renameSeriesOpen && (
        <RenameSeriesDialog
          title={fileOps.renameSeriesTitle}
          onTitleChange={fileOps.setRenameSeriesTitle}
          applying={fileOps.renamingSeries}
          onApply={fileOps.applyRenameSeries}
          onCancel={() => fileOps.setRenameSeriesOpen(false)}
        />
      )}

      <EpisodeMappingDialog
        showId={show.id}
        showTitle={show.title}
        open={mappingOpen}
        onOpenChange={setMappingOpen}
        onChanged={config.refreshMappingHealth}
      />

      <EpisodeDuplicatesDialog
        showId={show.id}
        open={duplicatesOpen}
        onOpenChange={setDuplicatesOpen}
        onResolved={() => episodes.loadAllEpisodes()}
      />

      {config.moveDialog && (
        <MoveFilesDialog
          state={config.moveDialog}
          relocating={config.relocating}
          onMoveFiles={() => {
            const target = config.folderProfiles.find(fp => fp.id === config.moveDialog!.profileId);
            if (target) config.relocateWithChange(target, config.moveDialog!.oldRoot);
          }}
          onChangeOnly={() => {
            const target = config.folderProfiles.find(fp => fp.id === config.moveDialog!.profileId);
            if (target) config.executeRootFolderChange(target);
            config.setMoveDialog(null);
          }}
          onCancel={() => config.setMoveDialog(null)}
        />
      )}

      <RemoveShowDialog
        open={fileOps.removeOpen}
        onOpenChange={fileOps.setRemoveOpen}
        title={show.title}
        removing={fileOps.removing}
        onConfirm={fileOps.removeShow}
      />
    </div>
  );
}
