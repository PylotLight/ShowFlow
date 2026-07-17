import * as React from "react";
import { THEME_PRESETS } from "@frontend/lib/theme";

export function ColorDock({ current, onChange }: { current: string; onChange: (c: string) => void }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const isCustom = !THEME_PRESETS.some(p => p.color === current);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1.5 bg-white/[0.04] rounded-full p-1 border border-white/5 cursor-pointer">
        {THEME_PRESETS.map(({ color, label }) => (
          <button
            key={color}
            onClick={() => onChange(color)}
            className={`cursor-pointer size-6 rounded-full transition-all ${
              current === color ? "ring-2 ring-white/80 scale-110" : "ring-1 ring-white/10 hover:scale-105"
            }`}
            style={{ background: color }}
            aria-label={label}
          />
        ))}
        <div className="w-px h-5 bg-white/10 mx-0.5" />
        <button
          onClick={() => inputRef.current?.click()}
          className={`cursor-pointer size-6 rounded-full ring-1 transition-all grid place-items-center hover:scale-105 ${
            isCustom ? "ring-white/60" : "ring-white/10"
          }`}
          style={isCustom ? { background: current } : undefined}
          aria-label="Pick custom color"
        >
          {!isCustom && <span className="text-xs text-muted-foreground leading-none pointer-events-none">+</span>}
        </button>
      </div>
      <input
        ref={inputRef}
        type="color"
        value={current.startsWith('#') ? current : '#19b7a6'}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
        <span className="size-3 rounded-full" style={{ background: current }} />
        {current}
      </div>
    </div>
  );
}
