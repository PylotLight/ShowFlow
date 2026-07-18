import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@frontend/components/ui/select";
import { cn } from "@frontend/lib/utils";
import { ArrowRightIcon, PaletteIcon, SparklesIcon, TypeIcon } from "lucide-react";
import type { StepProps } from "../types";

const THEME_PRESETS = [
  { color: '#19b7a6', label: 'teal' },
  { color: '#ff6a65', label: 'coral' },
  { color: '#9775fa', label: 'violet' },
  { color: '#58a6ff', label: 'blue' },
  { color: '#f0c94b', label: 'gold' },
];

const FONT_PRESETS = [
  { label: 'Inter', value: '"Inter", sans-serif' },
  { label: 'SF Pro', value: '"-apple-system", BlinkMacSystemFont, sans-serif' },
  { label: 'Geist', value: '"Geist", sans-serif' },
  { label: 'Outfit', value: '"Outfit", sans-serif' },
  { label: 'Plus Jakarta', value: '"Plus Jakarta Sans", sans-serif' },
];

export function StepTheme({ data, setData, onNext, onSkip }: StepProps) {
  const [accent, setAccent] = React.useState("#19b7a6");
  const [displayFont, setDisplayFont] = React.useState(FONT_PRESETS[0]!.value);

  const applyTheme = React.useCallback((color: string) => {
    setAccent(color);
    document.documentElement.style.setProperty('--signal', color);
    try {
      localStorage.setItem("showflow-accent-color", color);
    } catch {}
  }, []);

  return (
    <div className="py-4">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Theme</h2>
        <p className="text-muted-foreground">
          Pick an accent color and font to make ShowFlow feel like yours.
        </p>
      </div>

      <div className="space-y-6">
        <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3 mb-4">
            <PaletteIcon className="size-5 text-signal" />
            <div>
              <p className="text-sm font-semibold">Accent Color</p>
              <p className="text-xs text-muted-foreground">
                Used for buttons, links, and highlights
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {THEME_PRESETS.map(p => (
              <button
                key={p.color}
                onClick={() => applyTheme(p.color)}
                className={cn(
                  "size-9 rounded-full ring-offset-2 ring-offset-background transition-all",
                  accent === p.color && "ring-2 ring-signal scale-110",
                  "hover:scale-110"
                )}
                style={{ backgroundColor: p.color }}
                title={p.label}
              />
            ))}
            <div className="relative">
              <input
                type="color"
                value={accent}
                onChange={e => applyTheme(e.target.value)}
                className="size-9 rounded-full cursor-pointer border-0 bg-transparent
                  [&::-webkit-color-swatch-wrapper]:p-0
                  [&::-webkit-color-swatch]:rounded-full
                  [&::-webkit-color-swatch]:border-0"
              />
            </div>
          </div>
        </div>

        <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3 mb-4">
            <TypeIcon className="size-5 text-signal" />
            <div>
              <p className="text-sm font-semibold">Typography</p>
              <p className="text-xs text-muted-foreground">
                Choose a headline font for your interface
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {FONT_PRESETS.map(f => (
              <button
                key={f.value}
                onClick={() => setDisplayFont(f.value)}
                className={cn(
                  "p-3 rounded-xl border text-sm transition-all text-left",
                  displayFont === f.value
                    ? "border-signal/50 bg-signal/[0.04]"
                    : "border-white/10 hover:border-white/20"
                )}
                style={{ fontFamily: f.value }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button onClick={onSkip} className="text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          Skip and set up manually
        </button>
        <Button onClick={onNext} className="gap-2 h-11 px-6 rounded-xl">
          Continue
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
