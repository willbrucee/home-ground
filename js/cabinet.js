// The trophy cabinet: the six ranks as six trophies on a shelf, from the wooden spoon to the world trophy.
// Trophies you haven't reached are dark silhouettes with a "?" and the points they need; reached ones are
// uncovered in colour with their name. The art is drawn here, in our own style (no real trophy's design,
// no competition logos or marks): bold outlines, flat palette colours and one simple highlight each.
//
// createCabinet(el, { compact }) → { set(total, played), climb(from, to, played, { ms, instant, onDone }), skip(), stop() }
//   compact: the small row in the game (icons and thresholds); otherwise the end screen's full cabinet.
// Nothing loops: an uncovering plays once, then everything is still. prefers-reduced-motion (or Skip) shows
// the end state at once.
import { LADDER, rankFor } from "./tiers.js";
import { ROUNDS } from "./config.js";

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// One trophy per rank, in order. `fill` and `trim` are palette variables.
export const TROPHIES = [
  { name: "Wooden spoon", fill: "var(--r-bronze)", trim: "var(--r-bronze)" },
  { name: "Championship trophy", fill: "var(--r-silver)", trim: "var(--sky)" },
  { name: "League title", fill: "var(--r-gold)", trim: "var(--secondary)" },
  { name: "Domestic cup", fill: "var(--r-silver)", trim: "var(--accent)" },
  { name: "Continental cup", fill: "var(--r-silver)", trim: "var(--r-gold)" },
  { name: "World trophy", fill: "var(--r-gold)", trim: "var(--secondary)" },
];

// The drawings, all on a 80 × 100 canvas standing on the same baseline (y = 94). The same paths make the
// dark silhouette, so a locked trophy shows its shape but not its colours.
const ART = [
  // a wooden spoon, leaning
  `<g transform="rotate(-28 40 60)"><rect x="36" y="38" width="8" height="58" rx="4" class="f"/>
     <ellipse cx="40" cy="26" rx="15" ry="20" class="f"/><ellipse cx="36" cy="22" rx="5" ry="9" class="hl"/></g>`,
  // a plain cup on a short stem
  `<path class="f" d="M22 18h36v8c0 16-8 26-18 28-10-2-18-12-18-28z"/>
   <path class="f" d="M36 54h8v14h-8z"/><path class="f" d="M24 70h32l4 12H20z"/><rect class="t" x="16" y="82" width="48" height="12" rx="2"/>
   <path class="hl" d="M28 24h5v10c0 6 2 10 4 13-5-1-9-8-9-16z"/>`,
  // a league shield trophy on a stand
  `<path class="f" d="M40 10l24 8v22c0 18-12 28-24 34-12-6-24-16-24-34V18z"/>
   <path class="t" d="M40 22l12 4v12c0 9-6 15-12 18-6-3-12-9-12-18V26z"/>
   <path class="f" d="M34 74h12v8H34z"/><rect class="f" x="18" y="82" width="44" height="12" rx="2"/>
   <path class="hl" d="M22 22l6-2v18c0 6 2 11 5 15-7-4-11-10-11-18z"/>`,
  // a cup with two small handles and ribbons
  `<path class="f" d="M24 14h32v10c0 14-7 22-16 24-9-2-16-10-16-24z"/>
   <path class="f" d="M24 18c-12 0-12 16 2 16v-4c-7 0-7-8-2-8zM56 18c12 0 12 16-2 16v-4c7 0 7-8 2-8z"/>
   <path class="t" d="M34 46l-10 30 7-3 4 8 6-31zM46 46l10 30-7-3-4 8-6-31z"/>
   <path class="f" d="M36 48h8v18h-8z"/><rect class="f" x="20" y="80" width="40" height="14" rx="2"/>
   <path class="hl" d="M29 18h5v8c0 6 2 10 4 13-5-1-9-7-9-14z"/>`,
  // a big two-handled cup
  `<path class="f" d="M20 8h40v14c0 18-9 28-20 30-11-2-20-12-20-30z"/>
   <path class="f" d="M20 10C2 10 4 40 24 40v-5C11 35 10 15 20 15zM60 10c18 0 16 30-4 30v-5c13 0 14-20 4-20z"/>
   <path class="t" d="M20 8h40v5H20z"/>
   <path class="f" d="M35 52h10v14H35z"/><path class="f" d="M26 66h28l4 14H22z"/><rect class="t" x="18" y="80" width="44" height="14" rx="2"/>
   <path class="hl" d="M26 14h6v10c0 8 3 14 6 18-8-2-12-10-12-20z"/>`,
  // a globe held up on a plinth
  `<circle class="f" cx="40" cy="28" r="20"/>
   <path class="t" d="M22 22c10 4 26 4 36 0M20 32c10 4 30 4 40 0M40 8c-8 10-8 30 0 40M40 8c8 10 8 30 0 40" fill="none" stroke-width="2.5"/>
   <path class="f" d="M30 46c2 8 6 12 10 12s8-4 10-12c-2 4-6 6-10 6s-8-2-10-6zM34 58h12l4 16H30z"/>
   <rect class="t" x="20" y="74" width="40" height="8" rx="2"/><rect class="f" x="16" y="82" width="48" height="12" rx="2"/>
   <path class="hl" d="M28 18c3-5 7-7 11-8-5 3-8 7-9 13z"/>`,
];

function trophySvg(i, { locked }) {
  const t = TROPHIES[i];
  return `<svg class="tr-art${locked ? " tr-dark" : ""}" viewBox="0 0 80 100" aria-hidden="true" style="--tf:${t.fill};--tt:${t.trim}">
    ${ART[i]}${locked ? `<text x="40" y="58" class="q">?</text>` : ""}</svg>`;
}

// "Next trophy: Domestic cup, 763 to go", or the best still possible.
export function nextUp(total, played) {
  const i = LADDER.findIndex((r) => r.min > total);
  if (i < 0) return "The whole cabinet is yours.";
  const need = LADDER[i].min - total, left = ROUNDS - played;
  if (left <= 0) return `${need.toLocaleString()} short of the ${TROPHIES[i].name.toLowerCase()}.`;
  if (need > left * 1000) {
    const best = LADDER.indexOf(rankFor(total + left * 1000));
    return best === LADDER.indexOf(rankFor(total)) ? "No more trophies today." : `The ${TROPHIES[best].name.toLowerCase()} is the best still possible.`;
  }
  return `Next trophy: ${TROPHIES[i].name}, ${need.toLocaleString()} to go${left < ROUNDS ? ` · ${left} round${left === 1 ? "" : "s"} left` : ""}`;
}

export function createCabinet(el, { compact = false } = {}) {
  el.classList.add("cabinet", compact ? "cab-compact" : "cab-hero");
  el.innerHTML = `<ol class="cab-shelf" aria-label="Trophy cabinet">${LADDER.map((r, i) => `
      <li class="cab-slot" data-i="${i}">
        <span class="cab-glow" aria-hidden="true"></span>
        <span class="cab-art">${trophySvg(i, { locked: true })}${trophySvg(i, { locked: false }).replace('class="tr-art"', 'class="tr-art tr-lit"')}</span>
        <span class="cab-label"><b>${compact ? "" : TROPHIES[i].name}</b><small>${r.min.toLocaleString()}+</small></span>
      </li>`).join("")}</ol>
    ${compact ? `<p class="cab-next"></p>` : `<div class="cab-side"><p class="cab-stamp" aria-live="polite"><small>Today's rank</small><b></b></p></div>`}`;
  const slots = [...el.querySelectorAll(".cab-slot")];
  const nextEl = el.querySelector(".cab-next"), stamp = el.querySelector(".cab-stamp b");
  let timers = [], finish = null;
  const clear = () => { timers.forEach(clearTimeout); timers = []; };

  // Show the cabinet as it stands at `upTo` (the index of the rank reached). `animate`: the index to uncover now.
  const paint = (upTo, animate = -1) => slots.forEach((s, i) => {
    const open = i <= upTo;
    s.classList.toggle("open", open);
    s.classList.toggle("here", i === upTo);
    s.classList.toggle("uncover", typeof animate === "function" ? animate(i) : i === animate);
    s.setAttribute("aria-label", `${TROPHIES[i].name}, ${LADDER[i].name}, ${LADDER[i].min.toLocaleString()} points: ${open ? "won" : "not yet"}`);
  });
  const rankIndex = (total) => LADDER.indexOf(rankFor(Math.max(0, total)));

  function land(to, played) {
    clear();
    const i = rankIndex(to);
    paint(i);
    slots.forEach((s) => s.classList.remove("spot", "uncover"));
    if (!compact) {
      slots[i].classList.add("cab-final");
      if (stamp) { stamp.textContent = LADDER[i].name; el.classList.add("landed"); }
    }
    if (nextEl && played !== undefined) nextEl.textContent = nextUp(to, played);
    finish = null;
  }

  return {
    set(total, played) { clear(); finish = null; el.classList.remove("landed"); slots.forEach((s) => s.classList.remove("cab-final", "spot", "uncover")); paint(rankIndex(total)); if (nextEl && played !== undefined) nextEl.textContent = nextUp(total, played); },
    // Uncover each trophy from `from` up to `to`, one by one (about half a second each on the end screen).
    climb(from, to, played, { ms, instant = false, onDone } = {}) {
      clear();
      const a = rankIndex(from), b = rankIndex(to);
      finish = () => { land(to, played); onDone?.(); };
      if (instant || reduceMotion() || b <= a && compact) { paint(b); finish(); return; }
      const step = ms ? ms / Math.max(1, b - a) : 500;
      el.classList.remove("landed");
      slots.forEach((s) => s.classList.remove("cab-final"));
      paint(a);
      if (compact) { // in the game: everything newly won uncovers together, straight after the round
        timers.push(setTimeout(() => paint(b, (i) => i > a && i <= b), 0));
        timers.push(setTimeout(() => finish?.(), 650));
        return;
      }
      for (let i = a + 1; i <= b; i++) {
        timers.push(setTimeout(() => {
          slots.forEach((s) => s.classList.toggle("spot", +s.dataset.i === i));
          paint(i, i);
        }, (i - a - 1) * step + 150));
      }
      timers.push(setTimeout(() => finish?.(), Math.max(0, b - a) * step + 500));
    },
    skip() { finish?.(); },
    stop() { clear(); finish = null; },
  };
}
