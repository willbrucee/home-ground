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

// Which difficulty each round uses (1 = household name, 3 = deep cut).
export const ROUND_DIFFICULTY = [1, 1, 2, 2, 3];

const esriTiles = (service) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}` +
  (ESRI_API_KEY ? `?token=${ESRI_API_KEY}` : "");

// Both basemaps are label-free: no city, country or road names.
export const BASEMAPS = {
  satellite: {
    label: "Satellite",
    tiles: esriTiles("World_Imagery"),
    maxzoom: 18,
    attribution: "Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
  relief: {
    label: "Relief",
    tiles: esriTiles("World_Physical_Map"),
    maxzoom: 8, // Esri only publishes this one to zoom 8; MapLibre stretches it beyond that.
    attribution: "Powered by Esri · Source: US National Park Service",
  },
};
export const DEFAULT_BASEMAP = "satellite";
