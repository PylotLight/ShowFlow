export function formatAirtime(airDate: string | null | undefined): string {
  if (!airDate || !airDate.includes("T")) return "";
  const d = new Date(airDate);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}