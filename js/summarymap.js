// The Full time map: the game's satellite map, looking at ONE round at a time.
// The selected round shows its guess (a hollow numbered circle in its tier colour), its answer (a filled
// numbered circle with a small flag), the arc between them and one distance label on the arc. The other
// rounds are small faint numbered dots. "Show all" shows every arc, thin, with no labels.
// Calm on purpose: the camera makes one smooth move, the arc draws once (0.8 s), and nothing loops.
//
// createSummaryMap(container, rounds, { onSelect, start }) → { select(i), showAll(), destroy() }. start: the round shown first.
// destroy() removes the map, its markers and any animation in progress, so it can't leave duplicates.
import { buildStyle } from "./map.js";
import { greatCircle } from "./geo.js";
import { MAP_MAX_ZOOM } from "./config.js";
import { color } from "./palette.js";

const EMPTY = { type: "FeatureCollection", features: [] };
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// rounds: [{ guess: {lat, lng} | null, answer: {lat, lng}, color, ink, label: "1,234 km", inside }]
export function createSummaryMap(container, rounds, { onSelect, start = 0 } = {}) {
  // Each arc as one continuous line (longitudes may run past ±180, so it never jumps across the map),
  // and whole arcs shifted by 360° so they sit together on one copy of the world.
  const paths = rounds.map((r) => (r.guess ? greatCircle(r.guess, r.answer, 128) : [[r.answer.lng, r.answer.lat]]));
  alignWorldCopies(paths);
  const ends = paths.map((p) => ({ guess: p[0], answer: p[p.length - 1], mid: p[Math.floor(p.length / 2)] }));

  const map = new maplibregl.Map({
    container,
    style: buildStyle("mercator"),
    bounds: boundsOf([paths[start] || paths[0]]), // opens on the round it was asked for
    fitBoundsOptions: { padding: padFor(container), maxZoom: 9 },
    maxZoom: MAP_MAX_ZOOM,
    fadeDuration: 0,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    renderWorldCopies: true,
    attributionControl: { compact: true },
    dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("error", (e) => { if (e.sourceId !== "satellite") console.error(e.error || e); });

  let gone = false, frame = 0, selected = -1, all = false;
  const markers = [];
  const add = (el, at) => { const m = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(at); markers.push(m); return m; };

  // the markers, made once and only restyled afterwards
  const pins = rounds.map((r, i) => {
    const make = (kind) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `sm-pin sm-${kind}`;
      el.style.setProperty("--c", r.color);
      el.style.setProperty("--c-ink", r.ink);
      el.setAttribute("aria-label", `Round ${i + 1}: ${kind === "guess" ? "your pin" : "the answer"}`);
      el.innerHTML = `<b>${i + 1}</b>${kind === "answer" ? '<i class="sm-flag" aria-hidden="true"></i>' : ""}`;
      el.addEventListener("click", (ev) => { ev.stopPropagation(); api.select(i); });
      return el;
    };
    return { guess: r.guess ? make("guess") : null, answer: make("answer") };
  });
  const tag = document.createElement("div");
  tag.className = "sm-dist";
  let tagMarker = null;

  map.once("load", () => {
    if (gone) return;
    const attrib = container.querySelector(".maplibregl-ctrl-attrib"); // the credit starts folded, as in the game
    attrib?.classList.remove("maplibregl-compact-show");
    attrib?.removeAttribute("open");
    map.addSource("arcs", { type: "geojson", data: EMPTY });
    map.addLayer({ id: "sm-arc-casing", type: "line", source: "arcs", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color("--border"), "line-width": ["get", "casing"], "line-opacity": 0.7 } });
    map.addLayer({ id: "sm-arc", type: "line", source: "arcs", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] } });
    pins.forEach((p, i) => {
      if (p.guess) add(p.guess, ends[i].guess).addTo(map);
      add(p.answer, ends[i].answer).addTo(map);
    });
    tagMarker = add(tag, ends[start]?.mid || ends[0].mid).addTo(map);
    api.select(start, { quick: true });
  });

  // Draw arcs: the selected one grown to `progress` (0..1), or every arc, thin, in "show all".
  function draw(progress = 1) {
    const features = paths.map((p, i) => {
      if (p.length < 2 || (!all && i !== selected)) return null;
      const n = Math.max(2, Math.round(p.length * progress));
      return { type: "Feature", properties: { color: rounds[i].color, width: all ? 2 : 4, casing: all ? 4 : 7 },
        geometry: { type: "LineString", coordinates: all ? p : p.slice(0, n) } };
    }).filter(Boolean);
    map.getSource("arcs")?.setData({ type: "FeatureCollection", features });
  }

  // Restyle the markers: the selected round in full, the others as faint dots; the label for the selected arc.
  function style({ label = true } = {}) {
    pins.forEach((p, i) => {
      const focus = !all && i === selected;
      for (const el of [p.guess, p.answer]) {
        if (!el) continue;
        el.classList.toggle("sm-focus", focus);
        el.classList.toggle("sm-faint", !focus && !all);
        el.classList.toggle("sm-plain", all);
      }
    });
    const r = rounds[selected];
    tag.hidden = !label || all || !r?.guess || r.inside;
    if (!tag.hidden) {
      tag.textContent = r.label;
      tag.style.setProperty("--c", r.color);
      tag.style.setProperty("--c-ink", r.ink);
      tagMarker?.setLngLat(ends[selected].mid);
    }
  }

  const api = {
    map,
    // Focus one round: one smooth camera move to fit its pair, then its arc draws once, then its label.
    select(i, { quick = false } = {}) {
      if (gone || !paths[i]) return;
      all = false; selected = i;
      cancelAnimationFrame(frame);
      style({ label: false });
      draw(0);
      const still = quick || reduceMotion();
      map.fitBounds(boundsOf([paths[i]]), { padding: padFor(container), maxZoom: 8, linear: true, duration: still ? 0 : 900, essential: true });
      const drawArc = () => {
        if (gone || selected !== i || all) return;
        if (still) { draw(1); style(); return; }
        const start = performance.now();
        const step = (now) => {
          if (gone || selected !== i || all) return;
          const t = Math.min(1, Math.max(0, (now - start) / 800));
          draw(1 - (1 - t) ** 2);
          if (t < 1) frame = requestAnimationFrame(step); else style();
        };
        frame = requestAnimationFrame(step);
      };
      if (still) drawArc(); else map.once("moveend", drawArc);
      onSelect?.(i);
    },
    // Every round at once: thin arcs, plain markers, no labels.
    showAll() {
      if (gone) return;
      all = true; selected = -1;
      cancelAnimationFrame(frame);
      style(); draw(1);
      map.fitBounds(boundsOf(paths), { padding: padFor(container), maxZoom: 9, linear: true, duration: reduceMotion() ? 0 : 900 });
      onSelect?.(-1);
    },
    destroy() {
      gone = true;
      cancelAnimationFrame(frame);
      markers.forEach((m) => m.remove());
      map.remove();
    },
  };
  return api;
}

// Shift whole arcs by ±360° so they cluster on one copy of the world: find the widest empty stretch of
// longitude between the arcs and cut the world there.
function alignWorldCopies(paths) {
  const centre = (p) => { const lngs = p.map((c) => c[0]); return (Math.min(...lngs) + Math.max(...lngs)) / 2; };
  paths.forEach((p) => { const c = centre(p); const k = Math.round(c / 360); if (k) p.forEach((pt) => (pt[0] -= 360 * k)); });
  const cs = paths.map(centre).map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c);
  if (cs.length < 2) return;
  let gapAt = cs.length - 1, gap = cs[0].c + 360 - cs[cs.length - 1].c; // the wrap-around gap
  for (let k = 0; k < cs.length - 1; k++) {
    if (cs[k + 1].c - cs[k].c > gap) { gap = cs[k + 1].c - cs[k].c; gapAt = k; }
  }
  if (gapAt === cs.length - 1) return; // the widest gap is already at the date line
  for (let k = 0; k <= gapAt; k++) paths[cs[k].i].forEach((pt) => (pt[0] += 360)); // move the western group east
}

function boundsOf(paths) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of paths) for (const [lng, lat] of p) { w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat); }
  if (e - w < 0.6) { const m = (e + w) / 2; w = m - 0.3; e = m + 0.3; } // never closer than a city-sized box
  if (n - s < 0.4) { const m = (n + s) / 2; s = m - 0.2; n = m + 0.2; }
  return [[w, Math.max(-80, s)], [e, Math.min(84, n)]];
}

// Generous padding, so markers and the label are never cut off at the edges.
function padFor(container) {
  const r = container.getBoundingClientRect();
  const p = Math.max(48, Math.min(90, Math.min(r.width, r.height) * 0.18));
  return { top: p, bottom: p, left: p, right: p + 30 };
}
