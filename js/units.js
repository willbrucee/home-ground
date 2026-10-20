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

// ── Sports units ──────────────────────────────────────────────────────────────
// "about 74 marathons": the same distance in things a sports fan can picture.
// Lengths in km, from the official dimensions.
export const SPORTS_UNITS = [
  { key: "pool", km: 0.05, one: "Olympic pool length", many: "Olympic pool lengths" }, // 50 m
  { key: "court", km: 0.028, one: "basketball court", many: "basketball courts" },     // FIBA: 28 m long
  { key: "pitch", km: 0.105, one: "football pitch", many: "football pitches" },        // 105 m, the FIFA-recommended length
  { key: "lap", km: 0.4, one: "lap of a running track", many: "laps of a running track" }, // 400 m
  { key: "silverstone", km: 5.891, one: "lap of Silverstone", many: "laps of Silverstone" }, // F1 circuit, 5.891 km
  { key: "marathon", km: 42.195, one: "marathon", many: "marathons" },                 // 42.195 km
  { key: "f1race", km: 305, one: "Formula 1 race", many: "Formula 1 races" },           // races are set at just over 305 km
];

// Picks a unit that gives a readable number (between 2 and 5,000), at random so it varies.
// Returns the unit's key, so the same choice can be shown again later (e.g. on the scorecard).
export function pickSportsUnit(km) {
  const fits = SPORTS_UNITS.filter((u) => km / u.km >= 2 && km / u.km <= 5000);
  const pool = fits.length ? fits : [km > 1000 ? SPORTS_UNITS.at(-1) : SPORTS_UNITS[0]];
  return pool[Math.floor(Math.random() * pool.length)].key;
}

// The biggest unit that still gives at least 2 (for totals, so the share text doesn't change between copies).
export function biggestSportsUnit(km) {
  return ([...SPORTS_UNITS].sort((a, b) => b.km - a.km).find((u) => km / u.km >= 2) || SPORTS_UNITS[0]).key;
}

// "about 74 marathons". The count doesn't depend on km/miles; it's the same distance either way.
export function sportsDistance(km, key) {
  const unit = SPORTS_UNITS.find((u) => u.key === key);
  if (!unit || km <= 0) return "";
  const n = km / unit.km;
  // round to 2 significant figures above 100 (4,137 → 4,100), whole numbers below
  const rounded = n >= 100 ? Number(n.toPrecision(2)) : Math.max(1, Math.round(n));
  return `about ${rounded.toLocaleString()} ${rounded === 1 ? unit.one : unit.many}`;
}
