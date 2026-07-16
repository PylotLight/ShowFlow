import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { Switch } from "@frontend/components/ui/switch";
import { ColorDock } from "./ColorDock";
import { FieldRow } from "./SettingsShared";

export function AppearanceTab({ theme, accent, updateTheme, setAccent }: {
  theme: any;
  accent: string;
  updateTheme: (updates: Record<string, any>) => void;
  setAccent: (c: string) => void;
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
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Colors</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Adjust the base color scheme</p>
        </div>
        <FieldRow label="Background" description="Base background color of the interface">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={theme.bgBase || "#08080d"}
              onChange={e => updateTheme({ bgBase: e.target.value })}
              className="size-8 rounded-md cursor-pointer border border-white/10"
            />
            <span className="font-mono text-xs text-muted-foreground">{theme.bgBase || "#08080d"}</span>
          </div>
        </FieldRow>
        <FieldRow label="Surface" description="Card and panel background color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={theme.bgSurface || "#0d0d14"}
              onChange={e => updateTheme({ bgSurface: e.target.value })}
              className="size-8 rounded-md cursor-pointer border border-white/10"
            />
            <span className="font-mono text-xs text-muted-foreground">{theme.bgSurface || "#0d0d14"}</span>
          </div>
        </FieldRow>
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Typography</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Control font size and scale across the interface</p>
        </div>
        <FieldRow label="Font Scaling" description="Global font size multiplier">
          <Select
            value={String(theme.fontScaling || 1)}
            onValueChange={v => updateTheme({ fontScaling: parseFloat(v) })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0.75">75%</SelectItem>
              <SelectItem value="0.875">87.5%</SelectItem>
              <SelectItem value="1">100%</SelectItem>
              <SelectItem value="1.125">112.5%</SelectItem>
              <SelectItem value="1.25">125%</SelectItem>
              <SelectItem value="1.5">150%</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Mono Font" description="Use system monospace font for UI labels">
          <Switch
            checked={theme.monoFont ?? false}
            onCheckedChange={v => updateTheme({ monoFont: v })}
          />
        </FieldRow>
        <FieldRow label="Custom Font" description="Google Font name (e.g. Inter, JetBrains Mono)">
          <input
            type="text"
            value={theme.customFont || ""}
            onChange={e => updateTheme({ customFont: e.target.value || undefined })}
            placeholder="Inter"
            className="flex-1 font-mono h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          />
        </FieldRow>
      </GlassPanel>

      <GlassPanel className="p-6 space-y-5">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Sizes &amp; Spacing</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Adjust the density and sizing of UI elements</p>
        </div>
        <FieldRow label="Card Radius" description="Border radius on panels and cards">
          <Select
            value={String(theme.cardRadius || 12)}
            onValueChange={v => updateTheme({ cardRadius: parseInt(v) })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="4">4px</SelectItem>
              <SelectItem value="8">8px</SelectItem>
              <SelectItem value="12">12px</SelectItem>
              <SelectItem value="16">16px</SelectItem>
              <SelectItem value="20">20px</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Element Radius" description="Border radius on buttons and inputs">
          <Select
            value={String(theme.elementRadius || 6)}
            onValueChange={v => updateTheme({ elementRadius: parseInt(v) })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2px</SelectItem>
              <SelectItem value="4">4px</SelectItem>
              <SelectItem value="6">6px</SelectItem>
              <SelectItem value="8">8px</SelectItem>
              <SelectItem value="12">12px</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      </GlassPanel>
    </>
  );
}
