// Game flow: load players, pick today's five, handle guesses and the scorecard.
import { ROUNDS } from "./config.js";
import { createMap } from "./map.js";
import { distanceKm } from "./geo.js";
import { dayNumber, dailyPicks, practicePicks } from "./daily.js";
import { TIERS, tierFor, reactionFor } from "./tiers.js";
import { initEffects, playEffect, clearEffects } from "./effects.js";
import { getUnit, toggleUnit, formatNumber, formatDistance } from "./units.js";

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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── state ───────────────────────────────────────────────
const today = dayNumber();
const dailyKey = `hg:day:${today}`;
let players = [];
let countryIndex = new Map(); // lower-case country name or alias → { name, fit } of its map shape
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
  // replay the card's fade-in for the new name
  const card = $("#qcard");
  card.classList.remove("enter"); void card.offsetWidth; card.classList.add("enter");
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
  const kmBefore = totalKm() - km;
  const show = (t) => {
    $("#distNow").textContent = formatNumber(km * t);
    $("#ptsNow").textContent = Math.round(pts * t).toLocaleString();
    $("#total").textContent = Math.round(before + pts * t).toLocaleString();
    $("#distTotal").textContent = formatNumber(kmBefore + km * t);
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
const totalKm = () => results.reduce((s, r) => s + r.km, 0);

// ── rendering ───────────────────────────────────────────
function renderAll() {
  $("#puzzleNo").textContent = mode === "daily"
    ? `Daily #${today + 1} · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : "Practice round";
  // Round tracker: numbered chips; finished rounds take their tier colour, the current one is outlined.
  $("#tracker").innerHTML = Array.from({ length: ROUNDS }, (_, i) => {
    const r = results[i];
    const state = r ? "done" : i === round && phase !== "done" ? "now" : "todo";
    const label = r ? `Round ${i + 1}: ${tierFor(r.km).name}` : `Round ${i + 1}`;
    return `<li class="chip" data-state="${state}"${r ? ` style="--c:${tierFor(r.km).color}"` : ""} aria-label="${label}">${i + 1}</li>`;
  }).join("");
  $("#total").textContent = total().toLocaleString();
  $("#distTotal").textContent = formatNumber(totalKm());
  renderUnitButton();

  const it = items[Math.min(round, ROUNDS - 1)];
  $("#roundLbl").textContent = phase === "done" ? "Full time" : `Round ${round + 1} of ${ROUNDS}`;
  $("#unitBtn").title = "Switch km / miles";
  $("#kindLbl").textContent = it.type === "team" ? "Team" : "Athlete";
  $("#sportLbl").textContent = it.sport;
  $("#who").textContent = phase === "done" ? `${total().toLocaleString()} points` : it.name;
  $("#ask").textContent = phase === "done" ? "Scorecard's in. Open it to share your result."
    : it.type === "team" ? "Home city. Pin the place they play home games." : "Birthplace. Pin the city on the map.";
  if (phase === "done") { $("#kindLbl").textContent = mode === "daily" ? "Daily set" : "Practice"; $("#sportLbl").textContent = `${ROUNDS} rounds`; }

  renderPortrait(phase === "done" ? null : it);
  renderRail();
}

function renderRail() {
  const rail = $("#rail");
  const footer = rail.parentElement;
  footer.classList.toggle("is-result", phase === "reveal");
  if (phase === "guess") {
    const it = items[round];
    const status = hintUsed ? `<b>Country: ${esc(it.country)}.</b> Half points now.`
      : guess ? "Pin down. Tap somewhere else to move it." : "Drag to pan, pinch or scroll to zoom, tap to drop a pin.";
    rail.innerHTML = `<div class="status">${status}</div>
      ${hintUsed ? "" : `<button class="secondary" id="hintBtn" title="Shows the country on the map. Halves this round's points.">Reveal country <span>(−50%)</span></button>`}
      <button class="primary" id="lockBtn" ${guess ? "" : "disabled"}>Lock it in</button>`;
    $("#lockBtn").onclick = lockIn;
    if (!hintUsed) $("#hintBtn").onclick = revealCountry;
  } else if (phase === "reveal") {
    // The stat card: tier, the distance (big), the score, then the answer and a one-line reaction.
    const it = items[round], r = results[round];
    const t = tierFor(r.km);
    footer.style.setProperty("--tier", t.color);
    rail.innerHTML = `<div class="result">
        <div class="stat big"><b id="distNow">${formatNumber(r.km)}</b><span>${getUnit()} off</span></div>
        <div class="stat"><b id="ptsNow">${r.pts.toLocaleString()}</b><span>pts${r.hint ? " · hint" : ""}</span></div>
        <div class="tier-badge">${t.name}</div>
        <div class="place">${esc(it.city)} <small>${esc(it.country)}${it.hint ? ` · ${esc(it.hint.replace(/^Home ground: /, ""))}` : ""}</small></div>
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

// ── picture of the athlete / team ─────────────────────
// The box has a fixed size, so nothing shifts when the picture arrives. Until it has loaded (or if
// there is none, or it fails) the box shows an initials badge, so a broken image is never visible.
// The img stays in the layout but transparent while loading: a lazy image that's display:none never loads.
function renderPortrait(it) {
  const img = $("#portraitImg"), initials = $("#initials"), creditBtn = $("#creditBtn"), credit = $("#credit");
  $("#portrait").hidden = !it;
  credit.hidden = true;
  creditBtn.setAttribute("aria-expanded", "false");
  if (!it) return;
  if (img.dataset.for === it.id) return; // already showing this one
  img.dataset.for = it.id;

  initials.textContent = it.name.split(/[\s-]+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  $("#portrait").dataset.kind = it.type; // logos are shown whole, photos are cropped to the face
  img.classList.remove("loaded");
  img.removeAttribute("src");
  creditBtn.hidden = true;
  if (!it.image) return;

  img.alt = it.name;
  img.onload = () => { if (img.dataset.for === it.id) { img.classList.add("loaded"); creditBtn.hidden = false; } };
  img.onerror = () => { img.classList.remove("loaded"); img.removeAttribute("src"); creditBtn.hidden = true; };
  img.src = it.image;
  credit.innerHTML = creditLine(it);
}

// "Photo: Jane Doe · CC BY-SA 4.0 · Wikimedia Commons" (licences like CC BY-SA require this)
function creditLine(it) {
  const what = it.type === "team" ? "Logo" : "Photo";
  return `${what}: ${esc(it.imageAuthor || "Unknown")} · ${esc(it.imageLicense || "")} · <a href="${esc(it.imagePage)}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
}

function shareText() {
  const head = mode === "daily" ? `Home Ground #${today + 1}` : "Home Ground (practice)";
  const tiers = results.map((r) => tierFor(r.km));
  return [
    `${head} · ${total().toLocaleString()}/${(ROUNDS * 1000).toLocaleString()}`,
    tiers.map((t) => t.share).join(""),
    tiers.map((t) => t.name).join(" · "),
    results.map((r) => formatDistance(r.km)).join(" · "),
  ].join("\n");
}

// Credits for every picture in this set, shown at the bottom of the scorecard.
function imageCredits() {
  const withImages = items.filter((it) => it.image);
  if (!withImages.length) return "";
  return `<details class="credits"><summary>Image credits</summary><ul>${withImages
    .map((it) => `<li><b>${esc(it.name)}</b>: ${creditLine(it)}</li>`).join("")}</ul></details>`;
}

let timer = null;
let sheetKind = null; // which overlay is open, so a unit switch can redraw it
function showSummary() {
  sheetKind = "summary";
  const st = store.get("hg:stats", { played: 0, streak: 0, best: 0 });
  const rows = items.map((it, i) => {
    const r = results[i];
    return `<div class="row"><span class="sq" style="background:${tierFor(r.km).color}"></span>
      <div class="nm"><b>${esc(it.name)}</b><span>${esc(it.city)}, ${esc(it.country)}</span></div>
      <div class="sc">${r.pts.toLocaleString()}<small>${formatDistance(r.km)}${r.hint ? " · hint" : ""}</small></div></div>`;
  }).join("");
  openSheet(`<div class="card" role="dialog" aria-labelledby="sumTitle">
    <h2 id="sumTitle">${mode === "daily" ? "Full time" : "Practice over"}</h2>
    <div class="final"><b>${total().toLocaleString()}</b><span>of ${(ROUNDS * 1000).toLocaleString()}</span></div>
    <div class="rows">${rows}</div>
    ${mode === "daily" ? `<div class="stats"><div><b>${st.played}</b><span>Played</span></div><div><b>${st.streak}</b><span>Streak</span></div><div><b>${st.best.toLocaleString()}</b><span>Best</span></div></div>` : ""}
    ${imageCredits()}
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
function fallbackCopy(text, { quiet = false } = {}) {
  const card = $("#sheet .card");
  let ta = $("#shareTa");
  if (!ta) {
    ta = document.createElement("textarea");
    ta.id = "shareTa"; ta.rows = 4; ta.readOnly = true; ta.className = "share-box";
    card.insertBefore(ta, card.querySelector(".actions"));
  }
  ta.value = text;
  if (quiet) return; // just refreshing the text (e.g. after a unit switch)
  ta.focus(); ta.select();
  toast("Copy blocked. Select the text above instead.");
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 1800);
}
function openSheet(html) { const s = $("#sheet"); s.innerHTML = html; s.hidden = false; s.querySelector("button")?.focus({ preventScroll: true }); }
function hideSheet() { $("#sheet").hidden = true; sheetKind = null; clearInterval(timer); }

// "under 25 km", "25–150 km", ..., "5,000 km +" in the player's unit. Thresholds themselves stay in km.
function tierRange(i) {
  const t = TIERS[i], prev = TIERS[i - 1];
  if (i === 0) return `under ${formatDistance(t.maxKm)}`;
  if (t.maxKm === Infinity) return `${formatDistance(prev.maxKm)} +`;
  return `${formatNumber(prev.maxKm)}–${formatDistance(t.maxKm)}`;
}

function showHelp() {
  sheetKind = "help";
  openSheet(`<div class="card" role="dialog" aria-labelledby="helpTitle">
    <h2 id="helpTitle">How it works</h2>
    <p>Five names a day, the same five for everyone. Athletes go where they were born. Teams go where they play home games.</p>
    <p>Drop a pin and lock it in. Closer means more points, up to 1,000 a round. Asking for the country halves the round.</p>
    <div class="tier-scale">${TIERS.map((t, i) => `<div><i style="background:${t.color}"></i><b>${t.name}</b><span>${tierRange(i)}</span></div>`).join("")}</div>
    <details class="credits"><summary>Credits</summary><ul>
      <li>Satellite imagery: Esri, Maxar, Earthstar Geographics and the GIS User Community</li>
      <li>Country shapes: Natural Earth</li>
      <li>Players and teams: Wikidata</li>
      <li>Photos and logos: Wikimedia Commons. Each picture's author and licence are behind the (i) on it.</li>
      <li>Map engine: MapLibre GL JS</li>
    </ul></details>
    <div class="actions"><button class="primary" id="gotIt">Start</button></div>
  </div>`);
  $("#gotIt").onclick = hideSheet;
  store.set("hg:seenHelp", true);
}

// ── wiring (each listener is attached exactly once, here) ─────────
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") hideSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) hideSheet(); });
$("#helpBtn").onclick = showHelp;
// "Show country": costs half the round's points, names the country and lights it up on the map.
function revealCountry() {
  if (phase !== "guess" || hintUsed) return;
  hintUsed = true;
  renderAll();
  const shape = countryIndex.get(items[round].country.trim().toLowerCase());
  if (shape) gameMap.highlightCountry(shape.name, shape.fit);
  else console.warn(`No map shape for country "${items[round].country}"`);
}
// km ⇄ miles: redraw everything that shows a distance. Nothing is recalculated; scores stay as they were.
$("#unitBtn").onclick = () => {
  toggleUnit();
  const shareOpen = $("#shareTa")?.value;
  renderAll(); // header, clue, rail (including the result card)
  if (sheetKind === "summary") { showSummary(); if (shareOpen) fallbackCopy(shareText(), { quiet: true }); }
  if (sheetKind === "help") showHelp();
};
function renderUnitButton() {
  const u = getUnit();
  $("#unitBtn").textContent = u;
  $("#unitBtn").setAttribute("aria-label", `Distances in ${u === "km" ? "kilometres" : "miles"}. Switch to ${u === "km" ? "miles" : "kilometres"}`);
}
$("#creditBtn").onclick = () => {
  const open = $("#credit").hidden;
  $("#credit").hidden = !open;
  $("#creditBtn").setAttribute("aria-expanded", String(open));
};

// ── start ───────────────────────────────────────────────
async function boot() {
  const [playersRes, countriesRes] = await Promise.all([fetch("data/players.json"), fetch("data/countries.geojson")]);
  players = await playersRes.json();
  for (const f of (await countriesRes.json()).features) {
    const { name, aliases, fit } = f.properties;
    for (const key of [name.toLowerCase(), ...aliases]) countryIndex.set(key, { name, fit });
  }
  startDaily();
  if (!store.get("hg:seenHelp", false) && phase !== "done") showHelp();
}
boot().catch((err) => {
  console.error(err);
  $("#who").textContent = "No players loaded";
  $("#ask").textContent = "The player list didn't load. Serve this folder with a web server (see README) and reload.";
});
