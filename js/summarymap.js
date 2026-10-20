// The Full time map: the game's own satellite map, showing all five shots at once.
// For each round: the guess (a ball) exactly at the guess, the answer (a flag) exactly at the answer,
// a tier-coloured great-circle arc between them with the distance at its midpoint, and the round
// number on both ends. Markers that land close together keep their exact point (a small dot) and fan
// their badges out on short leader lines, so nothing hides behind anything else.
//
// createSummaryMap() returns { selectRound(i), showAll(), destroy() }. destroy() removes the map,
// every marker and every pending animation: the Full time screen calls it before drawing again.
import { buildStyle } from "./map.js";
import { greatCircle } from "./geo.js";
import { sportIcon } from "./sporticons.js";
import { MAP_MAX_ZOOM } from "./config.js";

const EMPTY = { type: "FeatureCollection", features: [] };
const FAN_PX = 30; // markers closer than this on screen fan out

// rounds: [{ guess: {lat, lng} | null, answer: {lat, lng}, color, sport, label: "1,234 km" }]
export function createSummaryMap(container, rounds, { animate = true } = {}) {
  // Each arc as a continuous line (longitudes may run past ±180 so it never jumps across the map),
  // then whole arcs shifted by 360° so all five sit side by side on one copy of the world.
  const paths = rounds.map((r) => (r.guess ? greatCircle(r.guess, r.answer, 128) : [[r.answer.lng, r.answer.lat]]));
  alignWorldCopies(paths);
  const ends = paths.map((p) => ({ guess: p[0], answer: p[p.length - 1], mid: p[Math.floor(p.length / 2)] }));

  const map = new maplibregl.Map({
    container,
    style: buildStyle("mercator"),
    bounds: boundsOf(paths),
    fitBoundsOptions: { padding: padFor(container), maxZoom: 9 },
    maxZoom: MAP_MAX_ZOOM,
    fadeDuration: 0,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    renderWorldCopies: true,
    attributionControl: { compact: true },
    dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
    cooperativeGestures: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("error", (e) => { if (e.sourceId !== "satellite") console.error(e.error || e); });

  const timers = [];
  let frame = 0, gone = false;
  const markers = [];

  // badge elements: [round][0 = guess, 1 = answer]
  const pins = rounds.map((r, i) => {
    const make = (kind) => {
      const el = document.createElement("div");
      el.className = `sm-pin sm-${kind}`;
      el.style.setProperty("--c", r.color);
      el.innerHTML = `<span class="sm-dot"></span><span class="sm-leader"></span>
        <span class="sm-badge">${kind === "guess" ? `<span class="sm-ball">${sportIcon(r.sport, { pin: true })}</span>` : '<span class="sm-flag"></span>'}<b>${i + 1}</b></span>`;
      el.addEventListener("click", (ev) => { ev.stopPropagation(); api.selectRound(i); });
      return el;
    };
    const out = [];
    if (r.guess) out.push(new maplibregl.Marker({ element: make("guess"), anchor: "center" }).setLngLat(ends[i].guess));
    out.push(new maplibregl.Marker({ element: make("answer"), anchor: "center" }).setLngLat(ends[i].answer));
    // the distance, halfway along the arc
    if (r.guess && r.label && !r.inside) {
      const tag = document.createElement("div");
      tag.className = "sm-dist";
      tag.style.setProperty("--c", r.color);
      tag.textContent = r.label;
      out.push(new maplibregl.Marker({ element: tag, anchor: "center" }).setLngLat(ends[i].mid));
    }
    return out;
  });

  map.once("load", () => {
    if (gone) return;
    // the credit line starts folded behind its (i) button, as on the game map
    const attrib = container.querySelector(".maplibregl-ctrl-attrib");
    attrib?.classList.remove("maplibregl-compact-show");
    attrib?.removeAttribute("open");
    map.addSource("arcs", { type: "geojson", data: EMPTY });
    map.addLayer({ id: "sm-arc-casing", type: "line", source: "arcs", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0e1714", "line-width": 6.5, "line-opacity": ["get", "opacity"] } });
    map.addLayer({ id: "sm-arc", type: "line", source: "arcs", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"] } });
    pins.forEach((ms) => ms.forEach((m) => { m.getElement().classList.add("sm-hidden"); m.addTo(map); markers.push(m); }));
    fan();
    map.on("zoomend", fan);
    map.on("moveend", fan);
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) drawIn(); else showFinished();
  });

  let progress = rounds.map(() => 0), selected = -1;
  function paint() {
    const features = paths.map((p, i) => {
      const n = Math.max(2, Math.round(p.length * progress[i]));
      const dim = selected >= 0 && selected !== i;
      return { type: "Feature", properties: { color: rounds[i].color, width: selected === i ? 5.5 : 3.5, opacity: dim ? 0.3 : 1 },
        geometry: { type: "LineString", coordinates: p.length > 1 ? p.slice(0, n) : [p[0], p[0]] } };
    });
    map.getSource("arcs")?.setData({ type: "FeatureCollection", features });
    pins.forEach((ms, i) => ms.forEach((m) => m.getElement().classList.toggle("sm-dim", selected >= 0 && selected !== i)));
  }

  // Rounds draw in one after another: the ball appears, the arc runs to the answer, the flag lands.
  function drawIn() {
    const per = 700, gap = 420;
    const start = performance.now() + 300;
    rounds.forEach((r, i) => timers.push(setTimeout(() => pins[i][0]?.getElement().classList.remove("sm-hidden"), 300 + i * gap)));
    const step = (now) => {
      if (gone) return;
      let done = true;
      progress = rounds.map((_, i) => {
        const t = Math.min(1, Math.max(0, (now - start - i * gap) / per));
        if (t < 1) done = false;
        if (t >= 1) pins[i].forEach((m) => m.getElement().classList.remove("sm-hidden"));
        return 1 - (1 - t) ** 2;
      });
      paint();
      if (!done) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }
  function showFinished() {
    progress = rounds.map(() => 1);
    pins.forEach((ms) => ms.forEach((m) => m.getElement().classList.remove("sm-hidden")));
    paint();
  }

  // Fan out markers that sit on top of each other: each keeps its dot on the exact spot, and its badge
  // moves out around the cluster's centre on a short leader line.
  function fan() {
    if (gone) return;
    const all = markers.filter((m) => !m.getElement().classList.contains("sm-dist"));
    const pts = all.map((m) => map.project(m.getLngLat()));
    const seen = new Set();
    all.forEach((m, a) => {
      if (seen.has(a)) return;
      const group = [a];
      for (let b = a + 1; b < all.length; b++) {
        if (!seen.has(b) && group.some((g) => Math.hypot(pts[g].x - pts[b].x, pts[g].y - pts[b].y) < FAN_PX)) group.push(b);
      }
      group.forEach((g, k) => {
        seen.add(g);
        const el = all[g].getElement();
        if (group.length === 1) { el.style.setProperty("--dx", "0px"); el.style.setProperty("--dy", "0px"); el.classList.remove("sm-fanned"); return; }
        const angle = -Math.PI / 2 + (2 * Math.PI * k) / group.length, r = 26 + group.length * 3;
        el.style.setProperty("--dx", `${Math.round(Math.cos(angle) * r)}px`);
        el.style.setProperty("--dy", `${Math.round(Math.sin(angle) * r)}px`);
        el.style.setProperty("--len", `${r}px`);
        el.style.setProperty("--ang", `${angle}rad`);
        el.classList.add("sm-fanned");
      });
    });
    // Distance tags: move each off anything it would cover (a pin, its badge or another tag).
    const taken = all.map((m, k) => {
      const el = m.getElement();
      const dx = parseFloat(el.style.getPropertyValue("--dx")) || 0, dy = parseFloat(el.style.getPropertyValue("--dy")) || 0;
      return { x: pts[k].x + dx, y: pts[k].y + dy };
    }).concat(pts);
    markers.filter((m) => m.getElement().classList.contains("sm-dist")).forEach((m) => {
      const at = map.project(m.getLngLat());
      const tryOffsets = [[0, 0], [0, -26], [0, 26], [44, 0], [-44, 0], [0, -48], [0, 48]];
      const clear = ([ox, oy]) => taken.every((t) => Math.abs(t.x - (at.x + ox)) > 40 || Math.abs(t.y - (at.y + oy)) > 18);
      const off = tryOffsets.find(clear) || tryOffsets[1];
      m.setOffset(off);
      taken.push({ x: at.x + off[0], y: at.y + off[1] });
    });
  }

  const api = {
    map,
    // Fly to one round's arc and pick it out (the others fade back).
    selectRound(i) {
      if (gone || !paths[i]) return;
      selected = i;
      paint();
      map.fitBounds(boundsOf([paths[i]]), { padding: padFor(container), maxZoom: 8, duration: 900 });
      container.dispatchEvent(new CustomEvent("roundselect", { detail: i }));
    },
    // Back to every pin in view.
    showAll() {
      if (gone) return;
      selected = -1;
      paint();
      map.fitBounds(boundsOf(paths), { padding: padFor(container), maxZoom: 9, duration: 900 });
      container.dispatchEvent(new CustomEvent("roundselect", { detail: -1 }));
    },
    destroy() {
      gone = true;
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
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
  if (gapAt === cs.length - 1) return; // already the widest gap is at the date line
  for (let k = 0; k <= gapAt; k++) paths[cs[k].i].forEach((pt) => (pt[0] += 360)); // move the western group east
}

function boundsOf(paths) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of paths) for (const [lng, lat] of p) { w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat); }
  // never closer than a city-sized box
  if (e - w < 0.6) { const m = (e + w) / 2; w = m - 0.3; e = m + 0.3; }
  if (n - s < 0.4) { const m = (n + s) / 2; s = m - 0.2; n = m + 0.2; }
  return [[w, Math.max(-80, s)], [e, Math.min(84, n)]];
}

function padFor(container) {
  const r = container.getBoundingClientRect();
  const p = Math.max(30, Math.min(70, Math.min(r.width, r.height) * 0.12));
  return { top: p + 10, bottom: p, left: p, right: p + 30 };
}
