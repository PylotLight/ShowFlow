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

export function FieldRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 shrink-0 pt-2.5" style={{ width: 170 }}>
        <Label className="font-mono text-sub font-bold uppercase tracking-widest text-foreground/80">{label}</Label>
        <p className="text-muted-foreground mt-0.5 text-sub leading-tight">{description}</p>
      </div>
      <div className="min-w-0 flex-1 max-w-lg">{children}</div>
    </div>
  );
}
