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
// "about 74 marathons": the same distance in things a sports fan can picture. The units live in
// data/facts.json (each with its official figure and source); this small list is only a fallback.
let UNITS = [
  { key: "pitch", sport: "Football", m: 105, one: "football pitch", many: "football pitches" },
  { key: "lap", sport: "Athletics", m: 400, one: "lap of a running track", many: "laps of a running track" },
  { key: "marathon", sport: "Athletics", m: 42195, one: "marathon", many: "marathons" },
  { key: "f1race", sport: "Formula 1", m: 305000, one: "Formula 1 race", many: "Formula 1 races" },
];
const RECENT_KEY = "hg:recentFacts", RECENT_MAX = 30; // skip units seen in the last few games

export async function loadFacts() {
  try {
    const res = await fetch("data/facts.json");
    if (res.ok) UNITS = (await res.json()).units;
  } catch {} // keep the fallback
}

const unitFor = (key) => UNITS.find((u) => u.key === key);
const countOf = (km, u) => (km * 1000) / u.m;
const readable = (n) => n >= 2 && n <= 5000;

function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
function remember(key) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...recent().filter((k) => k !== key)].slice(0, RECENT_MAX))); } catch {}
}

// Picks a unit that gives a readable number (2 to 5,000): from the round's sport if possible,
// never one already used this game (`used`), and not one seen recently unless nothing else fits.
// Returns the key, so the scorecard can show the same fact again.
export function pickSportsUnit(km, sport, used = []) {
  const fits = UNITS.filter((u) => readable(countOf(km, u)) && !used.includes(u.key));
  // the round's own sport gets more room (up to 100,000 NBA courts still reads fine)
  const own = UNITS.filter((u) => u.sport === sport && !used.includes(u.key) && countOf(km, u) >= 2 && countOf(km, u) <= 100000);
  if (!fits.length && !own.length) return "";
  const old = recent();
  const tiers = [
    own.filter((u) => !old.includes(u.key)),
    fits.filter((u) => !old.includes(u.key)),
    own,
    fits,
  ];
  const pool = tiers.find((t) => t.length);
  const pick = pool[Math.floor(Math.random() * pool.length)].key;
  remember(pick);
  return pick;
}

// The biggest unit that still gives at least 2 (for totals, so the share text doesn't change between copies).
export function biggestSportsUnit(km) {
  return ([...UNITS].sort((a, b) => b.m - a.m).find((u) => countOf(km, u) >= 2) || UNITS[0]).key;
}

// 28.65 m → "28.65 m" or "94 ft"; 5891 m → "5.89 km" or "3.66 mi". Follows the km/mi switch.
export function formatLength(m) {
  const trim = (n, d) => Number(n.toFixed(d)).toLocaleString();
  if (unit === "mi") {
    const ft = m * 3.28084;
    if (ft < 3) return `${trim(ft * 12, 1)} in`;
    if (ft < 2000) return `${trim(ft, ft < 10 ? 1 : 0)} ft`;
    return `${trim(m / 1609.344, 2)} mi`;
  }
  if (m < 1) return `${trim(m * 100, 1)} cm`;
  if (m < 1000) return `${trim(m, 2)} m`;
  return `${trim(m / 1000, 2)} km`;
}

// Rounds to something easy to read: 2 significant figures from 100 up (4,137 → 4,100).
const round2 = (n) => (n >= 100 ? Number(n.toPrecision(2)) : Math.max(1, Math.round(n)));

// "about 74 marathons (42.2 km each)". The count is the same in km or miles.
export function sportsDistance(km, key, { size = true } = {}) {
  const u = unitFor(key);
  if (!u || km <= 0) return "";
  const n = round2(countOf(km, u));
  return `about ${n.toLocaleString()} ${n === 1 ? u.one : u.many}${size ? ` (${formatLength(u.m)} each)` : ""}`;
}

// City-size fact: "Barcelona is about 20 km across: you were 7 Barcelonas away."
export function cityFact(km, city, radiusKm) {
  if (!city || !radiusKm || km <= 0) return "";
  const across = radiusKm * 2;
  const n = km / across;
  const size = `${city} is about ${formatDistance(across)} across`;
  if (n < 1) return `${size}: you were less than one ${city} away.`;
  const r = round2(n);
  return `${size}: you were ${r.toLocaleString()} ${city}${r === 1 ? "" : "s"} away.`;
}
