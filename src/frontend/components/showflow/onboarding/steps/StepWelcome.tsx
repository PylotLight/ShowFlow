import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { ArrowRightIcon } from "lucide-react";
import type { StepProps } from "../types";

export function StepWelcome({ onNext }: StepProps) {
  return (
    <div className="text-center py-8">
      <div className="inline-flex items-center justify-center size-16 rounded-2xl bg-signal/10 mb-6 ring-1 ring-signal/20">
        <span className="text-2xl font-bold text-signal">SF</span>
      </div>

      <h1 className="text-3xl font-bold tracking-tight mb-3">
        Welcome to{" "}
        <span className="bg-gradient-to-r from-signal to-emerald-400 bg-clip-text text-transparent">
          ShowFlow
        </span>
      </h1>

      <p className="text-muted-foreground text-base leading-relaxed max-w-md mx-auto mb-8">
        Let's get your media server up and running. We'll walk through configuring
        your folders, library types, indexers, and download sources — all in one
        sitting. This takes about 5 minutes.
      </p>

      <div className="flex flex-col items-center gap-3">
        <Button
          onClick={onNext}
          className="h-12 px-8 rounded-xl text-base gap-2"
        >
          Get Started
          <ArrowRightIcon className="size-4" />
        </Button>

        <p className="text-xs text-muted-foreground/50 mt-2">
          You'll configure folders, library types, indexers, Sonarr, and appearance
        </p>
      </div>
    </div>
  );
}
