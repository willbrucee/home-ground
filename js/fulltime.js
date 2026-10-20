// The Full time screen's moving parts: a flat world map of the day's five shots, and plain-English
// names for where each pin landed ("near Lyon, France").
import { greatCircle } from "./geo.js";
import { sportIcon } from "./sporticons.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── where did the pin land? ─────────────────────────────
// data/places.tsv: every town of 15,000+ people (GeoNames, CC BY 4.0), biggest first.
let places = null;
export async function loadPlaces() {
  if (places) return places;
  try {
    const text = await (await fetch("data/places.tsv")).text();
    places = text.split("\n").filter((l) => l && l[0] !== "#").map((l) => {
      const [n, cc, lat, lng] = l.split("\t");
      return { n, cc, lat: +lat, lng: +lng };
    });
  } catch { places = []; }
  return places;
}

const regionName = (() => {
  try { const d = new Intl.DisplayNames(["en"], { type: "region" }); return (cc) => { try { return d.of(cc); } catch { return cc; } }; }
  catch { return (cc) => cc; }
})();

// Fast flat-earth distance; fine for "which town is closest" within a few hundred km.
function approxKm(a, b) {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), y = b.lat - a.lat;
  return Math.hypot(x, y) * 111.2;
}

// Ray casting: is [lng, lat] inside this (Multi)Polygon?
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inShape(pt, geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  return polys.some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((hole) => inRing(pt, hole)));
}

// "near Lyon, France" (a town within 150 km), else "in France", else "in the open ocean".
// Among the towns close to the nearest one, the biggest wins, so it says "near Lyon", not a suburb.
export function describeSpot(p, countries) {
  if (!p) return "";
  let best = null, bestKm = Infinity;
  for (const pl of places || []) {
    if (Math.abs(pl.lat - p.lat) > 1.5) continue; // quick reject (150 km is ~1.35° of latitude)
    const km = approxKm(p, pl);
    if (km < bestKm) { bestKm = km; best = pl; }
  }
  if (best && bestKm <= 150) {
    const reach = Math.max(bestKm * 1.5, bestKm + 12);
    const big = (places || []).find((pl) => Math.abs(pl.lat - p.lat) < 1.5 && approxKm(p, pl) <= reach); // list is biggest first
    const pick = big || best;
    return `near ${pick.n}, ${regionName(pick.cc)}`;
  }
  const country = countries.find((f) => inShape([p.lng, p.lat], f.geometry));
  return country ? `in ${country.properties.name}` : "in the open ocean";
}

// ── the map ─────────────────────────────────────────────
// Equal Earth projection: a modern world map where every country keeps its true size.
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
function project([lng, lat]) {
  const l = (lng * Math.PI) / 180, t = Math.asin(M * Math.sin((lat * Math.PI) / 180));
  const t2 = t * t, t6 = t2 * t2 * t2;
  const x = (2 * Math.sqrt(3) * l * Math.cos(t)) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1));
  const y = A4 * t6 * t2 * t + A3 * t6 * t + A2 * t2 * t + A1 * t;
  return [x * 100, -y * 100]; // SVG units: the world is about 540 wide and 260 tall
}

// Country outlines as one SVG path, thinned to what's visible at this size. Built once.
let landPath = null;
function land(countries) {
  if (landPath) return landPath;
  const parts = [];
  for (const f of countries) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      let d = "", last = null;
      for (const c of ring) {
        const [x, y] = project(c);
        if (last && Math.abs(x - last[0]) + Math.abs(y - last[1]) < 0.35) continue;
        d += `${d ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
        last = [x, y];
      }
      if (d.length > 30) parts.push(d + "Z");
    }
  }
  return (landPath = parts.join(""));
}

// The guess: a chalk ball with the round's sport drawn on it (a nested <svg> sizes the icon).
const ballSvg = (x, y, r, sport) =>
  `<g class="ft-ball"><circle cx="${x}" cy="${y}" r="${r}"/>${sportIcon(sport, { pin: true })
    .replace("<svg ", `<svg x="${x - r * 0.7}" y="${y - r * 0.7}" width="${r * 1.4}" height="${r * 1.4}" `)}</g>`;
const flagSvg = (x, y, s, color) =>
  `<g class="ft-flag" transform="translate(${x} ${y}) scale(${s})" style="--c:${color}"><path d="M0 0V-14" class="pole"/><path d="M0 -14h10l-3 3.5 3 3.5H0z" class="cloth"/><circle r="2"/></g>`;

// rounds: [{ guess:{lat,lng}|null, answer:{lat,lng}, color, sport, pts }]
export function worldMapHtml(rounds, countries, widthPx, heightPx) {
  const pts = rounds.flatMap((r) => [r.answer, r.guess].filter(Boolean)).map((p) => project([p.lng, p.lat]));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // Frame every pin with some room, never tighter than a fifth of the world, in the panel's shape.
  const aspect = widthPx && heightPx ? widthPx / heightPx : 16 / 9;
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let w = Math.max(x1 - x0, 110) * 1.3, h = Math.max(y1 - y0, 40) * 1.4;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  if (w > 560) { w = 560; h = w / aspect; } // never wider than the whole world
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const vb = [cx - w / 2, cy - h / 2, w, h];
  const k = w / Math.max(280, widthPx); // SVG units per screen pixel, so markers stay the same size on screen
  const arcs = rounds.map((r, i) => {
    if (!r.guess) return "";
    const d = greatCircle(r.guess, r.answer, 96).map((c, j) => `${j ? "L" : "M"}${project(c).map((v) => v.toFixed(2)).join(" ")}`).join("");
    return `<path class="ft-arc" d="${d}" pathLength="1" style="--c:${r.color};--i:${i};stroke-width:${(3 * k).toFixed(3)}"/>`;
  }).join("");
  const marks = rounds.map((r, i) => {
    const [ax, ay] = project([r.answer.lng, r.answer.lat]);
    const g = r.guess ? project([r.guess.lng, r.guess.lat]) : null;
    return `<g class="ft-marks" style="--i:${i}">${g ? ballSvg(g[0], g[1], 9 * k, r.sport) : ""}${flagSvg(ax, ay, 1.6 * k, r.color)}
      <text x="${ax + 4 * k}" y="${ay - 26 * k}" font-size="${13 * k}" class="ft-num">${i + 1}</text></g>`;
  }).join("");
  return `<svg class="ft-map" viewBox="${vb.map((v) => v.toFixed(1)).join(" ")}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Map of today's five shots">
    <rect x="-400" y="-300" width="800" height="600" class="ft-sea"/>
    <path class="ft-land" d="${land(countries)}" style="stroke-width:${(1 * k).toFixed(3)}"/>
    ${arcs}${marks}
  </svg>`;
}
