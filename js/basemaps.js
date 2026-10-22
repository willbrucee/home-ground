// The map's look: the sources and layers underneath everything the game draws (pins, arcs, highlights).
// None of them has labels, roads, place dots or grid lines.
//   satellite  Esri World Imagery (the current look)
//   sentinel   EOX Sentinel-2 cloudless 2020: brighter, cloud-free colour, at its best zoomed out
//   styled     a hand-made vector map (OpenFreeMap, OpenMapTiles layers): land, water, woods, parks and
//              country borders only, with soft hillshade from AWS Terrarium elevation tiles, in the palette
//   hybrid     Sentinel-2 when zoomed out, fading into the styled map as you zoom in to city scale
import { color } from "./palette.js";

const ESRI = "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const EOX = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg";
const OFM = "https://tiles.openfreemap.org/planet";
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export const ATTRIBUTION = {
  satellite: "Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  sentinel: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020)',
  styled: '© <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Elevation: Mapzen Terrarium (SRTM, GMTED, ETOPO1 and others)',
};

// "#ff9f43" + "#ffffff" at 0.3 → a palette colour lightened (or mixed with another), as hex
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

// The styled map's colours, all from the Sports day palette: cream land, sky-blue water, soft greens.
export function paletteColours() {
  const bg = color("--bg"), sky = color("--sky"), warm = color("--t-warm"), green = color("--secondary"), white = color("--surface");
  return {
    land: mix(bg, warm, 0.24), water: mix(sky, white, 0.12), deep: mix(sky, color("--text"), 0.18),
    wood: mix(bg, green, 0.42), grass: mix(bg, warm, 0.5), sand: mix(bg, color("--primary"), 0.25), ice: white,
    border: color("--muted"), shade: color("--text"), light: white,
  };
}

// The sky around the globe when zoomed out: a soft glow that fades away as you zoom in.
export function sky() {
  return {
    "sky-color": color("--sea"), "horizon-color": mix(color("--sky"), color("--surface"), 0.4), "fog-color": color("--sea"),
    "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.8, "fog-ground-blend": 0.9,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4, 0.6, 6, 0],
  };
}

function vectorLayers(c, { opacity = 1 } = {}) {
  const o = (v) => (opacity === 1 ? v : ["interpolate", ["linear"], ["zoom"], 4, 0, 6.5, v]); // fades in for the hybrid
  return [
    { id: "v-land", type: "background", paint: { "background-color": c.land, "background-opacity": o(1) } },
    { id: "v-cover", type: "fill", source: "ofm", "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "sand", "ice", "wetland", "farmland"]]],
      paint: { "fill-color": ["match", ["get", "class"], "wood", c.wood, "grass", c.grass, "wetland", c.grass, "farmland", c.land, "sand", c.sand, "ice", c.ice, c.land],
        "fill-opacity": o(0.9) } },
    { id: "v-park", type: "fill", source: "ofm", "source-layer": "park", paint: { "fill-color": c.grass, "fill-opacity": o(0.6) } },
    { id: "v-hillshade", type: "hillshade", source: "dem",
      paint: { "hillshade-shadow-color": c.shade, "hillshade-highlight-color": c.light, "hillshade-accent-color": c.shade,
        "hillshade-exaggeration": 0.55, "hillshade-illumination-direction": 315 } },
    { id: "v-water", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": c.water, "fill-opacity": o(1) } },
    { id: "v-river", type: "line", source: "ofm", "source-layer": "waterway", minzoom: 6, filter: ["==", ["get", "class"], "river"],
      paint: { "line-color": c.water, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 10, 2], "line-opacity": o(1) } },
    { id: "v-border", type: "line", source: "ofm", "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      layout: { "line-join": "round" },
      paint: { "line-color": c.border, "line-opacity": o(0.55), "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 1.2, 10, 1.8] } },
  ];
}

// { sources, layers, sky? } for one look. The game adds its own layers on top.
export function basemap(name) {
  const c = paletteColours();
  const raster = (url, attribution, extra = {}) => ({ type: "raster", tiles: [url], tileSize: 256, maxzoom: 10, attribution, ...extra });
  const vector = {
    ofm: { type: "vector", url: OFM, attribution: ATTRIBUTION.styled },
    dem: { type: "raster-dem", tiles: [TERRARIUM], tileSize: 256, encoding: "terrarium", maxzoom: 10 },
  };
  const ocean = (col) => ({ id: "ocean", type: "background", paint: { "background-color": col } });
  switch (name) {
    case "sentinel":
      return { sources: { base: raster(EOX, ATTRIBUTION.sentinel) }, layers: [ocean(color("--sea")), { id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0 } }], sky: sky() };
    case "styled":
      return { sources: vector, layers: [ocean(c.water), ...vectorLayers(c)], sky: sky() };
    case "hybrid":
      return {
        sources: { base: raster(EOX, ATTRIBUTION.sentinel), ...vector },
        layers: [ocean(c.deep), { id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0, "raster-saturation": 0.1 } },
          ...vectorLayers(c, { opacity: "fade" })],
        sky: sky(),
      };
    default:
      return { sources: { base: raster(ESRI, ATTRIBUTION.satellite) }, layers: [ocean(color("--sea")), { id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0 } }], sky: sky() };
  }
}
