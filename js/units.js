// Distances are always stored and scored in km. These helpers only change how they're shown,
// so switching units can never change a score or a tier.

const KM_TO_MI = 0.621371;
const KEY = "hg:units";

let unit = "km";
try { if (JSON.parse(localStorage.getItem(KEY)) === "mi") unit = "mi"; } catch {} // storage can be blocked

export const getUnit = () => unit;

export function toggleUnit() {
  unit = unit === "km" ? "mi" : "km";
  try { localStorage.setItem(KEY, JSON.stringify(unit)); } catch {}
  return unit;
}

// 1234.5 km → "1,235" (or "767" in miles). Whole numbers with thousands separators.
export function formatNumber(km) {
  return Math.round(unit === "mi" ? km * KM_TO_MI : km).toLocaleString();
}

// 1234.5 km → "1,235 km" / "767 mi"
export function formatDistance(km) {
  return `${formatNumber(km)} ${unit}`;
}
