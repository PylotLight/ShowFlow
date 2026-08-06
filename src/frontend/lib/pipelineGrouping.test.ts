import { test, expect } from "bun:test";
import { groupByShow } from "./pipelineGrouping";

test("groups episodes by show", () => {
  const eps = [
    { showId: "a", showTitle: "Alpha", seasonNumber: 1, episodeNumber: 1 },
    { showId: "b", showTitle: "Beta", seasonNumber: 1, episodeNumber: 1 },
    { showId: "a", showTitle: "Alpha", seasonNumber: 1, episodeNumber: 2 },
  ];
  const groups = groupByShow(eps);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.showId).toBe("a");
  expect(groups[0]!.items).toHaveLength(2);
  expect(groups[1]!.showId).toBe("b");
  expect(groups[0]!.items.map(e => e.episodeNumber)).toEqual([1, 2]);
});

test("returns empty for empty input", () => {
  expect(groupByShow([])).toEqual([]);
});
