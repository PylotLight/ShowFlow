import { expect, test } from "bun:test";
import { renderEpisodeName } from "../core/episode_naming";
import { sanitizeTitle } from "./sanitize_title";

test("sanitizeTitle removes colons without leaving a mangled 8.3 name", () => {
  const out = sanitizeTitle("HELL MODE: The Hardcore Gamer");
  expect(out).not.toContain(":");
  expect(out).toBe("HELL MODE The Hardcore Gamer");
});

test("sanitizeTitle collapses other illegal characters", () => {
  expect(sanitizeTitle('a<b>c"d/e\\f|g?h*i')).toBe("a b c d e f g h i");
});

test("sanitizeTitle trims and collapses runs of whitespace", () => {
  expect(sanitizeTitle("  Foo   :  Bar  ")).toBe("Foo Bar");
});

test("folder name matches the naming engine's title token (smart default)", () => {
  const title = "Frieren: Beyond Journey's End";
  const folder = sanitizeTitle(title);
  const filename = renderEpisodeName(
    {
      seriesTitle: title,
      episodes: [{ season: 1, episode: 1, title: "Something Beautiful" }],
    },
    "{Series Title} - S{season:00}E{episode:00}",
  );
  expect(folder).toBe("Frieren Beyond Journey's End");
  expect(filename.startsWith(`${folder} - S01E01`)).toBe(true);
});
