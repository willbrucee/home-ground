// "The Climb": the rank ladder as a staircase. One step per rank, Wooden spoon at the bottom left up to
// Hall of Fame at the top right. A ball hops up the steps as the score counts up; each step it reaches
// lights up in its colour with a tick. At the final rank it lands and settles, a flag is planted (a
// trophy rises for Captain and Hall of Fame), and the rank's name appears beside the staircase.
// Every rank name and its points threshold are drawn under its step and are never covered.
// Nothing loops: it plays once, then stays still. prefers-reduced-motion (or Skip) jumps to the end.
import { LADDER, rankFor } from "./tiers.js";
import { ROUNDS } from "./config.js";

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const N = LADDER.length;

// Where a total sits: which step, and how far along that step (0..1) between its minimum and the next.
function place(total) {
  const t = Math.max(0, total);
  const i = LADDER.indexOf(rankFor(t));
  const lo = LADDER[i].min, hi = LADDER[i + 1]?.min ?? 5000;
  return { i, along: hi > lo ? Math.min(1, (t - lo) / (hi - lo)) : 1 };
}

// "1,350 to Captain", or the best still possible.
export function nextUp(total, played) {
  const next = LADDER.find((r) => r.min > total);
  if (!next) return "Top of the ladder.";
  const need = next.min - total, left = ROUNDS - played;
  if (left <= 0) return `${need.toLocaleString()} short of ${next.name}.`;
  if (need > left * 1000) {
    const best = rankFor(total + left * 1000);
    return best === rankFor(total) ? `${best.name} it is, whatever happens.` : `${best.name} is the best still possible.`;
  }
  return `${need.toLocaleString()} to ${next.name}${left < ROUNDS ? ` · ${left} round${left === 1 ? "" : "s"} left` : ""}`;
}

// The staircase. Sizes are in SVG units; the SVG scales to its box.
function geometry(compact) {
  const W = compact ? 360 : 600, H = compact ? 104 : 330;  // compact: drawn at about its real size
  const label = compact ? 30 : 50;           // room under the steps for name and threshold
  const top = compact ? 24 : 70;             // room above the top step for the ball, flag and trophy
  const gap = 4, stepW = (W - gap * (N - 1)) / N;
  const floor = H - label, rise = (floor - top) / N;
  const x = (i) => i * (stepW + gap);
  const y = (i) => floor - rise * (i + 1);   // top surface of step i
  return { W, H, label, stepW, floor, x, y, r: compact ? 7 : 14 };
}

function svg(g, compact) {
  const steps = LADDER.map((r, i) => `
    <g class="cl-step" data-i="${i}">
      <rect x="${g.x(i)}" y="${g.y(i)}" width="${g.stepW}" height="${g.floor - g.y(i)}" rx="3" />
      <path class="cl-tick" d="M ${g.x(i) + g.stepW / 2 - (compact ? 5 : 10)} ${g.y(i) + (compact ? 9 : 22)} l ${compact ? "3.5 3.5 l 6.5 -7.5" : "7 7 l 13 -15"}" />
      <text class="cl-name" x="${g.x(i) + g.stepW / 2}" y="${g.floor + (compact ? 12 : 22)}">${r.name}</text>
      <text class="cl-min" x="${g.x(i) + g.stepW / 2}" y="${g.floor + (compact ? 24 : 42)}">${r.min.toLocaleString()}+</text>
    </g>`).join("");
  return `<svg class="cl-svg" viewBox="0 0 ${g.W} ${g.H}" role="img" aria-label="Rank staircase">
    ${steps}
    <g class="cl-flag" aria-hidden="true"><path class="pole" d="M0 0 V -44" /><path class="cloth" d="M0 -44 h 26 l -5 8 l 5 8 H 0 Z" /></g>
    <g class="cl-trophy" aria-hidden="true"><path d="M-14 -46 h28 v10 a14 14 0 0 1 -28 0 Z M-14 -42 h-8 v4 a8 8 0 0 0 8 8 M14 -42 h8 v4 a8 8 0 0 1 -8 8 M-3 -22 h6 v8 h-6 Z M-11 -14 h22 v6 h-22 Z" /></g>
    <g class="cl-ball"><circle r="${g.r}" /><path d="M -${g.r * 0.55} -${g.r * 0.2} q ${g.r * 0.55} ${g.r * 0.5} ${g.r * 1.1} 0" /></g>
  </svg>`;
}

// el: the box to draw into. compact: the small in-game version.
export function createClimb(el, { compact = false } = {}) {
  const g = geometry(compact);
  el.classList.add("climb", compact ? "climb-compact" : "climb-hero");
  el.innerHTML = `${svg(g, compact)}
    <div class="cl-side">${compact ? `<p class="cl-score"><b>0</b> pts</p><p class="cl-next"></p>` :
      `<p class="cl-rank" aria-live="polite"><small>Today's rank</small><b></b></p><button class="cl-skip" type="button">Skip</button>`}</div>`;
  const ball = el.querySelector(".cl-ball"), flag = el.querySelector(".cl-flag"), trophy = el.querySelector(".cl-trophy");
  const scoreEl = el.querySelector(".cl-score b"), nextEl = el.querySelector(".cl-next"), skipBtn = el.querySelector(".cl-skip");
  let shown = 0, frame = 0, timers = [], finish = null;

  const ballAt = (total) => {
    const { i, along } = place(total);
    const pad = g.r + 6;
    return { i, x: g.x(i) + pad + along * (g.stepW - 2 * pad), y: g.y(i) - g.r };
  };
  const put = (x, y) => ball.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  const light = (upTo) => el.querySelectorAll(".cl-step").forEach((s, k) => {
    s.classList.toggle("lit", k <= upTo);
    s.classList.toggle("here", k === upTo);
  });
  const showScore = (v) => { if (scoreEl) scoreEl.textContent = Math.round(v).toLocaleString(); };

  // Plant the flag (and raise the trophy for the top two ranks) on the final step; say the rank.
  function land(total) {
    const p = ballAt(total);
    put(p.x, p.y);
    light(p.i);
    const fx = g.x(p.i) + g.stepW - 12, fy = g.y(p.i);
    flag.setAttribute("transform", `translate(${fx} ${fy})`);
    trophy.setAttribute("transform", `translate(${p.x} ${fy - 2 * g.r - 8})`); // floats just above the ball
    el.classList.toggle("has-trophy", LADDER[p.i].big === true);
    el.classList.add("landed");
    const rankEl = el.querySelector(".cl-rank b");
    if (rankEl) rankEl.textContent = LADDER[p.i].name;
    if (skipBtn) skipBtn.hidden = true;
  }

  // Move the ball from one total to another: a hop onto each new step, then a roll to its spot.
  // The score counts up in step with it. Resolves when done (or skipped).
  function climbTo(from, to, { ms = 3000, onDone, instant = false } = {}) {
    cancelAnimationFrame(frame); timers.forEach(clearTimeout); timers = [];
    el.classList.remove("landed", "has-trophy");
    finish = () => { cancelAnimationFrame(frame); timers.forEach(clearTimeout); shown = to; showScore(to); if (!compact) land(to); else { const p = ballAt(to); put(p.x, p.y); light(p.i); } onDone?.(); finish = null; };
    if (instant || reduceMotion() || to <= from) { finish(); return; }
    // the path: through each step's first spot, then on to the final spot
    const a = ballAt(from), b = ballAt(to);
    const stops = [{ ...a, v: from }];
    for (let k = a.i + 1; k <= b.i; k++) stops.push({ ...ballAt(LADDER[k].min), v: LADDER[k].min, hop: true });
    stops.push({ ...b, v: to });
    const legs = stops.slice(1).map((s, k) => ({ from: stops[k], to: s, w: s.hop ? 1.4 : Math.max(0.3, Math.abs(s.x - stops[k].x) / g.stepW) }));
    const total = legs.reduce((sum, l) => sum + l.w, 0);
    let leg = 0, legStart = performance.now();
    light(a.i);
    const step = (now) => {
      const L = legs[leg], dur = (ms * L.w) / total;
      const t = Math.min(1, Math.max(0, (now - legStart) / dur));
      const e = L.to.hop ? t : 1 - (1 - t) ** 2;
      const x = L.from.x + (L.to.x - L.from.x) * e;
      const lift = L.to.hop ? Math.sin(Math.PI * t) * (compact ? 12 : 34) : 0; // the hop's arc
      put(x, L.from.y + (L.to.y - L.from.y) * e - lift);
      shown = L.from.v + (L.to.v - L.from.v) * t;
      showScore(shown);
      if (t < 1) { frame = requestAnimationFrame(step); return; }
      if (L.to.hop) {
        light(L.to.i); // the step lights up with its tick as the ball lands
        el.querySelector(`.cl-step[data-i="${L.to.i}"]`)?.classList.add("ticked");
      }
      leg++;
      if (leg < legs.length) {
        const pause = L.to.hop ? 140 : 0;
        timers.push(setTimeout(() => { legStart = performance.now(); frame = requestAnimationFrame(step); }, pause));
      } else if (!compact) {
        ball.classList.add("settle"); // a little squash as it lands for good
        timers.push(setTimeout(() => { finish?.(); }, 260));
      } else finish?.();
    };
    frame = requestAnimationFrame(step);
  }
  if (skipBtn) skipBtn.onclick = () => finish?.();

  return {
    // jump straight to a total (page load, new round)
    set(total, played) {
      cancelAnimationFrame(frame); timers.forEach(clearTimeout); finish = null;
      shown = total; showScore(total);
      const p = ballAt(total); put(p.x, p.y); light(p.i);
      if (nextEl && played !== undefined) nextEl.textContent = nextUp(total, played);
    },
    // the in-game hop after a round (about a second); the end screen's climb from zero (about 3 s)
    climb(from, to, played, opts = {}) {
      climbTo(from, to, { ms: opts.ms ?? (compact ? 1100 : 3000), instant: opts.instant, onDone: () => { if (nextEl) nextEl.textContent = nextUp(to, played); opts.onDone?.(); } });
    },
    skip() { finish?.(); },
    stop() { cancelAnimationFrame(frame); timers.forEach(clearTimeout); finish = null; },
  };
}
