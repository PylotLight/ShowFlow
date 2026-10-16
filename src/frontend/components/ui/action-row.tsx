import { DropdownMenu } from "radix-ui";
import { Loader2Icon, MoreVertical } from "lucide-react";
import * as React from "react";

import { useCompact } from "@frontend/lib/useCompact";

import { pillButton, pillButtonDanger, pillButtonPrimary, pillIconButton } from "./pill";

const menuItem =
  "flex w-full cursor-pointer select-none items-start gap-2.5 rounded-md px-2 py-2 text-left outline-none data-[highlighted]:bg-white/[0.06] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 pointer-coarse:min-h-11";

/** One row of a dropdown action menu: icon, label, optional hint and trailing bit. */
export function ActionMenuEntry({ icon, label, hint, onSelect, danger, trailing, disabled }: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onSelect: () => void;
  danger?: boolean;
  trailing?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item className={`${menuItem} ${danger ? "data-[highlighted]:bg-red-400/10" : ""}`} onSelect={onSelect} disabled={disabled}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-2 text-sm ${danger ? "text-red-400" : "text-foreground/90"}`}>
          {label}
          {trailing}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </DropdownMenu.Item>
  );
}

/** Popover panel for an action menu (portaled, phone-width safe). */
export function ActionMenuContent({ align = "end", children }: { align?: "start" | "end"; children: React.ReactNode }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className="z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-white/10 bg-[#15181f] p-1.5 shadow-xl"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export type RowAction = {
  id: string;
  label: string;
  /** Lucide icon component; sized by the row. */
  icon: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
  /** Tooltip on wide screens; the second line of the overflow-menu entry on compact. */
  hint?: string;
  busy?: boolean;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
};

/**
 * A toolbar row: optional leading content (stats, a title) then actions.
 *
 * Wide: every action is a pill, wrapping if it must.
 * Compact (< md): one line. Leading content truncates, the `primary` action
 * stays a pill and everything else folds into a ⋮ overflow menu with hints.
 */
export function ActionRow({ lead, actions, primary, menuLabel = "More actions", className = "" }: {
  lead?: React.ReactNode;
  actions: RowAction[];
  /** id of the action kept visible on compact widths (defaults to the first). */
  primary?: string;
  menuLabel?: string;
  className?: string;
}) {
  const compact = useCompact();
  const pillFor = (a: RowAction) => (a.tone === "primary" ? pillButtonPrimary : a.tone === "danger" ? pillButtonDanger : pillButton);
  const iconFor = (a: RowAction, size: string) =>
    a.busy ? <Loader2Icon className={`${size} animate-spin`} /> : <a.icon className={size} />;

  const renderPill = (a: RowAction) => (
    <button key={a.id} type="button" onClick={a.onSelect} disabled={a.disabled || a.busy} title={a.hint} className={pillFor(a)}>
      {iconFor(a, "size-3.5")} {a.label}
    </button>
  );

  if (!compact) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className}`}>
        {lead && <div className="mr-auto min-w-0">{lead}</div>}
        {actions.map(renderPill)}
      </div>
    );
  }

  const main = actions.find((a) => a.id === primary) ?? actions[0];
  const rest = actions.filter((a) => a !== main);
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      {lead && <div className="mr-auto min-w-0 flex-1 truncate">{lead}</div>}
      {main && renderPill(main)}
      {rest.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label={menuLabel} title={menuLabel} className={pillIconButton}>
              <MoreVertical className="size-4" />
            </button>
          </DropdownMenu.Trigger>
          <ActionMenuContent>
            {rest.map((a) => (
              <ActionMenuEntry
                key={a.id}
                icon={iconFor(a, a.tone === "danger" ? "size-4 text-red-400" : "size-4 text-signal")}
                label={a.label}
                hint={a.hint}
                danger={a.tone === "danger"}
                disabled={a.disabled || a.busy}
                onSelect={a.onSelect}
              />
            ))}
          </ActionMenuContent>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
