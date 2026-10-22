// Game flow: load players, pick today's five, handle guesses and the scorecard.
import { ROUNDS, ROUND_SECONDS } from "./config.js";
import { createMap } from "./map.js";
import { distanceKm, pointAlong } from "./geo.js";
import { dayNumber, dailyPicks, practicePicks } from "./daily.js";
import { TIERS, LADDER, tierFor, reactionFor, rankFor, useScale } from "./tiers.js";
import { initEffects, playEffect, clearEffects } from "./effects.js";
import { sportIcon } from "./sporticons.js";
import { loadPlaces, describeSpot } from "./fulltime.js";
import { createSummaryMap } from "./summarymap.js";
import { createClimb } from "./climb.js";
import { LEVELS, levelFor, rarityKey, loadVault, vaultHtml, cardHtml, collect } from "./vault.js";
import { getUnit, toggleUnit, formatNumber, formatDistance, pickSportsUnit, loadFacts, sportsDistance, cityFact } from "./units.js";
import { awards, ticketData, ticketHtml, ticketPng, leagueHtml } from "./endscreen.js";
import { MODES, modeFromUrl, normalise } from "./modes.js";

const $ = (s) => document.querySelector(s);

// localStorage can be blocked (private browsing etc.), so every access is wrapped.
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ── scoring ─────────────────────────────────────────────
// The answer is a whole city: a circle of radius_km around its centre (see the build script).
// Scores use the distance to the edge of that circle, so any guess inside the city is 0 km off.
const DEFAULT_RADIUS_KM = 8;
// 1000 points within 25 km of the city's edge, then a long, gentle fall: ~920 at 100 km, ~700 at 800 km,
// ~490 at 2,500 km, ~340 at 5,000 km. Set with scripts/simulate_ranks.py so that casual, good and expert
// players spread across the ranks (keep CURVE there in step with these numbers).
// A game mode can set its own curve (js/modes.js "curve"); these are the daily mix's.
const CURVE = { full: 25, scale: 4400, power: 0.6 };
function pointsFor(km, hintUsed) {
  const { full, scale, power } = MODE.curve || CURVE;
  const p = km <= full ? 1000 : Math.round(1000 * Math.exp(-(((km - full) / scale) ** power)));
  return hintUsed ? Math.round(p / 2) : p;
}

// Before the guess a team shows only its nickname ("Dodgers", not "Los Angeles Dodgers"): the full
// name often contains the answer. Full names appear from the result onwards.
const shownName = (it, revealed) => (revealed ? it.name : it.display_name || it.name);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── state ───────────────────────────────────────────────
const today = dayNumber();
// The mode being played (Daily mix or Football). Each keeps its own results, streak and stats on the device.
let MODE = MODES.mix;
const key = (name) => MODE.prefix + name;            // "hg:stats" in the mix, "hg:fb:stats" in Football
const dailyKey = () => key(`day:${today}`);
const picksFor = (day) => ({ rounds: MODE.rounds(day), salt: MODE.salt });
let players = [];
let countryIndex = new Map(); // lower-case country name or alias → { name, fit } of its map shape
let countryShapes = [];       // the GeoJSON features themselves (for the Full time map)
let mode = "daily", items = [], results = [], round = 0;
// ?preview: practice from the whole pool, even on launch day. It can show future dailies, so it isn't linked anywhere.
const PREVIEW = new URLSearchParams(location.search).has("preview");
let phase = "guess"; // "guess" → "reveal" → (next round) … → "done"
let guess = null, hintUsed = false;

const gameMap = createMap($("#map"), { onPick: placeGuess, insets: coveredEdges });
let live = createClimb($("#ladderLive"), { compact: true }); // the rank staircase during the game (redrawn per mode)

// How much of each screen edge the overlays cover, so the camera frames results in the open map.
function coveredEdges() {
  const h = innerHeight, w = innerWidth;
  const bar = $(".bar").getBoundingClientRect(), dock = $("#dock").getBoundingClientRect(), ticket = $("#ticket").getBoundingClientRect();
  const phone = matchMedia("(max-width: 720px)").matches;
  const ticketShown = !$("#ticket").hidden;
  const ladder = $("#ladderLive").getBoundingClientRect(), ladderShown = !$("#ladderLive").hidden;
  return {
    top: phone && ladderShown ? Math.max(bar.bottom, ladder.bottom) : bar.bottom, // phones: a strip under the header
    // on phones the ticket sits on top of the dock at the bottom
    bottom: h - Math.min(dock.height ? dock.top : h, phone && ticketShown ? ticket.top : h),
    // on desktop the ticket runs down the left-hand side
    left: !phone && ticketShown ? ticket.right : 0,
    right: !phone && ladderShown ? w - ladder.left + 8 : Math.min(60, w * 0.05), // the ladder, or the zoom buttons
  };
}
initEffects($("#fx"));
window.homeGround = { map: gameMap.map }; // handy for poking at the map from the browser console

function placeGuess(p) {
  if (phase !== "guess") return;
  guess = p;
  gameMap.setGuess(p, items[round].sport);
  renderDock();
}

function startDaily() {
  mode = "daily";
  items = dailyPicks(players, today, picksFor(today));
  results = store.get(dailyKey(), []);
  round = results.length;
  if (round >= ROUNDS) { phase = "done"; renderAll(); showSummary(); return; }
  beginRound();
}
// Play today's five again. Nothing is saved, so the streak, stats and today's recorded score stay as they were.
function startReplay() {
  mode = "replay"; items = dailyPicks(players, today, picksFor(today)); results = []; round = 0;
  hideSheet(); beginRound();
}
function startPractice() {
  mode = "practice"; items = practicePicks(players, today, PREVIEW, picksFor); results = []; round = 0;
  hideSheet(); beginRound();
}
function beginRound() {
  phase = "guess"; guess = null; hintUsed = false;
  startClock();
  clearEffects();
  gameMap.reset();
  setFolded(store.get("hg:folded", false)); // the player's choice; phones re-open it for each new name
  renderAll();
  // deal the ticket in for the new name
  const t = $("#ticket");
  t.classList.remove("enter"); void t.offsetWidth; t.classList.add("enter");
}
// timedOut: the clock ran out with no pin on the map. The round scores 0 and the answer is shown.
async function lockIn({ timedOut = false } = {}) {
  if (phase !== "guess" || (!guess && !timedOut)) return;
  stopClock();
  const it = items[round];
  const answer = { lat: it.lat, lng: it.lng };
  gameMap.prefetchAround(answer); // start loading the answer's area now; the camera heads there next
  const radius = it.radius_km || DEFAULT_RADIUS_KM;
  const noPin = !guess;
  const rawKm = noPin ? HALF_WORLD_KM : distanceKm(guess, answer); // to the city centre (shown on the card)
  const km = noPin ? HALF_WORLD_KM : Math.max(0, rawKm - radius);  // to the city's edge: used for points, tier and sharing
  const inside = km === 0;
  const pts = noPin ? 0 : pointsFor(km, hintUsed);
  const before = total();
  const tier = tierFor(km);
  const played = results.length + 1;
  const at = noPin ? null : { lat: +guess.lat.toFixed(3), lng: +guess.lng.toFixed(3) }; // kept for the Full time map
  results.push({ id: it.id, guess: at, km, rawKm, inside, pts, hint: hintUsed, ...(noPin ? { noPin: true } : {}),
    line: noPin ? "Out of time. No pin, no points." : reactionFor(tier, inside), sports: noPin ? "" : pickSportsUnit(km, it.sport, results.map((x) => x.sports)) });
  if (mode === "daily") store.set(dailyKey(), results);
  const card = collect(it.id, pts, today); // the card you win: "new", "upgrade" or ""
  loadVault(MODE.vault); // fetch the Vault's facts in the background, ready for the button
  phase = "reveal";
  setFolded(true); // fold the ticket to just the name, to make room for the result
  renderAll();
  live.set(before, played - 1); // the ball hops up once the result is in (below)

  // Numbers start at 0 and count up in step with the line drawing across the map.
  const kmBefore = totalKm() - (noPin ? 0 : km);
  const show = (t) => {
    $("#distNow").textContent = noPin ? "–" : formatNumber(km * t);
    $("#ptsNow").textContent = Math.round(pts * t).toLocaleString();
    $("#total").textContent = Math.round(before + pts * t).toLocaleString();
    $("#distTotal").textContent = formatNumber(kmBefore + (noPin ? 0 : km) * t);
  };
  show(0);
  // The line stops at the city's edge (or doesn't appear at all if the pin is already inside).
  const from = guess || answer; // out of time with no pin: no line, just the answer
  const lineEnd = inside || noPin ? from : pointAlong(guess, answer, rawKm - radius);
  await gameMap.showResult(from, answer, { color: tier.color, onProgress: show, radiusKm: radius, lineEnd });
  if (phase !== "reveal" || results.length !== round + 1) return; // player already moved on
  show(1); // land on the exact numbers
  live.climb(before, before + pts, played); // the ball hops up the staircase
  playEffect(tier, gameMap.toScreen(answer));
  if (card) toast(`${card === "new" ? "New card" : "Card upgraded"}: ${LEVELS[levelFor(pts)].card}`);
}
function nextRound() {
  round++;
  if (round >= ROUNDS) { phase = "done"; finish(); return; }
  beginRound();
}
function finish() {
  if (mode === "daily") {
    const st = store.get(key("stats"), { played: 0, streak: 0, best: 0, last: null });
    if (st.last !== today) {
      st.streak = st.last === today - 1 ? st.streak + 1 : 1;
      st.played += 1; st.last = today;
      st.best = Math.max(st.best, total());
      st.maxStreak = Math.max(st.maxStreak || 0, st.streak);
      store.set(key("stats"), st);
      const history = store.get(key("history"), {}); // every finished daily's total, for the stats screen
      history[today] = total();
      store.set(key("history"), history);
    }
  }
  renderAll(); showSummary();
}
const total = () => results.reduce((s, r) => s + r.pts, 0);
const HALF_WORLD_KM = 20015; // the furthest two places can be: a round with no pin counts as this far off

// ── the round clock ─────────────────────────────────────
// ROUND_SECONDS to place a pin. It only runs while the map is in view (it waits while the help or any
// other panel is open). At zero your pin is locked in; with no pin, the round is "out of time".
let clockLeft = 0, clockLast = 0, clockFrame = 0;
function startClock() {
  stopClock();
  clockLeft = ROUND_SECONDS * 1000; clockLast = performance.now();
  const tick = (now) => {
    const dt = now - clockLast; clockLast = now;
    if (phase !== "guess") return;
    if ($("#sheet").hidden && !document.hidden) clockLeft -= dt;
    drawClock();
    if (clockLeft <= 0) { lockIn({ timedOut: true }); return; }
    clockFrame = requestAnimationFrame(tick);
  };
  clockFrame = requestAnimationFrame(tick);
}
function stopClock() { cancelAnimationFrame(clockFrame); }
function drawClock() {
  const el = $("#clock");
  if (!el) return;
  const s = Math.max(0, Math.ceil(clockLeft / 1000));
  el.style.setProperty("--left", Math.max(0, clockLeft / (ROUND_SECONDS * 1000)));
  el.classList.toggle("hurry", s <= 5);
  const b = el.querySelector("b");
  if (b.textContent !== String(s)) { b.textContent = s; el.setAttribute("aria-label", `${s} seconds left`); }
}
const totalKm = () => results.reduce((s, r) => s + (r.noPin ? 0 : r.km), 0); // rounds with no pin have no distance

// ── rendering ───────────────────────────────────────────
function renderAll() {
  $("#puzzleNo").textContent = mode === "daily"
    ? `Daily #${today + 1} · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : mode === "replay" ? `Daily #${today + 1} · replay` : "Practice round";
  $("#modeBtn").textContent = MODE.name;
  // Streak: days in a row with the daily set finished. It's still "alive" until a full day is missed.
  const st = store.get(key("stats"), { streak: 0, last: null });
  const streak = st.last === today || st.last === today - 1 ? st.streak : 0;
  $("#streakBox").hidden = streak < 1;
  $("#streak").textContent = streak;
  // Round tracker: numbered chips; finished rounds take their tier colour, the current one is outlined.
  $("#tracker").innerHTML = Array.from({ length: ROUNDS }, (_, i) => {
    const r = results[i];
    const state = r ? "done" : i === round && phase !== "done" ? "now" : "todo";
    const label = r ? `Round ${i + 1}: ${tierFor(r.km).name}` : `Round ${i + 1}`;
    return `<li class="chip" data-state="${state}"${r ? ` style="--c:${tierFor(r.km).color}"` : ""} aria-label="${label}">${i + 1}</li>`;
  }).join("");
  $("#total").textContent = total().toLocaleString();
  $("#distTotal").textContent = formatNumber(totalKm());
  $("#ladderLive").hidden = phase === "done" || !players.length;
  if (phase !== "reveal") live.set(total(), results.length);
  renderUnitButton();

  const it = items[Math.min(round, ROUNDS - 1)];
  $("#roundLbl").textContent = phase === "done" ? "Full time" : `Round ${round + 1} / ${ROUNDS}`;
  $("#unitBtn").title = "Switch km / miles";
  // Football: "Legend" or "Current player" (nothing that hints at the place)
  $("#kindLbl").textContent = it.list ? (it.list === "legend" ? "Legend" : "Current player") : it.type === "team" ? "Team" : "Athlete";
  // the sport's icon next to its name (sportIcon returns trusted, hand-written SVG)
  $("#sportLbl").innerHTML = `${sportIcon(it.sport)}<span>${esc(it.sport)}</span>`;
  const revealed = phase !== "guess";
  $("#who").textContent = phase === "done" ? `${total().toLocaleString()} points` : shownName(it, revealed);
  document.title = phase === "done" ? "Full time · Home Ground" : `${shownName(it, revealed)} · Home Ground`;
  $("#ask").innerHTML = phase === "done" ? "<b>Full time</b>The scorecard's in."
    : it.type === "team" ? "<b>Where's home?</b>Pin the city they play in."
    : `<b>${it.female === true ? "Where was she" : it.female === false ? "Where was he" : "Where were they"} born?</b>Pin the town on the map.`;
  if (phase === "done") { $("#kindLbl").textContent = mode === "practice" ? "Practice" : "Daily set"; $("#sportLbl").textContent = `${ROUNDS} rounds`; }

  renderPortrait(phase === "done" ? null : it, revealed);
  renderDock();
}

// The dock: big "Lock in guess" button while guessing, the result panel after.
function renderDock() {
  const dock = $("#dock");
  dock.classList.toggle("result-mode", phase === "reveal");
  if (phase === "guess") {
    const it = items[round];
    dock.innerHTML = `
      <div class="clock" id="clock" role="timer" aria-label="${ROUND_SECONDS} seconds left"><b>${Math.max(0, Math.ceil(clockLeft / 1000))}</b><i aria-hidden="true"></i></div>
      ${hintUsed ? `<div class="status"><b>Country: ${esc(it.country)}.</b> Half points now.</div>`
        : `<button class="minor" id="hintBtn" title="Shows the country on the map. Halves this round's points.">Reveal country <span>−50%</span></button>`}
      <button class="go" id="lockBtn" ${guess ? "" : "disabled"}>${guess ? "Lock in guess" : "Drop a pin first"}</button>`;
    $("#lockBtn").onclick = () => lockIn();
    drawClock();
    if (!hintUsed) $("#hintBtn").onclick = revealCountry;
  } else if (phase === "reveal") {
    // The scoreboard panel: huge distance, the points, the tier stamped on, then the answer.
    const it = items[round], r = results[round];
    const t = tierFor(r.km);
    dock.style.setProperty("--tier", t.color);
    dock.style.setProperty("--tier-ink", t.ink);
    dock.innerHTML = `<div class="result">
        <div class="stat big"><b id="distNow">${r.noPin ? "–" : formatNumber(r.km)}</b><span>${r.noPin ? "no pin" : r.inside ? "inside the city" : `${getUnit()} from the city`}</span></div>
        <div class="stat"><b id="ptsNow">${r.pts.toLocaleString()}</b><span>points${r.hint ? " · hint" : ""}</span></div>
        <div class="stamp">${r.noPin ? "Out of time" : t.name}</div>
        <div class="place">${placeLine(it)}</div>
        <div class="line">${r.inside ? "Inside the city limits. " : ""}${esc(r.line || "")}</div>
        <button class="go next" id="nextBtn">${round + 1 >= ROUNDS ? "Full time" : "Next round"}</button>
        ${it.achievement ? `<div class="honours"><span>Honours</span> ${esc(it.achievement)}</div>` : ""}
        <button class="vault-btn" id="vaultBtn" style="--rar:var(--r-${rarityKey(r.pts)})"><i>${LEVELS[levelFor(r.pts)].card}</i>Open the Vault · ${levelFor(r.pts) + 1} of 5 unlocked</button>
      </div>`;
    $("#nextBtn").onclick = nextRound;
    $("#vaultBtn").onclick = () => showVault(round);
    $("#nextBtn").focus({ preventScroll: true });
  } else {
    dock.innerHTML = `<div class="status">${mode === "daily" ? "That's today's five. New set tomorrow." : mode === "replay" ? "Replay over." : "Practice over."}</div>
      <button class="go" id="sumBtn">Scorecard</button>`;
    $("#sumBtn").onclick = showSummary;
  }
}

// The answer on the result card. Football: "Born in Rosario, Argentina", and the nearest big city
// ("near Buenos Aires" for a suburb, "300 km from Buenos Aires" further out), so a guess there makes sense.
function placeLine(it) {
  if (!it.list) return `${esc(it.city)} <small>${esc(it.country)}${it.hint ? ` · ${esc(it.hint.replace(/^Home ground: /, ""))}` : ""}</small>`;
  const near = it.metro ? `near ${esc(it.metro)}`
    : it.near_city && it.near_city.km >= 10 ? `${formatDistance(it.near_city.km)} from ${esc(it.near_city.name)}` : "";
  return `<span class="born">Born in</span> ${esc(it.city)} <small>${esc(it.country)}${near ? ` · ${near}` : ""}</small>`;
}

// Fold the ticket down to just the name (the player can do this to see more map).
function setFolded(folded) {
  $("#ticket").classList.toggle("folded", folded);
  $("#collapseBtn").setAttribute("aria-expanded", String(!folded));
  $("#collapseBtn .sr").textContent = folded ? "Show the question" : "Hide the question";
}

// ── picture of the athlete / team ─────────────────────
// The box has a fixed size, so nothing shifts when the picture arrives. Until it has loaded (or if
// there is none, or it fails) the box shows an initials badge, so a broken image is never visible.
// The img stays in the layout but transparent while loading: a lazy image that's display:none never loads.
function renderPortrait(it, revealed) {
  const img = $("#portraitImg"), initials = $("#initials"), creditBtn = $("#creditBtn"), credit = $("#credit");
  $("#portrait").hidden = !it;
  credit.hidden = true;
  creditBtn.setAttribute("aria-expanded", "false");
  $("#ticket").classList.toggle("done", !it);
  if (!it) return;
  // The credit (author, licence, file name) can name the place, so it's only offered after the guess.
  const showCredit = () => { creditBtn.hidden = phase === "guess" || !img.classList.contains("loaded"); };
  img.alt = shownName(it, revealed);
  if (img.dataset.for === it.id) { showCredit(); return; } // already showing this one
  img.dataset.for = it.id;

  // Fallback badge: initials over a small icon for the sport.
  const letters = shownName(it, false).split(/[\s-]+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  initials.innerHTML = `<b>${esc(letters)}</b>${sportIcon(it.sport)}`;
  $("#portrait").dataset.kind = it.type; // logos are shown whole, photos are cropped to the face
  img.classList.remove("loaded");
  img.removeAttribute("srcset");
  img.removeAttribute("src");
  creditBtn.hidden = true;
  if (!it.image) return;

  img.onload = () => { if (img.dataset.for === it.id) { img.classList.add("loaded"); showCredit(); } };
  img.onerror = () => { img.classList.remove("loaded"); img.removeAttribute("src"); creditBtn.hidden = true; };
  img.style.objectPosition = it.imageFocus || ""; // the face's spot, so the crop never cuts off the head
  // Photos come in three sizes so the 4:5 frame is always sharp (a landscape photo cropped to 4:5 shows
  // only its middle, so it needs more pixels than the frame's width). Logos are small and simple.
  const at = (w) => it.image.replace(/width=\d+/, `width=${w}`);
  if (it.type === "athlete") img.srcset = `${at(500)} 500w, ${at(960)} 960w, ${at(1280)} 1280w`; // Commons' standard sizes
  else img.removeAttribute("srcset");
  img.src = it.image;
  credit.innerHTML = creditLine(it);
}

// "Photo: Jane Doe · CC BY-SA 4.0 · Wikimedia Commons" (licences like CC BY-SA require this)
function creditLine(it) {
  const what = it.type === "team" ? "Logo" : "Photo";
  return `${what}: ${esc(it.imageAuthor || "Unknown")} · ${esc(it.imageLicense || "")} · <a href="${esc(it.imagePage)}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
}

// The share text: the game, the day, the rank and total, a square and a tier name per round, and the link.
// Never a name or a place, so it doesn't spoil the day for friends who haven't played.
function shareText() {
  const day = `#${today + 1}${mode === "replay" ? " (replay)" : mode === "practice" ? " (practice)" : ""}`;
  const head = MODE.key === "mix" ? `Home Ground ${day} · ${MODE.name}` : `${MODE.share} ${day}`;
  const done = results.length === ROUNDS;
  return [
    `${head} · ${done ? `${rankFor(total()).name} · ` : ""}${total().toLocaleString()}`,
    results.map((r) => tierFor(r.km).share).join(""),
    results.map((r) => tierFor(r.km).name).join(", "),
    `willbrucee.github.io/home-ground${MODE.key === "mix" ? "" : `/?mode=${MODE.key}`}`, // a friend lands in the same game
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

// ── Full time ───────────────────────────────────────────
// One calm scroll, top to bottom: a slim strip (the day and the game), the total and the rank with a compact
// staircase, "Your starting five" (the five rounds as cards on a pitch, 2-1-2), the match ticket beside your
// league table, then sharing and the countdown. Tapping a card opens its details below the pitch.
// It plays once: the cards slide on (150 ms apart), the awards stamp on, the ticket slides in, then nothing
// moves. Reopening, reduced motion or "Skip animation" shows it all at once.
let hero = null; // the compact staircase at the top
const cancelHero = () => { hero?.stop(); hero = null; };
let summaryMap = null;      // the small map in the details panel; removed before it's drawn again
function dropSummaryMap() { summaryMap?.destroy(); summaryMap = null; }
let ftTimers = [];          // the sequence's pending steps, cancelled if the screen is closed or redrawn
let openRound = -1;         // the card whose details are open
function showSummary({ instant = false } = {}) {
  cancelHero();
  dropSummaryMap();
  ftTimers.forEach(clearTimeout); ftTimers = [];
  sheetKind = "summary";
  const calm = instant || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!instant) openRound = -1; // a fresh Full time starts with every card closed
  const t = total(), rank = rankFor(t);
  const prize = awards(results);
  const st = store.get(key("stats"), { played: 0, streak: 0, best: 0, last: null });
  const streak = st.last === today || st.last === today - 1 ? st.streak : 0;
  const ticket = ticketData({ title: MODE.share, day: today + 1, total: t, results });
  const card = (it, i) => {
    const r = results[i], tier = tierFor(r.km);
    const tag = i === prize.motm ? `<span class="award motm">Man of the match</span>` : i === prize.disaster ? `<span class="award disaster">Disaster class</span>` : "";
    const pic = it.image
      ? `<img src="${esc(it.image.replace(/width=\d+/, "width=330"))}" alt="${esc(it.name)}" loading="lazy" width="80" height="80"${it.imageFocus ? ` style="object-position:${esc(it.imageFocus)}"` : ""} onerror="this.remove()">`
      : "";
    const initials = it.name.split(/[\s-]+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    return `<div class="pc-slot" style="--i:${i}">
      <button class="pc" type="button" data-round="${i}" style="--c:${tier.color};--c-ink:${tier.ink}" aria-expanded="false" aria-controls="ftDetail"
        aria-label="Round ${i + 1}: ${esc(it.name)}, ${esc(tier.name)}, ${r.pts.toLocaleString()} points. Show details">
        <span class="pc-av" data-kind="${it.type}"><span aria-hidden="true">${esc(initials)}</span>${pic}</span>
        <b class="pc-name">${esc(it.name)}</b>
        <span class="pc-meta">${esc(it.list ? (it.list === "legend" ? "Legend" : "Current player") : it.sport)} · <span class="pc-tier">${esc(tier.name)}</span></span>
        <span class="pc-nums"><b>${r.pts.toLocaleString()}</b> pts · ${r.noPin ? "no pin" : r.inside ? "inside" : formatDistance(r.km)}</span>
        ${tag}
      </button>
      ${i === prize.disaster ? `<p class="pc-caption">${esc(prize.caption)}</p>` : ""}
    </div>`;
  };
  const replayLink = mode !== "practice" ? `<button class="linkish" id="replayBtn">Play replay</button>` : `<button class="linkish" id="backBtn">Today's set</button>`;
  openSheet(`<div class="ft${calm ? " settled" : ""}" role="dialog" aria-labelledby="ftTitle">
    <header class="ft-strip">
      <span><img src="favicon.svg" width="22" height="22" alt="">Home Ground, Daily #${today + 1}${mode === "replay" ? " (replay)" : mode === "practice" ? " (practice)" : ""}</span>
      <span class="ft-mode">${esc(MODE.name)}</span>
      ${calm ? "" : `<button class="ft-skip" id="skipAnim" type="button">Skip animation</button>`}
    </header>
    <section class="ft-score-row" aria-labelledby="ftTitle">
      <h2 id="ftTitle" class="sr">Full time</h2>
      <div class="ft-total"><b id="ftTotal">${calm ? t.toLocaleString() : 0}</b><span>of ${(ROUNDS * 1000).toLocaleString()}</span></div>
      <div class="ft-rank"><small>Rank</small><b>${esc(rank.name)}</b></div>
    </section>
    <section class="ft-ladder" id="ftHero" aria-label="Rank ladder"></section>
    <section class="ft-pitchwrap" aria-labelledby="pitchTitle">
      <h3 id="pitchTitle">Your starting five</h3>
      <div class="pitch">${items.map(card).join("")}</div>
      <div class="ft-detail" id="ftDetail" hidden></div>
    </section>
    <section class="ft-bottom">
      <div class="ft-ticket">${ticketHtml(ticket)}</div>
      ${leagueHtml({ history: store.get(key("history"), {}), today, streak })}
    </section>
    <section class="ft-actions">
      <div class="actions"><button class="go" id="shareBtn">Share ticket</button><button class="minor" id="copyBtn">Copy text</button></div>
      <pre class="ft-sharetext" id="shareText" hidden>${esc(shareText())}</pre>
      ${mode === "daily" ? `<p class="next-in"><span id="countdown"></span></p>` : ""}
      <p class="ft-links">${replayLink}
        ${today > 0 || PREVIEW ? `<button class="linkish" id="practiceBtn">Practice round</button>` : ""}
        <button class="linkish" id="statsLink">Your stats</button>
        <button class="linkish" id="switchLink">Switch game</button>
        <button class="linkish" id="closeBtn">Back to the map</button></p>
      ${imageCredits()}
      <p class="ft-geo">Place names: GeoNames (CC BY 4.0).</p>
    </section>
  </div>`);
  $("#sheet").classList.add("full");
  $("#shareBtn").onclick = () => shareTicket(ticket);
  $("#copyBtn").onclick = copyResult;
  if ($("#practiceBtn")) $("#practiceBtn").onclick = startPractice;
  if ($("#replayBtn")) $("#replayBtn").onclick = startReplay;
  if ($("#backBtn")) $("#backBtn").onclick = () => { hideSheet(); startDaily(); };
  $("#closeBtn").onclick = hideSheet;
  $("#statsLink").onclick = showStats;
  $("#switchLink").onclick = showPicker;
  document.querySelectorAll(".pc").forEach((b) => (b.onclick = () => toggleDetail(+b.dataset.round)));
  if (openRound >= 0 && calm) toggleDetail(openRound, { keep: true }); // a redraw (km/miles) keeps the open card open

  // The sequence: count-up and the compact staircase together, the cards slide on, awards stamp, the ticket.
  hero = createClimb($("#ftHero"), { compact: true });
  const ft = $(".ft");
  const settle = () => {
    ftTimers.forEach(clearTimeout); ftTimers = [];
    hero?.skip();
    $("#ftTotal") && ($("#ftTotal").textContent = total().toLocaleString());
    ft?.classList.add("settled");
    $("#skipAnim")?.remove();
  };
  if (calm) {
    hero.climb(0, t, ROUNDS, { instant: true });
  } else {
    const start = performance.now();
    const count = (now) => {
      const el = $("#ftTotal"), p = Math.min(1, Math.max(0, (now - start) / 1000));
      if (!el || ft.classList.contains("settled")) return;
      el.textContent = Math.round(t * (1 - (1 - p) ** 2)).toLocaleString();
      if (p < 1) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    hero.climb(0, t, ROUNDS, { ms: 1000 });
    ft.classList.add("play"); // CSS: cards 150 ms apart, then the awards, then the ticket (see .ft.play)
    ftTimers.push(setTimeout(settle, 2600));
    $("#skipAnim").onclick = settle;
  }

  if ($("#countdown")) {
    const tick = () => {
      const n = new Date(), m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
      const s = Math.max(0, Math.floor((m - n) / 1000));
      const p = (v) => String(v).padStart(2, "0");
      const el = $("#countdown");
      if (el) el.textContent = `Next game in ${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    };
    tick(); clearInterval(timer); timer = setInterval(tick, 1000);
  }
}

// A card's details, below the pitch (not a modal): where you said and where it was, a small map of that
// round, the distance fact, and its Vault levels and card. The same card again (or Close) folds it away.
async function toggleDetail(i, { keep = false } = {}) {
  const panel = $("#ftDetail");
  if (!panel) return;
  const closing = !keep && openRound === i && !panel.hidden;
  document.querySelectorAll(".pc").forEach((b) => b.setAttribute("aria-expanded", String(!closing && +b.dataset.round === i)));
  dropSummaryMap();
  if (closing) { panel.hidden = true; panel.innerHTML = ""; openRound = -1; return; }
  openRound = i;
  await loadVault(MODE.vault);
  const it = items[i], r = results[i], tier = tierFor(r.km);
  panel.hidden = false;
  panel.style.setProperty("--c", tier.color);
  panel.innerHTML = `<div class="fd-head">
      <h4>Round ${i + 1}: ${esc(it.name)}</h4>
      <button class="minor" id="fdClose" type="button">Close</button>
    </div>
    <div class="fd-grid">
      <div class="fd-words">
        <p><span>You said</span> <b data-spot>${r.guess ? "…" : "not recorded"}</b></p>
        <p><span>Actually</span> <b>${esc(it.city)}, ${esc(it.country)}</b></p>
        <p class="fd-fact">${esc(funFact(it, r))}</p>
      </div>
      <div class="fd-map-wrap"><div class="fd-map" id="fdMap"></div></div>
    </div>
    <div class="fd-vault">
      <div class="fd-card">${cardHtml(it, r.pts)}</div>
      ${vaultHtml(it, r)}
    </div>`;
  $("#fdClose").onclick = () => toggleDetail(i);
  loadPlaces().then(() => { const el = panel.querySelector("[data-spot]"); if (el && r.guess) el.textContent = describeSpot(r.guess, countryShapes); });
  summaryMap = createSummaryMap($("#fdMap"), items.map((x, k) => {
    const tk = tierFor(results[k].km);
    return { guess: results[k].guess, answer: { lat: x.lat, lng: x.lng }, color: tk.color, ink: tk.ink, label: formatDistance(results[k].km), inside: results[k].inside };
  }), { start: i });
  if (!keep) panel.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

// "about 1,200 football pitches (105 m each). Rosario is about 20 km across: you were 30 city-widths away."
function funFact(it, r) {
  if (r.noPin) return "No pin this round: the clock ran out.";
  if (r.inside) return "Your pin was inside the city.";
  return [r.sports ? `${formatDistance(r.km)} off: ${sportsDistance(r.km, r.sports)}.` : "", cityFact(r.km, it.city, it.radius_km)].filter(Boolean).join(" ");
}

// Share the ticket: phones get the share sheet with the picture and the text; elsewhere the picture
// downloads and the text is shown, ready to copy.
async function shareTicket(ticket) {
  const text = shareText();
  let blob = null;
  try { blob = await ticketPng(ticket); } catch {}
  const file = blob && new File([blob], `home-ground-${MODE.key}-${today + 1}.png`, { type: "image/png" });
  if (file && navigator.canShare?.({ files: [file] }) && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ files: [file], text }); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  if (blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = file.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $("#shareText").hidden = false;
  toast(blob ? "Ticket saved. The text is below to copy." : "The text is below to copy.");
}

// ── Stats: kept on this device only ──────────────────────
// Games played, average, best, streaks, and how often you've finished on each rank (a histogram,
// like Wordle's guess distribution), with today's rank picked out.
function showStats() {
  sheetKind = "stats";
  const st = store.get(key("stats"), { played: 0, streak: 0, best: 0, last: null });
  const history = store.get(key("history"), {});
  const totals = Object.values(history);
  const avg = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0;
  const streak = st.last === today || st.last === today - 1 ? st.streak : 0;
  const counts = LADDER.map((r) => totals.filter((t) => rankFor(t) === r).length);
  const most = Math.max(1, ...counts);
  const todayRank = history[today] != null ? rankFor(history[today]) : null;
  const bars = LADDER.map((r, i) => `<li class="${r === todayRank ? "today" : ""}">
      <span class="st-name">${r.name}</span>
      <span class="st-bar" style="--w:${Math.max(counts[i] / most, counts[i] ? 0.08 : 0) * 100}%"><b>${counts[i]}</b></span></li>`).reverse().join("");
  openSheet(`<div class="card stats-card" role="dialog" aria-labelledby="statsTitle">
    <h2 id="statsTitle">Your stats</h2><p class="st-mode">${esc(MODE.name)}</p>
    <div class="stats st-numbers">
      <div><b>${totals.length}</b><span>Played</span></div><div><b>${avg.toLocaleString()}</b><span>Average</span></div>
      <div><b>${(st.best || 0).toLocaleString()}</b><span>Best</span></div><div><b>${streak}</b><span>Streak</span></div>
      <div><b>${st.maxStreak || streak}</b><span>Best streak</span></div>
    </div>
    <h3>Your ranks</h3>
    ${totals.length ? `<ol class="st-hist" aria-label="How often you finished on each rank">${bars}</ol>` : `<p>Finish today's five to start your record.</p>`}
    <p class="st-note">Kept on this device only.</p>
    <div class="actions"><button class="go" id="closeBtn">Back</button></div>
  </div>`);
  $("#closeBtn").onclick = phase === "done" ? () => showSummary({ instant: true }) : hideSheet;
}

// The Vault for one round: the card you won and the five levels of facts.
let vaultRound = 0;
async function showVault(i, { back = false } = {}) {
  await loadVault(MODE.vault);
  sheetKind = "vault"; vaultRound = i;
  const it = items[i], r = results[i];
  openSheet(`<div class="card vault-card" role="dialog" aria-labelledby="vaultTitle" style="--rar:var(--r-${rarityKey(r.pts)})">
    <div class="vault-head">${cardHtml(it, r.pts)}
      <div><h2 id="vaultTitle">The Vault</h2><small>${esc(it.name)} · ${levelFor(r.pts) + 1} of 5 levels unlocked with ${r.pts.toLocaleString()} points</small></div></div>
    ${vaultHtml(it, r)}
    <div class="actions"><button class="go" id="closeBtn">${back ? "Back to full time" : "Back to the map"}</button></div>
  </div>`);
  $("#closeBtn").onclick = back ? () => showSummary({ instant: true }) : hideSheet;
}


function copyResult() {
  const text = shareText();
  try {
    navigator.clipboard.writeText(text).then(() => toast("Result copied"), fallbackCopy);
  } catch { fallbackCopy(); }
}
// If the clipboard is blocked, select the result text on screen so it can be copied by hand.
function fallbackCopy() {
  const pre = $("#shareText");
  if (!pre) return;
  pre.hidden = false;
  const range = document.createRange();
  range.selectNodeContents(pre);
  getSelection().removeAllRanges(); getSelection().addRange(range);
  toast("Copy blocked. The result is selected: copy it from there.");
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 1800);
}
function openSheet(html) { cancelHero(); dropSummaryMap(); const s = $("#sheet"); s.classList.remove("full"); s.innerHTML = html; s.hidden = false; s.scrollTop = 0; s.querySelector("button")?.focus({ preventScroll: true }); }
function hideSheet() { cancelHero(); dropSummaryMap(); ftTimers.forEach(clearTimeout); ftTimers = []; $("#sheet").hidden = true; sheetKind = null; clearInterval(timer); }

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
    <p>You have ${ROUND_SECONDS} seconds a round. Tap or click the map to drop a pin, drag it to fine-tune, then press Lock in guess (when time runs out, your pin is locked in; no pin scores 0). Anywhere inside the city counts as a hole in one. Outside it, closer means more points, up to 1,000 a round. Revealing the country halves the round.</p>
    <p>Your daily total earns a rank, from wooden spoon to Hall of Fame. Finish every day to keep your streak going.</p>
    <div class="tier-scale">${TIERS.map((t, i) => `<div><i style="background:${t.color}"></i><b>${t.name}</b><span>${tierRange(i)}</span></div>`).join("")}</div>
    <details class="credits"><summary>Credits</summary><ul>
      <li>Satellite imagery: Esri, Maxar, Earthstar Geographics and the GIS User Community</li>
            <li>Country shapes: Natural Earth</li>
      <li>Players and teams: Wikidata. Vault facts: Wikidata and Wikipedia (summaries CC BY-SA 4.0)</li>
      <li>Photos and logos: Wikimedia Commons. Each picture's author and licence are behind the (i) on it.</li>
      <li>Map engine: MapLibre GL JS</li>
    </ul></details>
    <div class="actions"><button class="go" id="gotIt">Kick off</button>${players.length ? `<button class="minor" id="helpSwitch">Switch game</button>` : ""}</div>
  </div>`);
  $("#gotIt").onclick = hideSheet;
  if ($("#helpSwitch")) $("#helpSwitch").onclick = showPicker;
  store.set("hg:seenHelp", true);
}

// ── wiring (each listener is attached exactly once, here) ─────────
// The start screen can't be dismissed until a game is picked (there'd be nothing behind it).
const dismissable = () => !(sheetKind === "picker" && !players.length);
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet" && dismissable()) hideSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden && dismissable()) hideSheet(); });
$("#helpBtn").onclick = showHelp;
$("#statsBtn").onclick = showStats;
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
  renderAll(); // header, clue, rail (including the result card)
  if (sheetKind === "summary") showSummary({ instant: true });
  if (sheetKind === "help") showHelp();
  if (sheetKind === "stats") showStats();
  if (sheetKind === "vault") showVault(vaultRound);
};
function renderUnitButton() {
  const u = getUnit();
  $("#unitBtn").textContent = u;
  $("#unitBtn").setAttribute("aria-label", `Distances in ${u === "km" ? "kilometres" : "miles"}. Switch to ${u === "km" ? "miles" : "kilometres"}`);
}
$("#collapseBtn").onclick = () => {
  const fold = !$("#ticket").classList.contains("folded");
  setFolded(fold);
  store.set("hg:folded", fold);
};
// Phones: the ticket sits just above the dock, so it needs to know the dock's height.
new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${$("#dock").offsetHeight}px`)).observe($("#dock"));

$("#creditBtn").onclick = () => {
  const open = $("#credit").hidden;
  $("#credit").hidden = !open;
  $("#creditBtn").setAttribute("aria-expanded", String(open));
};

// Cache map tiles already seen (see sw.js), so a second visit and zooming back out are instant.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// ── start ───────────────────────────────────────────────
// The start screen: two big cards, Daily mix and Football. ?mode=football (or ?mode=mix) skips it.
function modeStatus(m) {
  const res = store.get(`${m.prefix}day:${today}`, []);
  const st = store.get(`${m.prefix}stats`, { streak: 0, last: null });
  const streak = st.last === today || st.last === today - 1 ? st.streak : 0;
  const pts = res.reduce((s, r) => s + r.pts, 0);
  const state = res.length >= ROUNDS ? `Played today: ${pts.toLocaleString()}` : res.length ? `Round ${res.length + 1} of ${ROUNDS} next` : "Today's five are ready";
  return `${state}${streak ? ` · ${streak}-day streak` : ""}`;
}
function showPicker() {
  sheetKind = "picker";
  openSheet(`<div class="card picker" role="dialog" aria-labelledby="pickTitle">
    <h2 id="pickTitle">Pick your game</h2>
    <div class="modes">${Object.values(MODES).map((m) => `
      <button class="mode-card" data-mode="${m.key}" type="button">
        <span class="mode-art" aria-hidden="true"></span>
        <b>${esc(m.name)}</b>
        <span class="mode-blurb">${esc(m.blurb)}</span>
        <span class="mode-state">${esc(modeStatus(m))}</span>
        <span class="mode-go">Play ${esc(m.name)}</span>
      </button>`).join("")}</div>
    <p class="st-note">Each game has its own daily five, streak and stats.</p>
  </div>`);
  document.querySelectorAll(".mode-card").forEach((b) => (b.onclick = () => startMode(b.dataset.mode)));
}

const loaded = {}; // each mode's player list, fetched once
async function startMode(key) {
  MODE = MODES[key];
  useScale(MODE.scale); // this mode's tier distances and rank thresholds (the mix's if it has none)
  live.stop(); live = createClimb($("#ladderLive"), { compact: true }); // so the staircase shows this mode's thresholds
  document.body.dataset.mode = key;
  const url = new URL(location.href);
  url.searchParams.set("mode", key);
  history.replaceState(null, "", url); // a reload, or a shared link, comes back to this mode
  hideSheet();
  if (!loaded[key]) loaded[key] = (await (await fetch(MODE.data)).json());
  const list = loaded[key];
  players = (Array.isArray(list) ? list : list.players).map(normalise);
  $("#ticket").hidden = false;
  if (PREVIEW) startPractice(); else startDaily();
  if (!store.get("hg:seenHelp", false) && phase !== "done") showHelp();
}
$("#modeBtn").onclick = showPicker;

async function boot() {
  const [countriesRes] = await Promise.all([fetch("data/countries.geojson"), loadFacts()]);
  countryShapes = (await countriesRes.json()).features;
  for (const f of countryShapes) {
    const { name, aliases, fit } = f.properties;
    for (const key of [name.toLowerCase(), ...aliases]) countryIndex.set(key, { name, fit });
  }
  const chosen = modeFromUrl();
  if (chosen) await startMode(chosen);
  else showPicker();
}
boot().catch((err) => {
  console.error(err);
  $("#who").textContent = "No players loaded";
  $("#ask").textContent = "The player list didn't load. Serve this folder with a web server (see README) and reload.";
});
