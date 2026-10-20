// Game flow: load players, pick today's five, handle guesses and the scorecard.
import { ROUNDS } from "./config.js";
import { createMap } from "./map.js";
import { distanceKm } from "./geo.js";
import { dayNumber, dailyPicks, practicePicks } from "./daily.js";
import { TIERS, tierFor, reactionFor } from "./tiers.js";
import { initEffects, playEffect, clearEffects } from "./effects.js";

const $ = (s) => document.querySelector(s);

// localStorage can be blocked (private browsing etc.), so every access is wrapped.
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ── scoring ─────────────────────────────────────────────
// 1000 points within 25 km, then it falls away smoothly: ~920 at 100 km, ~435 at 1,000 km.
function pointsFor(km, hintUsed) {
  const p = km <= 25 ? 1000 : Math.round(1000 * Math.exp(-km / 1200));
  return hintUsed ? Math.round(p / 2) : p;
}

let units = store.get("hg:units", "km");
const fmtNum = (km) => Math.round(units === "km" ? km : km * 0.621371).toLocaleString();
const fmtDist = (km) => units === "km" ? `${Math.round(km).toLocaleString()} km` : `${Math.round(km * 0.621371).toLocaleString()} mi`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── state ───────────────────────────────────────────────
const today = dayNumber();
const dailyKey = `hg:day:${today}`;
let players = [];
let mode = "daily", items = [], results = [], round = 0;
let phase = "guess"; // "guess" → "reveal" → (next round) … → "done"
let guess = null, hintUsed = false;

const gameMap = createMap($("#map"), { onPick: placeGuess });
initEffects($("#fx"));
window.homeGround = { map: gameMap.map }; // handy for poking at the map from the browser console

function placeGuess(p) {
  if (phase !== "guess") return;
  guess = p;
  gameMap.setGuess(p);
  renderRail();
}

function startDaily() {
  mode = "daily";
  items = dailyPicks(players, today);
  results = store.get(dailyKey, []);
  round = results.length;
  if (round >= ROUNDS) { phase = "done"; renderAll(); showSummary(); return; }
  beginRound();
}
function startPractice() {
  mode = "practice"; items = practicePicks(players); results = []; round = 0;
  hideSheet(); beginRound();
}
function beginRound() {
  phase = "guess"; guess = null; hintUsed = false;
  clearEffects();
  gameMap.reset();
  renderAll();
}
async function lockIn() {
  if (phase !== "guess" || !guess) return;
  const it = items[round];
  const answer = { lat: it.lat, lng: it.lng };
  const km = distanceKm(guess, answer);
  const pts = pointsFor(km, hintUsed);
  const before = total();
  const tier = tierFor(km);
  results.push({ id: it.id, km, pts, hint: hintUsed, line: reactionFor(tier) });
  if (mode === "daily") store.set(dailyKey, results);
  phase = "reveal";
  renderAll();

  // Numbers start at 0 and count up in step with the line drawing across the map.
  const distEl = $("#distNow"), ptsEl = $("#ptsNow"), totalEl = $("#total");
  const show = (t) => {
    distEl.textContent = fmtNum(km * t);
    ptsEl.textContent = Math.round(pts * t).toLocaleString();
    totalEl.textContent = Math.round(before + pts * t).toLocaleString();
  };
  show(0);
  await gameMap.showResult(guess, answer, { color: tier.color, onProgress: show });
  if (phase !== "reveal" || results.length !== round + 1) return; // player already moved on
  show(1); // land on the exact numbers
  playEffect(tier, gameMap.toScreen(answer));
}
function nextRound() {
  round++;
  if (round >= ROUNDS) { phase = "done"; finish(); return; }
  beginRound();
}
function finish() {
  if (mode === "daily") {
    const st = store.get("hg:stats", { played: 0, streak: 0, best: 0, last: null });
    if (st.last !== today) {
      st.streak = st.last === today - 1 ? st.streak + 1 : 1;
      st.played += 1; st.last = today;
      st.best = Math.max(st.best, total());
      store.set("hg:stats", st);
    }
  }
  renderAll(); showSummary();
}
const total = () => results.reduce((s, r) => s + r.pts, 0);

// ── rendering ───────────────────────────────────────────
function renderAll() {
  $("#puzzleNo").textContent = mode === "daily"
    ? `Daily #${today + 1} · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : "Practice round";
  $("#pips").innerHTML = Array.from({ length: ROUNDS }, (_, i) => {
    const r = results[i];
    const style = r ? ` style="background:${tierFor(r.km).color};border-color:${tierFor(r.km).color}"` : "";
    return `<span class="pip${i === round && phase !== "done" ? " now" : ""}"${style}></span>`;
  }).join("");
  $("#total").textContent = total().toLocaleString();
  $("#unitBtn").textContent = units;

  const it = items[Math.min(round, ROUNDS - 1)];
  $("#roundLbl").textContent = phase === "done" ? "Full time" : `Round ${round + 1} of ${ROUNDS}`;
  $("#kindLbl").textContent = it.type === "team" ? "Team" : "Athlete";
  $("#sportLbl").textContent = it.sport;
  $("#who").textContent = phase === "done" ? `${total().toLocaleString()} points` : it.name;
  $("#ask").textContent = phase === "done" ? "Scorecard's in. Open it to share your result."
    : it.type === "team" ? "Home city. Pin the place they play home games." : "Birthplace. Pin the city on the map.";
  if (phase === "done") { $("#kindLbl").textContent = mode === "daily" ? "Daily set" : "Practice"; $("#sportLbl").textContent = `${ROUNDS} rounds`; }

  const hb = $("#hintBtn");
  const showCountry = hintUsed || phase !== "guess";
  hb.disabled = phase !== "guess" || hintUsed;
  hb.hidden = phase === "done";
  hb.textContent = showCountry ? [it.country, it.hint].filter(Boolean).join(" · ") : "Show country (half points)";
  renderRail();
}

function renderRail() {
  const rail = $("#rail");
  const footer = rail.parentElement;
  footer.classList.toggle("is-result", phase === "reveal");
  if (phase === "guess") {
    rail.innerHTML = `<div class="status">${guess ? "Pin down. Tap somewhere else to move it." : "Drag to pan, pinch or scroll to zoom, tap to drop a pin."}</div>
      <button class="primary" id="lockBtn" ${guess ? "" : "disabled"}>Lock it in</button>`;
    $("#lockBtn").onclick = lockIn;
  } else if (phase === "reveal") {
    // The stat card: tier, the distance (big), the score, then the answer and a one-line reaction.
    const it = items[round], r = results[round];
    const t = tierFor(r.km);
    footer.style.setProperty("--tier", t.color);
    rail.innerHTML = `<div class="result">
        <div class="stat big"><b id="distNow">${fmtNum(r.km)}</b><span>${units} off</span></div>
        <div class="stat"><b id="ptsNow">${r.pts.toLocaleString()}</b><span>pts${r.hint ? " · hint" : ""}</span></div>
        <div class="tier-badge">${t.name}</div>
        <div class="place">${esc(it.city)} <small>${esc(it.country)}</small></div>
        <div class="line">${esc(r.line || "")}</div>
      </div>
      <button class="primary" id="nextBtn">${round + 1 >= ROUNDS ? "Full time" : "Next round"}</button>`;
    $("#nextBtn").onclick = nextRound;
    $("#nextBtn").focus({ preventScroll: true });
  } else {
    rail.innerHTML = `<div class="status">${mode === "daily" ? "That's today's five. Back tomorrow for a new set." : "Practice round over."}</div>
      <button class="primary" id="sumBtn">Scorecard</button>`;
    $("#sumBtn").onclick = showSummary;
  }
}

function shareText() {
  const head = mode === "daily" ? `Home Ground #${today + 1}` : "Home Ground (practice)";
  const tiers = results.map((r) => tierFor(r.km));
  return `${head} · ${total().toLocaleString()}/${(ROUNDS * 1000).toLocaleString()}\n${tiers.map((t) => t.share).join("")}\n${tiers.map((t) => t.name).join(" · ")}`;
}

let timer = null;
function showSummary() {
  const st = store.get("hg:stats", { played: 0, streak: 0, best: 0 });
  const rows = items.map((it, i) => {
    const r = results[i];
    return `<div class="row"><span class="sq" style="background:${tierFor(r.km).color}"></span>
      <div class="nm"><b>${esc(it.name)}</b><span>${esc(it.city)}, ${esc(it.country)}</span></div>
      <div class="sc">${r.pts.toLocaleString()}<small>${fmtDist(r.km)}${r.hint ? " · hint" : ""}</small></div></div>`;
  }).join("");
  openSheet(`<div class="card" role="dialog" aria-labelledby="sumTitle">
    <h2 id="sumTitle">${mode === "daily" ? "Full time" : "Practice over"}</h2>
    <div class="final"><b>${total().toLocaleString()}</b><span>of ${(ROUNDS * 1000).toLocaleString()}</span></div>
    <div class="rows">${rows}</div>
    ${mode === "daily" ? `<div class="stats"><div><b>${st.played}</b><span>Played</span></div><div><b>${st.streak}</b><span>Streak</span></div><div><b>${st.best.toLocaleString()}</b><span>Best</span></div></div>` : ""}
    <div class="actions"><button class="primary" id="copyBtn">Copy result</button><button class="ghost" id="practiceBtn">Practice round</button></div>
    ${mode === "daily" ? `<div class="next" id="countdown"></div>` : `<button class="ghost" id="backBtn">Today's set</button>`}
    <button class="ghost quiet" id="closeBtn">Back to the map</button>
  </div>`);
  $("#copyBtn").onclick = copyResult;
  $("#practiceBtn").onclick = startPractice;
  $("#closeBtn").onclick = hideSheet;
  if ($("#backBtn")) $("#backBtn").onclick = () => { hideSheet(); startDaily(); };
  if ($("#countdown")) {
    const tick = () => {
      const n = new Date(), m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
      const s = Math.max(0, Math.floor((m - n) / 1000));
      const p = (v) => String(v).padStart(2, "0");
      const el = $("#countdown");
      if (el) el.textContent = `New set in ${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    };
    tick(); clearInterval(timer); timer = setInterval(tick, 1000);
  }
}

function copyResult() {
  const text = shareText();
  try {
    navigator.clipboard.writeText(text).then(() => toast("Result copied"), () => fallbackCopy(text));
  } catch { fallbackCopy(text); }
}
// If the clipboard is blocked, show the text in a box so it can be copied by hand.
function fallbackCopy(text) {
  const card = $("#sheet .card");
  let ta = $("#shareTa");
  if (!ta) {
    ta = document.createElement("textarea");
    ta.id = "shareTa"; ta.rows = 4; ta.readOnly = true; ta.className = "share-box";
    card.insertBefore(ta, card.querySelector(".actions"));
  }
  ta.value = text; ta.focus(); ta.select();
  toast("Copy blocked. Select the text above instead.");
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 1800);
}
function openSheet(html) { const s = $("#sheet"); s.innerHTML = html; s.hidden = false; s.querySelector("button")?.focus({ preventScroll: true }); }
function hideSheet() { $("#sheet").hidden = true; clearInterval(timer); }

function showHelp() {
  openSheet(`<div class="card" role="dialog" aria-labelledby="helpTitle">
    <h2 id="helpTitle">How it works</h2>
    <p>Five names a day, the same five for everyone. Athletes go where they were born. Teams go where they play home games.</p>
    <p>Drop a pin and lock it in. Closer means more points, up to 1,000 a round. Asking for the country halves the round.</p>
    <div class="tier-scale">${TIERS.map((t, i) => `<div><i style="background:${t.color}"></i><b>${t.name}</b><span>${i === 0 ? `under ${t.maxKm} km` : t.maxKm === Infinity ? `${TIERS[i - 1].maxKm.toLocaleString()} km +` : `${TIERS[i - 1].maxKm.toLocaleString()}–${t.maxKm.toLocaleString()} km`}</span></div>`).join("")}</div>
    <div class="actions"><button class="primary" id="gotIt">Start</button></div>
  </div>`);
  $("#gotIt").onclick = hideSheet;
  store.set("hg:seenHelp", true);
}

// ── wiring (each listener is attached exactly once, here) ─────────
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") hideSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) hideSheet(); });
$("#helpBtn").onclick = showHelp;
$("#hintBtn").onclick = () => { if (phase === "guess") { hintUsed = true; renderAll(); } };
$("#unitBtn").onclick = () => {
  units = units === "km" ? "mi" : "km";
  store.set("hg:units", units);
  renderAll();
  if (!$("#sheet").hidden && phase === "done") showSummary();
};
document.querySelectorAll("[data-basemap]").forEach((btn) => {
  btn.onclick = () => {
    gameMap.setBasemap(btn.dataset.basemap);
    store.set("hg:basemap", btn.dataset.basemap);
    document.querySelectorAll("[data-basemap]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  };
});

// No imagery (blocked or offline): hide the Satellite/Relief switch, since it would do nothing.
document.addEventListener("imagery-unavailable", () => {
  document.querySelector("[data-basemap]").parentElement.hidden = true;
});

function setCities(on) {
  gameMap.setCitiesVisible(on);
  store.set("hg:cities", on);
  $("#citiesBtn").setAttribute("aria-pressed", String(on));
}
$("#citiesBtn").onclick = () => setCities($("#citiesBtn").getAttribute("aria-pressed") !== "true");

// ── start ───────────────────────────────────────────────
async function boot() {
  const res = await fetch("data/players.json");
  players = await res.json();
  const savedBase = store.get("hg:basemap", null);
  if (savedBase) document.querySelector(`[data-basemap="${savedBase}"]`)?.click();
  if (store.get("hg:cities", true) === false) setCities(false);
  startDaily();
  if (!store.get("hg:seenHelp", false) && phase !== "done") showHelp();
}
boot().catch((err) => {
  console.error(err);
  $("#who").textContent = "No players loaded";
  $("#ask").textContent = "The player list didn't load. Serve this folder with a web server (see README) and reload.";
});
