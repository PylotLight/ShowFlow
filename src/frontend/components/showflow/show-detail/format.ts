import type { SeasonStat } from "./types";

export function formatMovieBytes(bytes: number | null): string {
  if (bytes == null) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** 8 channels → "7.1"; 6 → "5.1"; a bare count otherwise. */
export function channelsLabel(ch: number | null | undefined): string {
  if (ch == null) return "";
  const map: Record<number, string> = { 2: "2.0", 6: "5.1", 8: "7.1", 4: "4.0", 5: "5.0", 3: "3.0" };
  return map[ch] ?? `${ch}ch`;
}

/** ISO 639-2/T → short display code; unknown codes pass through upper-cased. */
export function langLabel(code: string): string {
  const map: Record<string, string> = {
    eng: "EN", jpn: "JA", zho: "ZH", chi: "ZH", fra: "FR", fre: "FR",
    spa: "ES", ger: "DE", deu: "DE", ita: "IT", rus: "RU", por: "PT",
    kor: "KO", hin: "HI", ara: "AR", dut: "NL", nld: "NL", pol: "PL",
    swe: "SV", dan: "DA", nor: "NO", nob: "NO", fin: "FI", tur: "TR",
    ces: "CS", cze: "CS", hun: "HU", ell: "EL", gre: "EL", heb: "HE",
    tha: "TH", vie: "VI", ind: "ID", ukr: "UK", rum: "RO", ron: "RO",
  };
  return map[code.toLowerCase()] ?? code.toUpperCase();
}

// Seasons display order: latest first, specials (season 0) last.
export function orderSeasons<T extends SeasonStat>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.seasonNumber === 0) return 1;
    if (b.seasonNumber === 0) return -1;
    return b.seasonNumber - a.seasonNumber;
  });
}

export function seasonLabel(n: number): string {
  return n === 0 ? "Specials" : `Season ${n}`;
}

// Pill / focus styles live in components/ui/pill so every page shares them.
export { focusRing, pillButton, pillButtonDanger, pillButtonPrimary, pillIconButton } from "@frontend/components/ui/pill";
