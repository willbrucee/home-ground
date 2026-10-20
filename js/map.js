// Everything to do with the map. The MapLibre map is created ONCE and reused for every round;
// rounds only change the data inside a few layers, which is what keeps it smooth.
import { BASEMAPS, DEFAULT_BASEMAP, PROJECTION } from "./config.js";
import { greatCircle } from "./geo.js";

const EMPTY = { type: "FeatureCollection", features: [] };
const HIDDEN_LINE = ["step", ["line-progress"], "rgba(0,0,0,0)", 0.5, "rgba(0,0,0,0)"];

// Ease-in-out: slow start, quick middle, slow finish.
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Population bands for the city dots, and the zoom level where each band appears.
const CITY_BANDS = [
  { id: "cities-xl", min: 3e6, max: Infinity, minzoom: 0 },
  { id: "cities-l", min: 1e6, max: 3e6, minzoom: 2.5 },
  { id: "cities-m", min: 3e5, max: 1e6, minzoom: 4 },
  { id: "cities-s", min: 1e5, max: 3e5, minzoom: 5.5 },
];

function buildStyle(projection, basemap) {
  const sources = {};
  const layers = [{ id: "ocean", type: "background", paint: { "background-color": "#0b2a3a" } }];

  // Plain land shapes and borders underneath the imagery. Normally the tiles cover them; if tiles
  // can't load (offline, blocked, or a page that doesn't allow outside images) the map still works.
  sources.land = { type: "geojson", data: "data/land.geojson" };
  sources.borders = { type: "geojson", data: "data/borders.geojson" };
  layers.push(
    { id: "land", type: "fill", source: "land", paint: { "fill-color": "#3b5444" } },
    { id: "borders", type: "line", source: "borders", paint: { "line-color": "#8fa898", "line-width": 0.6, "line-opacity": 0.6 } },
  );

  // One raster source + layer per basemap. Only the chosen one is visible.
  for (const [key, b] of Object.entries(BASEMAPS)) {
    sources[key] = { type: "raster", tiles: [b.tiles], tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
    layers.push({
      id: `base-${key}`, type: "raster", source: key,
      layout: { visibility: key === basemap ? "visible" : "none" },
      paint: { "raster-fade-duration": 200 },
    });
  }

  // Unlabelled city dots. Bigger cities appear first; smaller ones fade in as you zoom in.
  sources.cities = { type: "geojson", data: "data/cities.geojson" };
  for (const band of CITY_BANDS) {
    const size = (small, big) => ["interpolate", ["linear"], ["get", "p"], 1e5, small, 1e7, big]; // dot size by population
    layers.push({
      id: band.id, type: "circle", source: "cities",
      minzoom: band.minzoom,
      filter: ["all", [">=", ["get", "p"], band.min], ["<", ["get", "p"], band.max]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, size(1.6, 3.6), 6, size(2.6, 6.5), 11, size(3.2, 9)],
        "circle-color": "#fff6df",
        "circle-stroke-color": "#1a1a1a",
        "circle-stroke-width": 0.8,
        // Fade in over half a zoom level instead of popping in.
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], band.minzoom, 0, band.minzoom + 0.5, 0.72],
        "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], band.minzoom, 0, band.minzoom + 0.5, 0.45],
        "circle-pitch-alignment": "map", // dots lie flat on the globe's surface
      },
    });
  }

  // The result line, drawn as three stacked layers: a soft glow, a dark outline, then the coloured core.
  // lineMetrics lets us colour by "progress along the line" (0 at the guess, 1 at the answer),
  // which is how the line draws itself in: everything past the current progress is transparent.
  sources.arc = { type: "geojson", data: EMPTY, lineMetrics: true };
  const arcLayer = (id, paint) => ({
    id, type: "line", source: "arc",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-gradient": HIDDEN_LINE, ...paint },
  });
  layers.push(
    arcLayer("arc-glow", { "line-width": 14, "line-blur": 10, "line-opacity": 0.55 }),
    arcLayer("arc-casing", { "line-width": 6.5, "line-opacity": 0.55 }),
    arcLayer("arc-core", { "line-width": 3.5 }),
  );

  return {
    version: 8,
    projection: { type: projection },
    sources,
    layers,
  };
}

export function createMap(container, { onPick }) {
  const flat = PROJECTION === "mercator" || new URLSearchParams(location.search).has("flat");
  const rect = container.getBoundingClientRect();

  const map = new maplibregl.Map({
    container,
    style: buildStyle(flat ? "mercator" : "globe", DEFAULT_BASEMAP),
    center: [15, 25],
    zoom: fitWorldZoom(rect),
    minZoom: 0.3,
    maxZoom: 12,
    renderWorldCopies: true, // flat map: lets you keep panning east/west past the date line
    attributionControl: { compact: rect.width < 640 }, // full credit line on wide screens, an (i) button on phones
    dragRotate: false, // no tilting or spinning the map's north; keeps it simple for players
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
  });
  map.touchZoomRotate.disableRotation(); // two-finger pinch zooms but won't twist the map
  map.dragPan.enable({ linearity: 0.25, maxSpeed: 1600, deceleration: 2200 }); // gentle inertia when you let go
  map.scrollZoom.setWheelZoomRate(1 / 300); // slightly calmer mouse-wheel zoom
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  // A click gives the exact point. wrap() brings longitudes back into -180..180
  // (on the flat map you can click a "copy" of the world off to the side).
  map.on("click", (e) => {
    const { lat, lng } = e.lngLat.wrap();
    onPick({ lat, lng });
  });

  const ready = new Promise((resolve) => map.once("load", resolve));

  // If the imagery can't load, MapLibre would print an error for every tile. Having our own
  // error listener stops that. After a few failures we switch the imagery off and the game carries
  // on with the plain land map underneath.
  let tileFailures = 0, imageryOff = false;
  map.on("error", (e) => {
    if (!(e.sourceId in BASEMAPS)) { console.error(e.error || e); return; }
    if (++tileFailures < 6 || imageryOff) return;
    imageryOff = true;
    for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${k}`, "visibility", "none");
    document.dispatchEvent(new CustomEvent("imagery-unavailable"));
  });

  // Markers are plain HTML elements pinned to a map position. We create two and reuse them.
  const guessEl = document.createElement("div");
  guessEl.className = "pin pin-guess";
  const guessMarker = new maplibregl.Marker({ element: guessEl });
  // The answer pin has an inner head (which does the bounce) and a ring (which pulses).
  // We animate these children, never the marker element itself: MapLibre positions markers with
  // a CSS transform on that element, and animating it too would fight MapLibre and make it jitter.
  const answerEl = document.createElement("div");
  answerEl.className = "pin-answer";
  answerEl.innerHTML = '<span class="ring"></span><span class="head"></span>';
  const answerMarker = new maplibregl.Marker({ element: answerEl });

  let basemap = DEFAULT_BASEMAP;
  let animation = 0;

  return {
    map,
    ready,

    setGuess(p) {
      if (p) guessMarker.setLngLat([p.lng, p.lat]).addTo(map);
      else guessMarker.remove();
    },

    // The reveal, in three beats:
    //   1. the camera glides to frame both points
    //   2. the line draws itself from the guess to the answer (onProgress gets 0 → 1 so numbers can count up)
    //   3. the answer pin drops in with a bounce and a pulsing ring
    // Resolves when it's all done. Calling reset() part-way through cancels it cleanly.
    async showResult(guess, answer, { color = "#ffffff", onProgress = () => {}, drawMs = 1000 } = {}) {
      await ready;
      const run = ++animation; // if this number changes, a newer call has taken over and we stop
      const still = () => run === animation;
      const quick = reduceMotion();

      const coords = greatCircle(guess, answer);
      map.getSource("arc").setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
      setLineProgress(map, 0, color);
      answerEl.style.setProperty("--tier", color);
      guessEl.style.setProperty("--tier", color);

      await frame(map, coords, quick);
      if (!still()) return;

      // Beat 2: draw the line. One update per screen frame, using requestAnimationFrame.
      await new Promise((resolve) => {
        if (quick) { setLineProgress(map, 1, color); onProgress(1); return resolve(); }
        const start = performance.now();
        const tick = (now) => {
          if (!still()) return resolve();
          const t = Math.min(1, (now - start) / drawMs);
          const eased = easeInOut(t);
          setLineProgress(map, eased, color);
          onProgress(eased);
          if (t < 1) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      if (!still()) return;

      // Beat 3: the pin. Restarting the CSS animation = remove the class, force a layout, add it back.
      answerEl.classList.remove("landed");
      answerMarker.setLngLat([answer.lng, answer.lat]).addTo(map);
      void answerEl.offsetWidth;
      answerEl.classList.add("landed");
    },

    // Where a lat/lng currently sits on screen (in pixels from the map's top-left), for effects.
    toScreen(p) {
      const { x, y } = map.project([p.lng, p.lat]);
      return { x, y };
    },

    // New round: clear the last result and pull back out to the whole world.
    async reset() {
      animation++; // cancels any reveal still running
      await ready;
      guessMarker.remove();
      answerMarker.remove();
      answerEl.classList.remove("landed");
      map.getSource("arc").setData(EMPTY);
      setLineProgress(map, 0, "#fff");
      const worldZoom = fitWorldZoom(container.getBoundingClientRect());
      if (map.getZoom() > worldZoom + 0.3) map.easeTo({ zoom: worldZoom, duration: reduceMotion() ? 0 : 900 });
    },

    async setBasemap(key) {
      basemap = key;
      await ready; // layers don't exist until the style has loaded
      if (imageryOff) return;
      for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${k}`, "visibility", k === key ? "visible" : "none");
    },
    get basemap() { return basemap; },

    async setCitiesVisible(on) {
      await ready;
      for (const band of CITY_BANDS) map.setLayoutProperty(band.id, "visibility", on ? "visible" : "none");
    },
  };
}

// Zoom level at which the whole globe fits the box with a little margin.
// At zoom z the world is 512 × 2^z pixels around, so the globe's radius is that ÷ 2π.
function fitWorldZoom(rect) {
  const want = 0.42 * Math.max(200, Math.min(rect.width, rect.height));
  return Math.max(0.3, Math.log2((want * 2 * Math.PI) / 512));
}

// Shows the line up to `progress` (0..1) in `color`, and hides the rest.
function setLineProgress(map, progress, color) {
  const gradient = progress <= 0 ? HIDDEN_LINE
    : progress >= 1 ? ["step", ["line-progress"], color, 1, color]
    : ["step", ["line-progress"], color, progress, "rgba(0,0,0,0)"];
  map.setPaintProperty("arc-core", "line-gradient", gradient);
  map.setPaintProperty("arc-glow", "line-gradient", gradient);
  // The outline is always dark, whatever the colour, so the line stands out on light and dark ground.
  const casing = progress <= 0 ? HIDDEN_LINE
    : ["step", ["line-progress"], "rgba(8,14,20,0.9)", Math.min(progress, 1), progress >= 1 ? "rgba(8,14,20,0.9)" : "rgba(0,0,0,0)"];
  map.setPaintProperty("arc-casing", "line-gradient", casing);
}

// Glides the camera so the whole line is in view. Resolves when the camera stops.
function frame(map, coords, quick) {
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  const el = map.getContainer();
  const pad = Math.min(90, el.clientWidth * 0.14);
  const padding = { top: pad, bottom: pad * 2.6, left: pad, right: pad }; // extra room at the bottom for the result card
  const lngSpan = bounds.getEast() - bounds.getWest();
  const duration = quick ? 0 : 1100;
  return new Promise((resolve) => {
    map.once("moveend", () => resolve());
    setTimeout(resolve, duration + 400); // safety net in case the camera had nowhere to move
    if (lngSpan > 200) {
      // Very long lines (most of the way round the world): just centre the middle of the line.
      // (offset, not padding: padding given to easeTo would stick around for every later move)
      const mid = coords[Math.floor(coords.length / 2)];
      map.easeTo({ center: mid, zoom: fitWorldZoom(el.getBoundingClientRect()), offset: [0, -pad * 0.8], duration });
    } else {
      map.fitBounds(bounds, { padding, maxZoom: 8, duration });
    }
  });
}

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
