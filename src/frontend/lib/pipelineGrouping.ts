export interface GroupableEpisode {
  showId: string;
  showTitle: string;
}

export interface ShowGroup<T extends GroupableEpisode> {
  showId: string;
  showTitle: string;
  items: T[];
}

/** Group episodes by show, preserving a stable show ordering. */
export function groupByShow<T extends GroupableEpisode>(items: T[]): ShowGroup<T>[] {
  const map = new Map<string, ShowGroup<T>>();
  for (const item of items) {
    const existing = map.get(item.showId);
    if (existing) {
      existing.items.push(item);
    } else {
      map.set(item.showId, {
        showId: item.showId,
        showTitle: item.showTitle,
        items: [item],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.showTitle.localeCompare(b.showTitle));
}
