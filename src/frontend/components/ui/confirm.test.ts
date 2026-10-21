import { expect, test } from "bun:test";

import { isFilenameLike } from "./confirm";

test("isFilenameLike: long dotted release names", () => {
  expect(isFilenameLike("Dark.Matter.2024.S02E08.L.interconnessione.fondamentale.del.tutto.ITA.ENG.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-MeM.GP.mkv")).toBe(true);
  expect(isFilenameLike("Show.Name.S01E01.1080p.WEB-DL.mkv")).toBe(true);
});

test("isFilenameLike: prose and non-strings stay normal", () => {
  expect(isFilenameLike("They can be grabbed again on the next search.")).toBe(false);
  expect(isFilenameLike("Breaking Bad\nThe Wire")).toBe(false);
  expect(isFilenameLike("short.mkv")).toBe(false);
  expect(isFilenameLike(undefined)).toBe(false);
  expect(isFilenameLike(42)).toBe(false);
});
