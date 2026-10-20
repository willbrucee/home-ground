// Plain-English names for where each pin landed on the Full time screen ("near Lyon, France").


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
