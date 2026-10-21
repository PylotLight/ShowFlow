import * as React from "react";
import { Label } from "@frontend/components/ui/label";

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

/**
 * Settings type scale (keep settings on these, nothing bigger/smaller):
 *   section title  font-display text-base   (panel <h3>)
 *   label / body   text-sub (13px)          row labels, control text
 *   meta           text-caption (12px)      descriptions, helper lines
 *   floor          text-[11px]              mono tags/kickers only
 */
export const SETTINGS_TEXT = {
  label: "text-sub font-medium text-foreground",
  desc: "text-caption leading-snug text-muted-foreground",
} as const;

/**
 * One setting: label + description on the left taking the free width, the
 * control on the right. Sized off the row's own width (container query), not
 * the viewport, since settings content sits next to two sidebars. Under ~28rem
 * it stacks with the control below.
 */
export function FieldRow({ label, description, settingId, children }: {
  label: string;
  description: string;
  /** Registry id (settings/registry.ts) so settings search can land here. */
  settingId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="@container" data-setting={settingId}>
      <div className="flex flex-col gap-2 @md:flex-row @md:items-center @md:justify-between @md:gap-6">
        <div className="min-w-0 flex-1">
          <Label className={SETTINGS_TEXT.label}>{label}</Label>
          <p className={cn("mt-0.5", SETTINGS_TEXT.desc)}>{description}</p>
        </div>
        <div className="flex min-w-0 @md:w-[min(20rem,45%)] @md:shrink-0 @md:justify-end [&>*]:max-w-full [&>div]:w-full">{children}</div>
      </div>
    </div>
  );
}
