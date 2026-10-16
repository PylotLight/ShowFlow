import { DropdownMenu } from "radix-ui";
import {
  BellOff, BellRing, FolderArchive, FolderSearch, GitCompareArrows, Link2, Loader2Icon, MoreHorizontal, PencilIcon,
  RefreshCwIcon, SearchIcon, Trash2, Wand2,
} from "lucide-react";
import * as React from "react";

import { Switch } from "@frontend/components/ui/switch";
import { ActionMenuEntry } from "@frontend/components/ui/action-row";
import { useCompact } from "@frontend/lib/useCompact";

import { pillButton, pillButtonPrimary, pillIconButton } from "./format";

const MenuEntry = ActionMenuEntry;

function mappingDot(health: string) {
  const color = health === "ok" ? "bg-emerald-400" : health === "conflicts" ? "bg-amber-400" : health === "error" ? "bg-red-400" : "bg-slate-500";
  return <span className={`ml-auto size-1.5 rounded-full ${color}`} aria-label={`Mapping health: ${health}`} />;
}

/**
 * The primary show actions, visible instead of buried in an overflow menu:
 * Search missing · Fix match · Refresh metadata · Organise files, then a
 * More menu for the rarer ones. Optional monitor-new-episodes toggle on the
 * right when the backend reports the field.
 */
export function ShowActionBar(props: {
  isMovie: boolean;
  missingCount: number;
  searchingMissing: boolean;
  onSearchMissing: () => void;
  onFixMatch: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  organizing: boolean;
  onOrganize: () => void;
  renamingFolder: boolean;
  onRenameFolder: () => void;
  onRenameSeries: () => void;
  onMapping: () => void;
  mappingHealth: string;
  onDedupe: () => void;
  onScan: () => void;
  onRemove: () => void;
  monitorNewEpisodes?: boolean;
  onMonitorNewEpisodes: (v: boolean) => void;
}) {
  const monitorId = React.useId();
  const compact = useCompact();
  const moreMenu = (
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align={compact ? "end" : "start"}
            sideOffset={6}
            collisionPadding={8}
            className="z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-white/10 bg-[#15181f] p-1.5 shadow-xl"
          >
            {compact && (
              <MenuEntry icon={<Link2 className="size-4 text-signal" />} label="Fix match" hint="Change or add the metadata provider this show is matched to" onSelect={props.onFixMatch} />
            )}
            <MenuEntry
              icon={<GitCompareArrows className="size-4 text-signal" />}
              label="Episode mapping"
              hint="Scene ↔ provider numbering overrides for anime and specials"
              trailing={mappingDot(props.mappingHealth)}
              onSelect={props.onMapping}
            />
            <MenuEntry
              icon={props.renamingFolder ? <Loader2Icon className="size-4 animate-spin" /> : <FolderSearch className="size-4 text-signal" />}
              label="Rename folder"
              hint="Match the show folder to the sanitized title"
              onSelect={props.onRenameFolder}
            />
            <MenuEntry icon={<PencilIcon className="size-4 text-signal" />} label="Rename series" hint="Change the series title itself" onSelect={props.onRenameSeries} />
            <MenuEntry icon={<FolderArchive className="size-4 text-signal" />} label="Dedupe" hint="Find overlapping and duplicate files" onSelect={props.onDedupe} />
            <MenuEntry icon={<FolderSearch className="size-4 text-signal" />} label="Rescan folder" hint="Re-read the show folder on disk for new or removed files" onSelect={props.onScan} />
            <DropdownMenu.Separator className="my-1 h-px bg-white/5" />
            <MenuEntry icon={<Trash2 className="size-4 text-red-400" />} label="Remove" hint="Remove this show from your library" danger onSelect={props.onRemove} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
  );

  if (compact) {
    // Phone / mini window: one row — primary action stretches, the rest
    // are icon buttons, Fix match moves into the More menu and the monitor
    // switch becomes a bell toggle.
    const iconBtn = pillIconButton;
    return (
      <div className="flex items-center gap-1.5">
        {!props.isMovie ? (
          <button
            type="button"
            onClick={props.onSearchMissing}
            disabled={props.searchingMissing}
            title="Auto-grab every monitored, aired episode that isn't on disk yet"
            className={`${pillButtonPrimary} min-w-0 flex-1 justify-center`}
          >
            {props.searchingMissing ? <Loader2Icon className="size-3.5 shrink-0 animate-spin" /> : <SearchIcon className="size-3.5 shrink-0" />}
            <span className="truncate">Search missing</span>
            {props.missingCount > 0 && (
              <span className="shrink-0 rounded-full bg-signal/20 px-1.5 text-[11px] leading-4">{props.missingCount}</span>
            )}
          </button>
        ) : (
          <button type="button" onClick={props.onFixMatch} className={`${pillButton} flex-1 justify-center`}>
            <Link2 className="size-3.5" /> Fix match
          </button>
        )}
        <button type="button" onClick={props.onRefresh} disabled={props.refreshing} aria-label="Refresh metadata" title="Refresh metadata" className={iconBtn}>
          {props.refreshing ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
        </button>
        <button type="button" onClick={props.onOrganize} disabled={props.organizing} aria-label="Organise files" title="Organise files" className={iconBtn}>
          {props.organizing ? <Loader2Icon className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
        </button>
        {typeof props.monitorNewEpisodes === "boolean" && (
          <button
            type="button"
            role="switch"
            aria-checked={props.monitorNewEpisodes}
            aria-label="Monitor new episodes"
            title={`Monitor new episodes: ${props.monitorNewEpisodes ? "on" : "off"}`}
            onClick={() => props.onMonitorNewEpisodes(!props.monitorNewEpisodes)}
            className={`${iconBtn} ${props.monitorNewEpisodes ? "bg-signal/15 text-signal hover:bg-signal/25 hover:text-signal" : ""}`}
          >
            {props.monitorNewEpisodes ? <BellRing className="size-4" /> : <BellOff className="size-4" />}
          </button>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label="More show actions" className={iconBtn}>
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          {moreMenu}
        </DropdownMenu.Root>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!props.isMovie && (
        <button
          type="button"
          onClick={props.onSearchMissing}
          disabled={props.searchingMissing}
          title="Auto-grab every monitored, aired episode that isn't on disk yet"
          className={pillButtonPrimary}
        >
          {props.searchingMissing ? <Loader2Icon className="size-3.5 animate-spin" /> : <SearchIcon className="size-3.5" />}
          Search missing
          {props.missingCount > 0 && (
            <span className="rounded-full bg-signal/20 px-1.5 text-[11px] leading-4">{props.missingCount}</span>
          )}
        </button>
      )}
      <button type="button" onClick={props.onFixMatch} title="Change or add the metadata provider this show is matched to" className={pillButton}>
        <Link2 className="size-3.5" /> Fix match
      </button>
      <button type="button" onClick={props.onRefresh} disabled={props.refreshing} title="Re-sync seasons, episodes and artwork from the metadata provider" className={pillButton}>
        {props.refreshing ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
        Refresh
      </button>
      <button type="button" onClick={props.onOrganize} disabled={props.organizing} title="Rename episode files to your naming pattern (shows a preview first)" className={pillButton}>
        {props.organizing ? <Loader2Icon className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
        Organise
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="More show actions" className={pillButton}>
            <MoreHorizontal className="size-3.5" />
            <span className="hidden sm:inline">More</span>
          </button>
        </DropdownMenu.Trigger>
        {moreMenu}
      </DropdownMenu.Root>

      {typeof props.monitorNewEpisodes === "boolean" && (
        <label htmlFor={monitorId} className="ml-auto flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1 text-xs text-foreground/85">
          Monitor new episodes
          <Switch id={monitorId} checked={props.monitorNewEpisodes} onCheckedChange={props.onMonitorNewEpisodes} />
        </label>
      )}
    </div>
  );
}
