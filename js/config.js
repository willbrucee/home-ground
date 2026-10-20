// Settings you may want to change, kept in one place.

// Esri basemaps work without a key for development and small non-commercial use.
// For a public launch, create a free ArcGIS Location Platform account and paste the key here.
export const ESRI_API_KEY = "";

// "globe" shows a 3D globe when zoomed out (it flattens as you zoom in).
// "mercator" is a flat map. You can also force flat with ?flat at the end of the URL.
export const PROJECTION = "globe";

export const ROUNDS = 5;

// Day 1 of the daily puzzle. Changing this changes every future puzzle, so leave it alone once live.
export const EPOCH = { year: 2026, month: 1, day: 1 };

// Which difficulty each round uses (1 = household name, 2 = well known, 3 = fans will know).
// Mostly household names, with a couple of harder ones.
export const ROUND_DIFFICULTY = [1, 1, 1, 2, 2];

const esriTiles = (service) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}` +
  (ESRI_API_KEY ? `?token=${ESRI_API_KEY}` : "");

// Esri World Imagery: satellite photos with no labels (no city, country or road names).
// The attribution line is required by Esri's terms and is shown on the map.
export const SATELLITE = {
  tiles: esriTiles("World_Imagery"),
  maxzoom: 18,
  attribution: "Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
};
