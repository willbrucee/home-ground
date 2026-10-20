// The rank ladder: live during the game (a marker that climbs as points come in) and as the hero of
// the Full time screen (a step-by-step climb, then a stamp with the final rank).
import { LADDER, rankFor } from "./tiers.js";
import { ROUNDS } from "./config.js";

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Where a total sits on the ladder, 0 (bottom) to 1 (top). Every rung gets the same height, and the marker
// moves evenly through a rung between its minimum and the next one, so each rank feels like a step.
export function ladderPosition(total) {
  total = Math.max(0, total);
  const i = LADDER.indexOf(rankFor(total));
  const lo = LADDER[i].min, hi = LADDER[i + 1]?.min ?? 5000;
  const within = hi > lo ? Math.min(1, Math.max(0, (total - lo) / (hi - lo))) : 1;
  return (i + within) / LADDER.length;
}

// "1,350 needed across 2 rounds for Captain", or the best rank still possible.
export function projection(total, played) {
  const left = ROUNDS - played;
  const next = LADDER.find((r) => r.min > total);
  if (!next) return "Top of the ladder.";
  if (left <= 0) return `${(next.min - total).toLocaleString()} short of ${next.name}.`;
  const need = next.min - total;
  if (need <= left * 1000) {
    return `${need.toLocaleString()} needed across ${left} round${left === 1 ? "" : "s"} for ${next.name}.`;
  }
  const best = rankFor(total + left * 1000);
  return best === rankFor(total) ? `${rankFor(total).name} it is, whatever happens.` : `${best.name} is the best still possible.`;
}

const rungsHtml = () => LADDER.map((r, i) =>
  `<li class="ll-rung" data-i="${i}"><span>${r.name}</span><small>${r.min.toLocaleString()}+</small></li>`).join("");

// ── live, during the game ───────────────────────────────
export function createLiveLadder(el) {
  el.innerHTML = `<p class="ll-title">Rank</p>
    <div class="ll-track"><ol class="ll-rungs">${rungsHtml()}</ol>
      <div class="ll-marker"><b class="ll-total">0</b></div></div>
    <p class="ll-proj"></p>`;
  const marker = el.querySelector(".ll-marker"), totalEl = el.querySelector(".ll-total"), proj = el.querySelector(".ll-proj");
  let shown = 0, frame = 0;

  function paint(total, played) {
    const rank = rankFor(total);
    el.style.setProperty("--p", ladderPosition(total).toFixed(4));
    totalEl.textContent = Math.round(total).toLocaleString();
    el.querySelectorAll(".ll-rung").forEach((li, i) => {
      li.classList.toggle("here", LADDER[i] === rank);
      li.classList.toggle("passed", LADDER[i].min <= total && LADDER[i] !== rank);
    });
    if (played !== undefined) proj.textContent = projection(Math.round(total), played);
  }

  return {
    // jump straight to a total (new round, page load)
    set(total, played) { cancelAnimationFrame(frame); shown = total; paint(total, played); },
    // follow the result's count-up: t goes 0 → 1 as the line draws
    progress(from, to, t, played) {
      const value = from + (to - from) * t;
      const before = rankFor(shown), now = rankFor(value);
      if (now.min > before.min) rankUp(LADDER.indexOf(now)); // crossed into a higher rank
      shown = value;
      paint(value, t >= 1 ? played : undefined);
    },
  };

  function rankUp(i) {
    const li = el.querySelector(`.ll-rung[data-i="${i}"]`);
    if (!li || reduceMotion()) return;
    li.classList.remove("up"); void li.offsetWidth; li.classList.add("up");
    marker.classList.remove("pop"); void marker.offsetWidth; marker.classList.add("pop");
  }
}

// ── the hero, on the Full time screen ──────────────────
// Climbs one rung at a time from the bottom to the final rank (a short pause and tick on each), then
// stamps the rank on. Returns a cancel function: reopening the screen must never leave two climbs running.
export function heroLadder(el, total, { onTick, instant = false } = {}) {
  const final = rankFor(total), top = LADDER.indexOf(final);
  el.innerHTML = `<div class="hl rank-${final.key}${final.big ? " big" : ""}">
      <div class="hl-track"><ol class="ll-rungs">${rungsHtml()}</ol><div class="ll-marker"><b class="ll-total">0</b></div></div>
      <div class="hl-stamp" aria-live="polite"><small>Today's rank</small><b>${final.name}</b></div>
    </div>`;
  const hl = el.querySelector(".hl"), totalEl = el.querySelector(".ll-total");
  const timers = [];
  let frame = 0, cancelled = false;
  const set = (value) => {
    hl.style.setProperty("--p", ladderPosition(value).toFixed(4));
    totalEl.textContent = Math.round(value).toLocaleString();
    const now = rankFor(value);
    el.querySelectorAll(".ll-rung").forEach((li, i) => {
      li.classList.toggle("here", LADDER[i] === now);
      li.classList.toggle("passed", LADDER[i].min <= value && LADDER[i] !== now);
    });
  };
  const finish = () => { set(total); hl.classList.add("stamped"); };
  if (instant || reduceMotion()) { finish(); return () => {}; }

  // Each step glides to the next rung's minimum (or the final total), pauses, ticks, and moves on.
  const stops = LADDER.slice(1, top + 1).map((r) => r.min).concat(total);
  let from = 0, k = 0;
  const glide = () => {
    if (cancelled) return;
    const to = stops[k], start = performance.now(), ms = 420;
    const step = (now) => {
      if (cancelled) return;
      const t = Math.min(1, Math.max(0, (now - start) / ms)), eased = 1 - (1 - t) ** 3; // rAF times can predate start
      set(from + (to - from) * eased);
      if (t < 1) { frame = requestAnimationFrame(step); return; }
      from = to; k++;
      if (k < stops.length) {
        const li = el.querySelector(`.ll-rung[data-i="${k}"]`); // the rung just reached
        li?.classList.add("tick");
        onTick?.(k);
        timers.push(setTimeout(glide, 260));
      } else {
        timers.push(setTimeout(() => hl.classList.add("stamped"), 200));
      }
    };
    frame = requestAnimationFrame(step);
  };
  set(0);
  timers.push(setTimeout(glide, 350));
  return () => { cancelled = true; cancelAnimationFrame(frame); timers.forEach(clearTimeout); };
}
