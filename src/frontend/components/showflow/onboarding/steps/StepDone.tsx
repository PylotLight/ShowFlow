import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import {
  CheckCircleIcon,
  SparklesIcon,
  TvIcon,
  LibraryIcon,
  SettingsIcon,
} from "lucide-react";
import type { StepProps } from "../types";

export function StepDone({ data, onNext }: StepProps) {
  const summary = [
    { icon: LibraryIcon, label: 'Root folders', value: data.rootFolders.length.toString() },
    { icon: SettingsIcon, label: 'Library type', value: data.libraryTypeId ? 'Configured' : 'Default' },
    { icon: TvIcon, label: 'Sonarr series', value: data.sonarr.series.length > 0 ? `${data.sonarr.series.length} series` : 'Not connected' },
  ];

  return (
    <div className="py-4 text-center">
      <div className="inline-flex items-center justify-center size-16 rounded-2xl bg-green-500/10 mb-6 ring-1 ring-green-500/20">
        <CheckCircleIcon className="size-8 text-green-400" />
      </div>

      <h1 className="text-3xl font-bold tracking-tight mb-3">
        You're all set!
      </h1>

      <p className="text-muted-foreground text-base leading-relaxed max-w-md mx-auto mb-8">
        ShowFlow is ready to go. Your media library has been configured and
        ShowFlow is already checking for new releases.
      </p>

      <div className="flex items-center justify-center gap-6 mb-10">
        {summary.map((item, i) => (
          <div key={item.label} className="flex flex-col items-center gap-1.5">
            <item.icon className="size-5 text-signal" />
            <p className="text-xs text-muted-foreground/60">{item.label}</p>
            <p className="text-sm font-semibold">{item.value}</p>
          </div>
        ))}
      </div>

      <Button
        onClick={onNext}
        className="h-12 px-8 rounded-xl text-base gap-2"
      >
        <SparklesIcon className="size-4" />
        Go to Dashboard
      </Button>

      <p className="text-xs text-muted-foreground/50 mt-3">
        You can always re-run this wizard from Settings later
      </p>
    </div>
  );
}
