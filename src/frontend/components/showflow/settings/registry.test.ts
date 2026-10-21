import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SETTINGS_REGISTRY, TAB_ENTRIES, findSetting, normalize, searchSettings, settingPath } from "./registry";
import { SETTINGS_TABS } from "./tabs";

const top = (q: string) => searchSettings(q)[0]?.entry.id;
const ids = (q: string, n = 5) => searchSettings(q).slice(0, n).map(r => r.entry.id);

describe("settings registry", () => {
  test("ids are unique and namespaced by tab", () => {
    const seen = new Set<string>();
    for (const e of SETTINGS_REGISTRY) {
      expect(seen.has(e.id)).toBe(false);
      seen.add(e.id);
      expect(e.id.startsWith(`${e.tab}.`)).toBe(true);
    }
  });

  test("every entry points at a real tab and has text to match", () => {
    const tabs = new Set(SETTINGS_TABS.map(t => t.id));
    for (const e of SETTINGS_REGISTRY) {
      expect(tabs.has(e.tab)).toBe(true);
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("every settings tab has at least one entry", () => {
    for (const t of SETTINGS_TABS) {
      expect(SETTINGS_REGISTRY.some(e => e.tab === t.id)).toBe(true);
    }
  });

  test("anchors and fallbacks exist as data-setting in the components", () => {
    // Read every .tsx under components/showflow and collect literal
    // data-setting / settingId values, so a renamed row fails here instead of
    // a search result silently scrolling nowhere.
    const root = join(import.meta.dir, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx")) files.push(p);
      }
    };
    walk(root);
    const src = files.map(f => readFileSync(f, "utf8")).join("\n");
    const declared = new Set([...src.matchAll(/(?:data-setting|settingId)=(?:\{)?"([^"]+)"/g)].map(m => m[1]));
    const missing: string[] = [];
    for (const e of SETTINGS_REGISTRY) {
      const targets = [e.dynamic ? null : (e.anchor ?? e.id), e.fallback].filter(Boolean) as string[];
      for (const t of targets) if (!declared.has(t)) missing.push(`${e.id} -> ${t}`);
      if (e.dynamic) expect(e.fallback).toBeTruthy();
    }
    // Dynamic task rows render data-setting={`tasks.${task.name}`}.
    expect(src).toContain("data-setting={`tasks.${task.name}`}");
    expect(missing).toEqual([]);
  });

  test("findSetting resolves rows and tabs", () => {
    expect(findSetting("general.dry-run")?.tab).toBe("general");
    expect(findSetting("tab:backup")?.tab).toBe("backup");
    expect(findSetting("nope")).toBeUndefined();
    expect(TAB_ENTRIES.length).toBe(SETTINGS_TABS.length);
  });
});

describe("searchSettings", () => {
  test("empty / whitespace query returns nothing", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  test("exact label wins", () => {
    expect(top("dry run")).toBe("general.dry-run");
    expect(top("Watch folder")).toBe("downloads.watch-folder");
    expect(top("plex token")).toBe("connect.plex-token");
  });

  test("case, punctuation and accents are ignored", () => {
    expect(top("DRY-RUN")).toBe("general.dry-run");
    expect(normalize("Écran: Ü-ber")).toBe("ecran u ber");
  });

  test("prefix of a label word matches", () => {
    expect(top("concur")).toBe("downloads.concurrent-downloads");
    expect(ids("timez")).toContain("general.fallback-timezone");
  });

  test("keywords / synonyms match", () => {
    expect(top("discord")).toBe("connect.notifications");
    expect(ids("4k")).toContain("quality.resolution-target");
    expect(ids("hevc")).toContain("quality.terms");
    expect(ids("debounce")).toContain("connect.batch-window");
    expect(ids("colour")).toContain("appearance.accent");
    expect(ids("instant")).toContain("general.update-mode");
  });

  test("all tokens must match (AND), across label + context", () => {
    // "api key" alone matches lots; adding "jellyfin" narrows to Jellyfin rows.
    const r = ids("jellyfin api key");
    expect(r[0]).toBe("integrations.jellyfin-api-key");
    expect(searchSettings("jellyfin zzzz")).toEqual([]);
  });

  test("description words match with lower weight than labels", () => {
    // "airtimes" only appears in a description.
    expect(ids("airtimes")).toContain("general.fallback-timezone");
    // A label hit outranks a description-only hit.
    const r = searchSettings("folder");
    expect(r[0]!.entry.label.toLowerCase()).toContain("folder");
  });

  test("mid-word fallback for 3+ chars", () => {
    expect(ids("box")).toContain("downloads.torbox-api-key");
    expect(searchSettings("bx").some(r => r.entry.id === "downloads.torbox-api-key")).toBe(false);
  });

  test("tab names are searchable but rank below matching rows", () => {
    expect(ids("backup")).toContain("tab:backup");
    const r = searchSettings("naming");
    expect(r.some(x => x.entry.id === "tab:naming")).toBe(true);
    expect(searchSettings("naming", { includeTabs: false }).some(x => x.entry.id.startsWith("tab:"))).toBe(false);
  });

  test("ties keep registry (page) order and limit applies", () => {
    const r = searchSettings("key", { limit: 3 });
    expect(r.length).toBe(3);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.score).toBeGreaterThanOrEqual(r[i]!.score);
  });

  test("breadcrumb path names tab and section", () => {
    expect(settingPath(findSetting("downloads.watch-folder")!)).toBe("Downloads");
    expect(settingPath(findSetting("general.dry-run")!)).toBe("General › Defaults");
    expect(settingPath(findSetting("tab:debug")!)).toBe("Settings");
  });

  test("no match returns empty", () => {
    expect(searchSettings("qwertyuiop")).toEqual([]);
  });
});
