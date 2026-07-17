import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon, Undo2Icon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Input } from "@frontend/components/ui/input";
import { Button } from "@frontend/components/ui/button";
import { ColorDock } from "./ColorDock";
import { FieldRow } from "./SettingsShared";
import { THEME_DEFAULTS } from "@frontend/lib/theme";

const FONT_SIZE_OPTIONS = [
  { value: "0.5rem", label: "8px" },
  { value: "0.625rem", label: "10px" },
  { value: "0.6875rem", label: "11px" },
  { value: "0.75rem", label: "12px" },
  { value: "0.8125rem", label: "13px" },
  { value: "0.875rem", label: "14px" },
  { value: "0.9375rem", label: "15px" },
  { value: "1rem", label: "16px" },
  { value: "1.0625rem", label: "17px" },
  { value: "1.125rem", label: "18px" },
  { value: "1.25rem", label: "20px" },
  { value: "1.5rem", label: "24px" },
];

const DISPLAY_FONTS = [
  { value: '"Barlow Condensed", "Archivo Expanded", ui-sans-serif, sans-serif', label: "Barlow Condensed" },
  { value: '"Archivo Expanded", ui-sans-serif, sans-serif', label: "Archivo Expanded" },
  { value: '"Roboto Condensed", ui-sans-serif, sans-serif', label: "Roboto Condensed" },
  { value: '"Oswald", ui-sans-serif, sans-serif', label: "Oswald" },
  { value: "__custom__", label: "Custom \u2026" },
];

const SANS_FONTS = [
  { value: '"Inter", ui-sans-serif, sans-serif', label: "Inter" },
  { value: '"Roboto", ui-sans-serif, sans-serif', label: "Roboto" },
  { value: '"Open Sans", ui-sans-serif, sans-serif', label: "Open Sans" },
  { value: '"Noto Sans", ui-sans-serif, sans-serif', label: "Noto Sans" },
  { value: 'ui-sans-serif, sans-serif', label: "System UI" },
  { value: "__custom__", label: "Custom \u2026" },
];

const MONO_FONTS = [
  { value: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace', label: "JetBrains Mono" },
  { value: '"IBM Plex Mono", ui-monospace, monospace', label: "IBM Plex Mono" },
  { value: '"Fira Code", ui-monospace, monospace', label: "Fira Code" },
  { value: '"Source Code Pro", ui-monospace, monospace', label: "Source Code Pro" },
  { value: 'ui-monospace, monospace', label: "System Mono" },
  { value: "__custom__", label: "Custom \u2026" },
];

const RESET_KEYS: Record<string, (keyof typeof THEME_DEFAULTS)[]> = {
  colors: ["background", "foreground", "surfaceGlass", "card", "cardForeground", "popover", "popoverForeground", "mutedForeground", "border", "input"],
  typography: ["fontDisplay", "fontSans", "fontMono", "fontSizeCaption", "fontSizeSub", "fontSizeSm", "fontSizeBase"],
  sizes: ["radius"],
};

function hexVal(val: string | undefined, fallback: string) {
  if (!val) return fallback;
  if (/^#[0-9a-fA-F]{6,8}$/.test(val)) return val;
  return fallback;
}

function fontSelectValue(value: string | undefined, options: { value: string; label: string }[]) {
  if (!value) return "__custom__";
  return options.some(o => o.value === value) ? value : "__custom__";
}

function Section({ title, description, defaultOpen = false, onReset, children }: {
  title: string; description?: string; defaultOpen?: boolean; onReset?: () => void; children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-left group flex-1 min-w-0"
        >
          {open ? <ChevronDownIcon className="size-3.5 text-muted-foreground shrink-0 mt-0.5" /> : <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />}
          <div>
            <h3 className="font-display text-base font-semibold tracking-wide text-white/90">{title}</h3>
            {description && <p className="text-muted-foreground text-xs mt-0.5">{description}</p>}
          </div>
        </button>
        {onReset && (
          <Button variant="ghost" size="sm" onClick={onReset} className="shrink-0 text-muted-foreground hover:text-foreground">
            <Undo2Icon className="size-3.5 mr-1" />
            Reset
          </Button>
        )}
      </div>
      {open && <div className="mt-5 space-y-5">{children}</div>}
    </div>
  );
}

function ColorField({ label, description, value, fallback, onChange }: {
  label: string; description: string; value: string | undefined; fallback: string; onChange: (v: string) => void;
}) {
  return (
    <FieldRow label={label} description={description}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={hexVal(value, fallback)}
          onChange={e => onChange(e.target.value)}
          className="size-8 rounded-md cursor-pointer border border-white/10"
        />
        <span className="font-mono text-xs text-muted-foreground">{value || fallback}</span>
      </div>
    </FieldRow>
  );
}

function FontFamilySelect({ value, onChange, options, defaultValue }: {
  value: string | undefined; onChange: (v: string) => void; options: { value: string; label: string }[]; defaultValue: string;
}) {
  const [custom, setCustom] = React.useState(value && !options.some(o => o.value === value) ? value : "");

  if (value && !options.some(o => o.value === value) && !custom) {
    setCustom(value);
  }

  const selected = fontSelectValue(value, options);

  return (
    <div className="space-y-2">
      <Select value={selected} onValueChange={v => { if (v !== "__custom__") { setCustom(""); onChange(v); } }}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(o => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected === "__custom__" && (
        <Input
          value={custom}
          onChange={e => { setCustom(e.target.value); onChange(e.target.value || defaultValue); }}
          placeholder="font-family value, e.g. 'My Font', sans-serif"
          className="font-mono h-8 text-xs"
        />
      )}
    </div>
  );
}

export function AppearanceTab({ theme, accent, updateTheme, setAccent }: {
  theme: any; accent: string; updateTheme: (updates: Record<string, any>) => void; setAccent: (c: string) => void;
}) {
  return (
    <>
      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Accent Theme</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Choose the accent color used throughout the interface</p>
        </div>
        <ColorDock current={accent} onChange={(color) => { setAccent(color); }} />
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <Section
          title="Colors"
          description="Adjust the base color scheme"
          defaultOpen
          onReset={() => {
            const keys = RESET_KEYS.colors!;
            const vals: Record<string, string> = {};
            for (const k of keys) vals[k] = THEME_DEFAULTS[k];
            updateTheme(vals);
          }}
        >
          <ColorField label="Background" description="Base background color of the interface" value={theme.background} fallback="#0b0e1a" onChange={v => updateTheme({ background: v })} />
          <ColorField label="Foreground" description="Primary text color" value={theme.foreground} fallback="#f0f2f6" onChange={v => updateTheme({ foreground: v })} />
          <ColorField label="Surface" description="Card and panel background" value={theme.surfaceGlass} fallback="#181c2e" onChange={v => updateTheme({ surfaceGlass: v })} />
          <ColorField label="Card" description="Elevated surface background" value={theme.card} fallback="#131724" onChange={v => updateTheme({ card: v })} />
          <ColorField label="Card Foreground" description="Text on card surfaces" value={theme.cardForeground} fallback="#f0f2f6" onChange={v => updateTheme({ cardForeground: v })} />
          <ColorField label="Popover" description="Dropdown and popover background" value={theme.popover} fallback="#131724" onChange={v => updateTheme({ popover: v })} />
          <ColorField label="Muted Foreground" description="Secondary / muted text color" value={theme.mutedForeground} fallback="#8b8fa3" onChange={v => updateTheme({ mutedForeground: v })} />
          <ColorField label="Border" description="Default border color" value={theme.border} fallback="#ffffff1a" onChange={v => updateTheme({ border: v })} />
          <ColorField label="Input" description="Form input border color" value={theme.input} fallback="#ffffff1f" onChange={v => updateTheme({ input: v })} />
        </Section>
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <Section
          title="Typography"
          description="Control fonts and text sizing"
          defaultOpen
          onReset={() => {
            const keys = RESET_KEYS.typography!;
            const vals: Record<string, string> = {};
            for (const k of keys) vals[k] = THEME_DEFAULTS[k];
            updateTheme(vals);
          }}
        >
          <FieldRow label="Display Font" description="Font family for headings and titles">
            <FontFamilySelect value={theme.fontDisplay} onChange={v => updateTheme({ fontDisplay: v })} options={DISPLAY_FONTS} defaultValue={THEME_DEFAULTS.fontDisplay} />
          </FieldRow>
          <FieldRow label="Sans Font" description="Font family for body text">
            <FontFamilySelect value={theme.fontSans} onChange={v => updateTheme({ fontSans: v })} options={SANS_FONTS} defaultValue={THEME_DEFAULTS.fontSans} />
          </FieldRow>
          <FieldRow label="Mono Font" description="Font family for monospace / code text">
            <FontFamilySelect value={theme.fontMono} onChange={v => updateTheme({ fontMono: v })} options={MONO_FONTS} defaultValue={THEME_DEFAULTS.fontMono} />
          </FieldRow>
          <div className="border-t border-white/5 pt-5 space-y-5">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Text Sizes</p>
            <FieldRow label="Caption" description="Small labels and auxiliary text">
              <Select value={theme.fontSizeCaption || "0.75rem"} onValueChange={v => updateTheme({ fontSizeCaption: v })}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>{FONT_SIZE_OPTIONS.map(o => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}</SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Sub" description="Secondary body text">
              <Select value={theme.fontSizeSub || "0.8125rem"} onValueChange={v => updateTheme({ fontSizeSub: v })}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>{FONT_SIZE_OPTIONS.map(o => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}</SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Small" description="Compact body text">
              <Select value={theme.fontSizeSm || "0.9375rem"} onValueChange={v => updateTheme({ fontSizeSm: v })}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>{FONT_SIZE_OPTIONS.map(o => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}</SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Base" description="Standard body text">
              <Select value={theme.fontSizeBase || "1rem"} onValueChange={v => updateTheme({ fontSizeBase: v })}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>{FONT_SIZE_OPTIONS.map(o => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}</SelectContent>
              </Select>
            </FieldRow>
          </div>
        </Section>
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <Section
          title="Sizes & Spacing"
          description="Adjust the density and sizing of UI elements"
          defaultOpen
          onReset={() => updateTheme({ radius: THEME_DEFAULTS.radius })}
        >
          <FieldRow label="Card Radius" description="Border radius on panels and cards">
            <Select value={theme.radius || "0.625rem"} onValueChange={v => updateTheme({ radius: v })}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0.125rem">2px</SelectItem>
                <SelectItem value="0.25rem">4px</SelectItem>
                <SelectItem value="0.375rem">6px</SelectItem>
                <SelectItem value="0.5rem">8px</SelectItem>
                <SelectItem value="0.625rem">10px</SelectItem>
                <SelectItem value="0.75rem">12px</SelectItem>
                <SelectItem value="1rem">16px</SelectItem>
                <SelectItem value="1.25rem">20px</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Element Radius" description="Border radius on buttons and inputs (derived from card radius)">
            <div className="flex items-center gap-2 h-9">
              <div className="flex-1 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1 text-muted-foreground font-mono text-xs">
                {theme.radius ? `calc(${theme.radius} - 2px)` : "calc(0.625rem - 2px)"}
              </div>
            </div>
          </FieldRow>
        </Section>
      </GlassPanel>
    </>
  );
}
