// Everything to do with the map. The MapLibre map is created ONCE and reused for every round;
// rounds only change the data inside a few layers, which is what keeps it smooth.
import { SATELLITE, PROJECTION, MAP_MAX_ZOOM } from "./config.js";
import { greatCircle, circle } from "./geo.js";
import { sportIcon } from "./sporticons.js";
import { color, withAlpha } from "./palette.js";

const EMPTY = { type: "FeatureCollection", features: [] };
const NO_COUNTRY = ["==", ["get", "name"], ""]; // a filter that matches nothing
const CLEAR = "rgba(0,0,0,0)"; // fully transparent (not a palette colour: it's "no colour")
const HIDDEN_LINE = ["step", ["line-progress"], CLEAR, 0.5, CLEAR];

// Ease-in-out: slow start, quick middle, slow finish.
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function buildStyle(projection) {
  const sources = {};
  const layers = [{ id: "ocean", type: "background", paint: { "background-color": color("--sea") } }];

  // Country shapes. Drawn plainly underneath the imagery: normally the tiles cover them, but if tiles
  // can't load (offline, blocked, or a page that doesn't allow outside images) the map still works.
  sources.countries = { type: "geojson", data: "data/countries.geojson" };
  layers.push(
    { id: "land", type: "fill", source: "countries", paint: { "fill-color": color("--land") } },
    { id: "borders", type: "line", source: "countries", paint: { "line-color": color("--mute-ink"), "line-width": 0.6, "line-opacity": 0.6 } },
  );

  // Satellite imagery on top of those plain shapes.
  sources.satellite = { type: "raster", tiles: [SATELLITE.tiles], tileSize: 256, maxzoom: SATELLITE.maxzoom, attribution: SATELLITE.attribution };
  // no fade-in: a new tile appears at once (MapLibre shows the blurrier parent tile until it arrives)
  layers.push({ id: "satellite", type: "raster", source: "satellite", paint: { "raster-fade-duration": 0 } });

  // "Reveal country" highlight: the same shapes again, drawn over the imagery, but filtered to
  // show nothing until a country is picked. A gold tint plus a dark-edged gold outline reads on any ground.
  layers.push(
    { id: "country-fill", type: "fill", source: "countries", filter: NO_COUNTRY, paint: { "fill-color": color("--gold"), "fill-opacity": 0 } },
    { id: "country-casing", type: "line", source: "countries", filter: NO_COUNTRY,
      layout: { "line-join": "round" }, paint: { "line-color": color("--ink"), "line-width": 4, "line-opacity": 0 } },
    { id: "country-line", type: "line", source: "countries", filter: NO_COUNTRY,
      layout: { "line-join": "round" }, paint: { "line-color": color("--gold"), "line-width": 2, "line-opacity": 0 } },
  );

  // The city area: everything inside this circle counts as "in the city" (a Bullseye).
  // A soft fill plus a dashed white ring, shown on the reveal.
  sources.city = { type: "geojson", data: EMPTY };
  layers.push(
    { id: "city-fill", type: "fill", source: "city", paint: { "fill-color": color("--chalk"), "fill-opacity": 0 } },
    { id: "city-ring", type: "line", source: "city", paint: { "line-color": color("--chalk"), "line-width": 2, "line-dasharray": [2, 1.5], "line-opacity": 0 } },
  );

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

// insets(): how much of each screen edge is covered by the overlays (header, ticket, dock), in pixels.
// The camera keeps results inside the open part of the map.
export function createMap(container, { onPick, insets = () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }) {
  const flat = PROJECTION === "mercator" || new URLSearchParams(location.search).has("flat");
  const rect = container.getBoundingClientRect();

  const map = new maplibregl.Map({
    container,
    style: buildStyle(flat ? "mercator" : "globe"),
    center: [15, 25],
    zoom: fitWorldZoom(openArea(rect, insets())),
    minZoom: 0.3,
    maxZoom: MAP_MAX_ZOOM,
    fadeDuration: 0,          // no cross-fading of labels/tiles while zooming
    maxTileCacheSize: 600,    // keep more tiles in memory, so zooming back out doesn't re-download them
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2), // very dense screens: draw at 2× at most
    refreshExpiredTiles: false, // tiles don't change during a game; don't re-check them
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

  // On phones the credit line starts collapsed behind its (i) button so it doesn't cover the map;
  // a separate "Powered by Esri" label stays visible (see .esri-mark in the CSS).
  if (rect.width < 640) {
    map.once("load", () => {
      const attrib = container.querySelector(".maplibregl-ctrl-attrib");
      attrib?.classList.remove("maplibregl-compact-show");
      attrib?.removeAttribute("open");
    });
  }

  // If the imagery can't load, MapLibre would print an error for every tile. Having our own
  // error listener stops that. After a few failures we try Esri's other tile host; if that fails
  // too, we switch the imagery off and the game carries on with the plain land map underneath.
  let tileFailures = 0, tileTemplate = SATELLITE.tiles;
  map.on("error", (e) => {
    if (e.sourceId !== "satellite") { console.error(e.error || e); return; }
    tileFailures++;
    if (tileFailures === 6 && tileTemplate !== SATELLITE.fallbackTiles) {
      tileTemplate = SATELLITE.fallbackTiles;
      tileFailures = 0;
      map.getSource("satellite").setTiles([tileTemplate]);
    } else if (tileFailures === 6) {
      map.setLayoutProperty("satellite", "visibility", "none");
    }
  });

  // Preloading: ask for tiles before they're needed, so they're already in the browser's cache
  // (and the service worker's) when the map wants them. Low priority, errors ignored.
  const prefetch = (z, x, y) => {
    const n = 2 ** z;
    const url = tileTemplate.replace("{z}", z).replace("{x}", ((x % n) + n) % n).replace("{y}", y);
    fetch(url, { mode: "cors", credentials: "omit", priority: "low" }).catch(() => {});
  };
  // the zoomed-out world, once the first view has finished loading
  map.once("idle", () => {
    const later = window.requestIdleCallback || ((f) => setTimeout(f, 300));
    later(() => { for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) prefetch(3, x, y); });
  });

  // Markers are plain HTML elements pinned to a map position. We create two and reuse them.
  // The guess pin: a small badge with the current round's sport icon (a generic ball if there's none).
  const guessEl = document.createElement("div");
  guessEl.className = "pin-guess";
  const guessMarker = new maplibregl.Marker({ element: guessEl });
  // The answer pin has an inner head (which does the bounce) and a ring (which pulses).
  // We animate these children, never the marker element itself: MapLibre positions markers with
  // a CSS transform on that element, and animating it too would fight MapLibre and make it jitter.
  const answerEl = document.createElement("div");
  answerEl.className = "pin-answer";
  answerEl.innerHTML = '<span class="ring"></span><span class="head"></span>';
  const answerMarker = new maplibregl.Marker({ element: answerEl });

  let animation = 0;
  let guessShown = false; // is the guess pin on the map right now?
  let highlightRun = 0;

  return {
    map,
    ready,

    setGuess(p, sport) {
      if (!p) { guessMarker.remove(); guessShown = false; return; }
      if (guessEl.dataset.sport !== sport) {
        guessEl.dataset.sport = sport;
        guessEl.innerHTML = `<span class="ball">${sportIcon(sport, { pin: true })}</span>`;
      }
      const placing = !guessShown; // first drop this round (not just moving it)
      guessMarker.setLngLat([p.lng, p.lat]).addTo(map);
      guessShown = true;
      if (placing) { // a little pop when it lands; animate the inner span, never the marker element itself
        const ball = guessEl.firstElementChild;
        ball.classList.remove("pop"); void ball.offsetWidth; ball.classList.add("pop");
      }
    },

    // The reveal, in three beats:
    //   1. the camera glides to frame both points
    //   2. the line draws itself from the guess to the answer (onProgress gets 0 → 1 so numbers can count up)
    //   3. the answer pin drops in with a bounce and a pulsing ring
    // Resolves when it's all done. Calling reset() part-way through cancels it cleanly.
    // `lineEnd` is where the line stops (the city's edge); `radiusKm` is the city area to outline.
    async showResult(guess, answer, { color: lineColor = color("--chalk"), onProgress = () => {}, drawMs = 1000, radiusKm = 0, lineEnd = answer } = {}) {
      await ready;
      const run = ++animation; // if this number changes, a newer call has taken over and we stop
      const still = () => run === animation;
      const quick = reduceMotion();

      const coords = greatCircle(guess, lineEnd);
      const area = radiusKm > 0 ? circle(answer, radiusKm) : null;
      map.getSource("arc").setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
      setLineProgress(map, 0, lineColor);
      answerEl.style.setProperty("--tier", lineColor);
      guessEl.style.setProperty("--tier", lineColor);

      // Frame the guess and the whole city area together.
      await frame(map, area ? [...coords, ...area.geometry.coordinates[0]] : coords, quick, insets());
      if (!still()) return;

      // The city area fades in first, so the player sees the target before the line arrives.
      if (area) {
        map.getSource("city").setData(area);
        map.setPaintProperty("city-ring", "line-color", lineColor);
        await fade(map, quick, (t) => {
          map.setPaintProperty("city-fill", "fill-opacity", 0.16 * t);
          map.setPaintProperty("city-ring", "line-opacity", 0.9 * t);
        }, 350, still);
        if (!still()) return;
      }

      // Beat 2: draw the line. One update per screen frame, using requestAnimationFrame.
      await new Promise((resolve) => {
        if (quick) { setLineProgress(map, 1, lineColor); onProgress(1); return resolve(); }
        const start = performance.now();
        const tick = (now) => {
          if (!still()) return resolve();
          const t = Math.min(1, Math.max(0, (now - start) / drawMs)); // never below 0 (see fade)
          const eased = easeInOut(t);
          setLineProgress(map, eased, lineColor);
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

    // Tint and outline one country, pulse it 3 times (about 1.5 s), then leave a softer highlight.
    // `name` is the shape's name in countries.geojson. Also frames the country if it's hard to see.
    async highlightCountry(name, fit) {
      await ready;
      const run = ++highlightRun;
      const filter = ["==", ["get", "name"], name];
      for (const id of ["country-fill", "country-casing", "country-line"]) map.setFilter(id, filter);
      if (fit) frameCountry(map, fit, container, insets());

      // strength 0..1 controls how loud the highlight is
      const paint = (strength) => {
        map.setPaintProperty("country-fill", "fill-opacity", 0.12 + 0.28 * strength);
        map.setPaintProperty("country-line", "line-opacity", 0.75 + 0.25 * strength);
        map.setPaintProperty("country-line", "line-width", 2 + 2 * strength);
        map.setPaintProperty("country-casing", "line-opacity", 0.5 + 0.3 * strength);
        map.setPaintProperty("country-casing", "line-width", 4 + 2 * strength);
      };
      if (reduceMotion()) { paint(0); return; } // a steady highlight, no flashing

      const PULSES = 3, MS = 1500, start = performance.now();
      const tick = (now) => {
        if (run !== highlightRun) return; // a newer call (or a clear) took over
        const t = Math.min(1, Math.max(0, (now - start) / MS));
        // sin² gives smooth 0 → 1 → 0 bumps, one per pulse
        paint(t < 1 ? Math.sin(t * PULSES * Math.PI) ** 2 : 0);
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },

    async clearCountry() {
      highlightRun++;
      await ready;
      for (const id of ["country-fill", "country-casing", "country-line"]) map.setFilter(id, NO_COUNTRY);
    },

    // Preload the area around a point at the zoom levels a reveal usually passes through.
    prefetchAround(p) {
      for (const z of [3, 5, 7, 9]) {
        const n = 2 ** z, lat = Math.max(-85, Math.min(85, p.lat)) * Math.PI / 180;
        const x = Math.floor(((p.lng + 180) / 360) * n);
        const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n); // Web Mercator tile row
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (y + dy >= 0 && y + dy < n) prefetch(z, x + dx, y + dy);
      }
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
      guessShown = false;
      answerMarker.remove();
      answerEl.classList.remove("landed");
      map.getSource("arc").setData(EMPTY);
      map.getSource("city").setData(EMPTY);
      map.setPaintProperty("city-fill", "fill-opacity", 0);
      map.setPaintProperty("city-ring", "line-opacity", 0);
      setLineProgress(map, 0, color("--chalk"));
      this.clearCountry();
      const worldZoom = fitWorldZoom(openArea(container.getBoundingClientRect(), insets()));
      if (map.getZoom() > worldZoom + 0.3) map.easeTo({ zoom: worldZoom, duration: reduceMotion() ? 0 : 900 });
    },


  };
}

// The part of the map not covered by overlays (never smaller than 160 px each way).
function openArea(rect, ins) {
  return { width: Math.max(160, rect.width - ins.left - ins.right), height: Math.max(160, rect.height - ins.top - ins.bottom) };
}

// Padding for fitBounds: the covered edges plus a margin, trimmed so it can never exceed the map.
function paddingFor(rect, ins, margin) {
  const p = { top: ins.top + margin, bottom: ins.bottom + margin, left: ins.left + margin, right: ins.right + margin };
  const squeeze = (a, b, size) => { const over = p[a] + p[b] - (size - 120); if (over > 0) { p[a] -= over / 2; p[b] -= over / 2; } };
  squeeze("top", "bottom", rect.height);
  squeeze("left", "right", rect.width);
  return p;
}

// Zoom level at which the whole globe fits the box with a little margin.
// At zoom z the world is 512 × 2^z pixels around, so the globe's radius is that ÷ 2π.
function fitWorldZoom(rect) {
  const want = 0.42 * Math.max(200, Math.min(rect.width, rect.height));
  return Math.max(0.3, Math.log2((want * 2 * Math.PI) / 512));
}

// Runs paint(t) with t going 0 → 1 over `ms`, one step per frame. Stops early if still() turns false.
function fade(map, quick, paint, ms, still) {
  if (quick) { paint(1); return Promise.resolve(); }
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = (now) => {
      if (!still()) return resolve();
      const t = Math.min(1, Math.max(0, (now - start) / ms)); // a frame can be stamped just before `start`
      paint(t);
      if (t < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// Brings a country into view, unless the player can already see it well (or is zoomed in inside it).
function frameCountry(map, [w, s, e, n], container, ins) {
  const sw = map.project([w, s]), ne = map.project([e, n]);
  const rect = container.getBoundingClientRect();
  const onScreen = (p) => p.x >= 0 && p.y >= 0 && p.x <= rect.width && p.y <= rect.height;
  const widthPx = Math.abs(ne.x - sw.x);
  const c = map.getCenter();
  const insideIt = c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n;
  if ((onScreen(sw) && onScreen(ne) && widthPx >= 70) || (insideIt && widthPx > rect.width)) return;
  const padding = paddingFor(rect, ins, Math.min(60, rect.width * 0.08));
  map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 6, duration: reduceMotion() ? 0 : 1000 });
}

// Shows the line up to `progress` (0..1) in `color`, and hides the rest.
function setLineProgress(map, progress, color) {
  const gradient = progress <= 0 ? HIDDEN_LINE
    : progress >= 1 ? ["step", ["line-progress"], color, 1, color]
    : ["step", ["line-progress"], color, progress, CLEAR];
  map.setPaintProperty("arc-core", "line-gradient", gradient);
  map.setPaintProperty("arc-glow", "line-gradient", gradient);
  // The outline is always dark, whatever the colour, so the line stands out on light and dark ground.
  const casing = progress <= 0 ? HIDDEN_LINE
    : ["step", ["line-progress"], withAlpha("--ink", 0.9), Math.min(progress, 1), progress >= 1 ? withAlpha("--ink", 0.9) : CLEAR];
  map.setPaintProperty("arc-casing", "line-gradient", casing);
}

// Glides the camera so the whole line is in view. Resolves when the camera stops.
function frame(map, coords, quick, ins) {
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  const el = map.getContainer();
  const rect = el.getBoundingClientRect();
  const padding = paddingFor(rect, ins, Math.min(60, rect.width * 0.08)); // keep clear of the overlays
  const lngSpan = bounds.getEast() - bounds.getWest();
  const duration = quick ? 0 : 1100;
  return new Promise((resolve) => {
    map.once("moveend", () => resolve());
    setTimeout(resolve, duration + 400); // safety net in case the camera had nowhere to move
    if (lngSpan > 200) {
      // Very long lines (most of the way round the world): just centre the middle of the line.
      // (offset, not padding: padding given to easeTo would stick around for every later move)
      const mid = coords[Math.floor(coords.length / 2)];
      // shift the centre into the open area (offset, not padding: easeTo would keep the padding for later moves)
      const offset = [(ins.left - ins.right) / 2, (ins.top - ins.bottom) / 2];
      map.easeTo({ center: mid, zoom: fitWorldZoom(openArea(rect, ins)), offset, duration });
    } else {
      map.fitBounds(bounds, { padding, maxZoom: 8, duration });
    }
  });
}

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
