// The Full time screen's parts that don't need the map or the game state: the awards on the pitch cards,
// the match ticket (as HTML, and drawn on a canvas for sharing as a picture) and the league table.
import { tierFor, rankFor } from "./tiers.js";
import { color } from "./palette.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── awards ──────────────────────────────────────────────
// Man of the match: the round with the most points (ties: the closer pin, then the earlier round).
// Disaster class: the round with the fewest points, but only when it was really off (Air ball or Own goal).
const DISASTER_TIERS = ["cold", "frozen"];
export function awards(results) {
  const order = results.map((r, i) => ({ r, i }));
  const best = [...order].sort((a, b) => b.r.pts - a.r.pts || a.r.km - b.r.km || a.i - b.i)[0];
  const worst = [...order].sort((a, b) => a.r.pts - b.r.pts || b.r.km - a.r.km || a.i - b.i)[0];
  const disaster = worst && worst.i !== best?.i && DISASTER_TIERS.includes(tierFor(worst.r.km).key) ? worst.i : null;
  return { motm: best ? best.i : null, disaster, caption: disaster == null ? "" : caption(results[disaster].km) };
}

// Three lines per distance band, picked at random. Each is true for every distance in its band.
const CAPTIONS = [
  { min: 0, lines: ["Thousands of kilometres wide. Back to the training ground.", "Overhit by a country or three. Reset and go again.", "The right planet, the wrong neighbourhood."] },
  { min: 5000, lines: ["Over 5,000 km out. The scouts have questions.", "That one sailed out of the ground and kept going.", "A long-range effort that never troubled the keeper."] },
  { min: 12000, lines: ["Over 12,000 km out: most of the way round the world.", "Any further and the pin would be on its way back.", "A pin from the far side of the globe. Almost impressive."] },
];
function caption(km) {
  const band = [...CAPTIONS].reverse().find((b) => km >= b.min);
  return band.lines[Math.floor(Math.random() * band.lines.length)];
}

// ── the match ticket ────────────────────────────────────
// What's printed on it. No names or places: it's for sharing, and friends may not have played yet.
export function ticketData({ title, day, total, results, date = new Date() }) {
  return {
    title, day, total,
    rank: rankFor(total).name,
    tiers: results.map((r) => tierFor(r.km)),
    date: date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
    seat: total.toLocaleString(),
  };
}

export function ticketHtml(t) {
  return `<div class="mticket" role="img" aria-label="${esc(`${t.title}, Daily #${t.day}: ${t.rank}, ${t.total.toLocaleString()} points`)}">
    <div class="mt-main">
      <small>${esc(t.title)} · Daily #${t.day}</small>
      <b class="mt-rank">${esc(t.rank)}</b>
      <span class="mt-score">${t.total.toLocaleString()} <i>of 5,000</i></span>
      <span class="mt-squares">${t.tiers.map((x) => `<i style="background:${x.color}" title="${esc(x.name)}"></i>`).join("")}</span>
    </div>
    <div class="mt-stub">
      <span>${esc(t.date)}</span>
      <span>Seat<b>${t.seat}</b></span>
    </div>
  </div>`;
}

// The same ticket drawn on a canvas (1200 × 600), for sharing as a picture. Fonts are the page's own.
export async function ticketPng(t) {
  await document.fonts?.ready;
  const W = 1200, H = 600, STUB = 300, R = 26;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const ink = color("--text"), paper = color("--primary"), cream = color("--bg");
  g.fillStyle = cream; g.fillRect(0, 0, W, H);
  // the ticket: a yellow card with notches at the tear line
  g.fillStyle = paper;
  g.beginPath();
  g.roundRect(40, 40, W - 80, H - 80, 18);
  g.fill();
  g.fillStyle = cream;
  for (const y of [40, H - 40]) { g.beginPath(); g.arc(W - 40 - STUB, y, R, 0, Math.PI * 2); g.fill(); }
  // the perforation
  g.strokeStyle = ink; g.lineWidth = 4; g.setLineDash([14, 12]);
  g.beginPath(); g.moveTo(W - 40 - STUB, 40 + R + 8); g.lineTo(W - 40 - STUB, H - 40 - R - 8); g.stroke();
  g.setLineDash([]);
  // the main part
  g.fillStyle = ink; g.textBaseline = "alphabetic";
  g.font = `700 30px "Barlow", sans-serif`;
  g.fillText(`${t.title.toUpperCase()} · DAILY #${t.day}`, 90, 130);
  g.font = `900 132px "Barlow Condensed", sans-serif`;
  fitText(g, t.rank.toUpperCase(), 90, 270, W - 80 - STUB - 110);
  g.font = `800 56px "Barlow Condensed", sans-serif`;
  g.fillText(`${t.total.toLocaleString()}`, 90, 350);
  const w = g.measureText(`${t.total.toLocaleString()}`).width;
  g.font = `700 30px "Barlow", sans-serif`;
  g.fillText("of 5,000", 90 + w + 14, 350);
  t.tiers.forEach((x, i) => {
    g.fillStyle = x.color; g.fillRect(90 + i * 92, 400, 76, 76);
    g.strokeStyle = ink; g.lineWidth = 4; g.strokeRect(90 + i * 92, 400, 76, 76);
  });
  // the stub
  const sx = W - 40 - STUB + 40;
  g.fillStyle = ink;
  g.font = `700 26px "Barlow", sans-serif`;
  g.fillText(t.date, sx, 130);
  g.fillText("SEAT", sx, 330);
  g.font = `900 72px "Barlow Condensed", sans-serif`;
  fitText(g, t.seat, sx, 410, STUB - 70);
  g.font = `700 22px "Barlow", sans-serif`;
  g.fillText("willbrucee.github.io", sx, 500);
  g.fillText("/home-ground", sx, 528);
  return new Promise((ok) => c.toBlob(ok, "image/png"));
}

function fitText(g, text, x, y, maxW) {
  const size = parseFloat(g.font.match(/(\d+)px/)[1]);
  const w = g.measureText(text).width;
  if (w > maxW) g.font = g.font.replace(/\d+px/, `${Math.floor(size * maxW / w)}px`);
  g.fillText(text, x, y);
}

// ── the league table ────────────────────────────────────
// Your last seven days of this game (from the device's history), today highlighted, and three numbers.
// Only the official daily counts; replays and practice never reach the history.
export function leagueHtml({ history, today, streak }) {
  const played = Object.keys(history).map(Number).filter((d) => d <= today);
  if (!played.length) {
    return `<div class="league"><h3>Your season</h3><p class="league-empty">Finish today's five to start your table.</p></div>`;
  }
  const rows = [];
  for (let d = today; d > today - 7 && d >= 0; d--) {
    const pts = history[d];
    rows.push(`<tr class="${d === today ? "today" : ""}${pts == null ? " missed" : ""}">
      <td>#${d + 1}</td><td>${pts == null ? "Didn't play" : esc(rankFor(pts).name)}</td><td>${pts == null ? "–" : pts.toLocaleString()}</td></tr>`);
  }
  const totals = played.map((d) => history[d]);
  const best = Math.max(...totals), avg = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
  return `<div class="league">
    <h3>Your season</h3>
    <table><thead><tr><th>Day</th><th>Rank</th><th>Points</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    ${played.length === 1 ? `<p class="league-empty">Play again tomorrow to start your table.</p>` : ""}
    <div class="league-stats">
      <div><b>${streak}</b><span>Streak</span></div>
      <div><b>${best.toLocaleString()}</b><span>Best day</span></div>
      <div><b>${avg.toLocaleString()}</b><span>Average</span></div>
    </div>
  </div>`;
}

