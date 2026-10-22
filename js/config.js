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

// Sentinel-2 cloudless 2020 by EOX: bright, cloud-free satellite colour with no labels, roads or dots.
// Licence CC BY-NC-SA 4.0: free for this non-commercial site with the credit below (a commercial site would
// need EOX's licence). If EOX stops answering, the game falls back to Esri World Imagery.
export const SATELLITE = {
  tiles: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
  fallbackTiles: `https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}${key}`,
  // The sharpest tiles we ask for: zoom 10 shows a whole city and its suburbs, but individual roads
  // can't be made out (they'd be clues). The map never zooms past this.
  maxzoom: 10,
  attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020)',
};

// How far players can zoom in: city scale, no further (see SATELLITE.maxzoom).
export const MAP_MAX_ZOOM = 10;
