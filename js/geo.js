// Small geography helpers. Points are { lat, lng } in degrees.

const EARTH_RADIUS_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Haversine formula: distance along the Earth's surface.
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Points along the great circle (shortest path over the globe) from a to b, as [lng, lat] pairs.
// Works by turning both points into 3D vectors and blending between them (spherical interpolation).
export function greatCircle(a, b, steps = 128) {
  const toVec = (p) => [Math.cos(rad(p.lat)) * Math.cos(rad(p.lng)), Math.cos(rad(p.lat)) * Math.sin(rad(p.lng)), Math.sin(rad(p.lat))];
  const va = toVec(a), vb = toVec(b);
  const angle = Math.acos(Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
  if (angle < 1e-9) return [[a.lng, a.lat], [b.lng, b.lat]];

  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wa = Math.sin((1 - t) * angle) / Math.sin(angle);
    const wb = Math.sin(t * angle) / Math.sin(angle);
    const x = wa * va[0] + wb * vb[0], y = wa * va[1] + wb * vb[1], z = wa * va[2] + wb * vb[2];
    out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return unwrap(out);
}

// Keeps longitudes continuous across the 180° line (e.g. 179 → 181 instead of 179 → -179),
// otherwise the line would shoot back across the whole map.
export function unwrap(coords) {
  for (let i = 1; i < coords.length; i++) {
    while (coords[i][0] - coords[i - 1][0] > 180) coords[i][0] -= 360;
    while (coords[i][0] - coords[i - 1][0] < -180) coords[i][0] += 360;
  }
  return coords;
}
