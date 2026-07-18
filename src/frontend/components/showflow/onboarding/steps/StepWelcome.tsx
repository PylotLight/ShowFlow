import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { ArrowRightIcon } from "lucide-react";
import type { StepProps } from "../types";
import logoUrl from "@frontend/assets/logo.svg";

export function StepWelcome({ onNext }: StepProps) {
  return (
    <div className="text-center py-6">
      <img
        src={logoUrl}
        alt="ShowFlow"
        className="size-32 mx-auto mb-8"
      />

      <h1 className="text-3xl font-bold tracking-tight mb-3">
        Welcome to{" "}
        <span className="bg-gradient-to-r from-signal to-emerald-400 bg-clip-text text-transparent">
          ShowFlow
        </span>
      </h1>

      <p className="text-muted-foreground text-base leading-relaxed max-w-md mx-auto mb-8">
        Let's get your media server up and running. We'll walk through configuring
        your folders, library types, indexers, and download sources — all in one
        sitting.
      </p>

      <Button
        variant="glass"
        onClick={onNext}
        className="h-12 px-8 rounded-xl text-base gap-2"
      >
        Get Started
        <ArrowRightIcon className="size-4" />
      </Button>
    </div>
  );
}
