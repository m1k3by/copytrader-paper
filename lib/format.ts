// Duration as the dashboard shows it: "12 min", "5 h", "3 T.".
export function dur(ms: number | null) {
  if (ms === null) return "–";
  const min = ms / 6e4;
  if (min < 90) return `${Math.round(min)} min`;
  return min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} T.`;
}
