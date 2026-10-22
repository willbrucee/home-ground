// Settings you may want to change, kept in one place.

// Esri basemaps work without a key for development and small non-commercial use.
// For a public launch, create a free ArcGIS Location Platform account and paste the key here.
export const ESRI_API_KEY = "";

// "globe" shows a 3D globe when zoomed out (it flattens as you zoom in).
// "mercator" is a flat map. You can also force flat with ?flat at the end of the URL.
export const PROJECTION = "globe";

export const ROUNDS = 5;

// Seconds to place a pin each round. When time runs out, your pin is locked in; with no pin, the round scores 0.
export const ROUND_SECONDS = 25;

// Day 1 of the daily puzzle. Changing this changes every future puzzle, so leave it alone once live.
export const EPOCH = { year: 2026, month: 10, day: 21 }; // launch day: daily #1

// Which difficulty each round uses (1 = household name, 2 = well known, 3 = fans will know).
// The same shape every day: four household names, then one well-known name to finish. No 3s for now.
export const ROUND_DIFFICULTY = [1, 1, 1, 1, 2];

const key = ESRI_API_KEY ? `?token=${ESRI_API_KEY}` : "";

// Esri World Imagery: satellite photos with no labels (no city, country or road names).
// The attribution line is required by Esri's terms and is shown on the map.
export const SATELLITE = {
  // Esri's "clarity" host serves the same imagery over HTTP/2, so the browser can fetch dozens of
  // tiles at once. The classic host only speaks HTTP/1.1 (6 tiles at a time), which made zooming slow.
  tiles: `https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}${key}`,
  // used automatically if the clarity host stops answering
  fallbackTiles: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}${key}`,
  // The sharpest tiles we ask for: zoom 10 shows a whole city and its suburbs, but individual roads
  // can't be made out (they'd be clues). The map never zooms past this.
  maxzoom: 10,
  attribution: "Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
};

// How far players can zoom in: city scale, no further (see SATELLITE.maxzoom).
export const MAP_MAX_ZOOM = 10;
