// Game flow: load players, pick today's five, handle guesses and the scorecard.
import { ROUNDS } from "./config.js";
import { createMap } from "./map.js";
import { distanceKm, pointAlong } from "./geo.js";
import { dayNumber, dailyPicks, practicePicks } from "./daily.js";
import { TIERS, LADDER, tierFor, reactionFor, rankFor } from "./tiers.js";
import { initEffects, playEffect, clearEffects } from "./effects.js";
import { sportIcon } from "./sporticons.js";
import { loadPlaces, describeSpot } from "./fulltime.js";
import { createSummaryMap } from "./summarymap.js";
import { createClimb } from "./climb.js";
import { LEVELS, levelFor, rarityKey, loadVault, vaultHtml, cardHtml, collect } from "./vault.js";
import { getUnit, toggleUnit, formatNumber, formatDistance, pickSportsUnit, loadFacts } from "./units.js";

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
const FULL_KM = 25, SCALE_KM = 4400, POWER = 0.6;
function pointsFor(km, hintUsed) {
  const p = km <= FULL_KM ? 1000 : Math.round(1000 * Math.exp(-(((km - FULL_KM) / SCALE_KM) ** POWER)));
  return hintUsed ? Math.round(p / 2) : p;
}

// Before the guess a team shows only its nickname ("Dodgers", not "Los Angeles Dodgers"): the full
// name often contains the answer. Full names appear from the result onwards.
const shownName = (it, revealed) => (revealed ? it.name : it.display_name || it.name);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── state ───────────────────────────────────────────────
const today = dayNumber();
const dailyKey = `hg:day:${today}`;
let players = [];
let countryIndex = new Map(); // lower-case country name or alias → { name, fit } of its map shape
let countryShapes = [];       // the GeoJSON features themselves (for the Full time map)
let mode = "daily", items = [], results = [], round = 0;
// ?preview: practice from the whole pool, even on launch day. It can show future dailies, so it isn't linked anywhere.
const PREVIEW = new URLSearchParams(location.search).has("preview");
let phase = "guess"; // "guess" → "reveal" → (next round) … → "done"
let guess = null, hintUsed = false;

const gameMap = createMap($("#map"), { onPick: placeGuess, insets: coveredEdges });
const live = createClimb($("#ladderLive"), { compact: true }); // the rank staircase during the game

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
  items = dailyPicks(players, today);
  results = store.get(dailyKey, []);
  round = results.length;
  if (round >= ROUNDS) { phase = "done"; renderAll(); showSummary(); return; }
  beginRound();
}
// Play today's five again. Nothing is saved, so the streak, stats and today's recorded score stay as they were.
function startReplay() {
  mode = "replay"; items = dailyPicks(players, today); results = []; round = 0;
  hideSheet(); beginRound();
}
function startPractice() {
  mode = "practice"; items = practicePicks(players, today, PREVIEW); results = []; round = 0;
  hideSheet(); beginRound();
}
function beginRound() {
  phase = "guess"; guess = null; hintUsed = false;
  clearEffects();
  gameMap.reset();
  gameMap.setLabels("borders"); // city names would give the answer away: borders and countries only until the pin is in
  setFolded(store.get("hg:folded", false)); // the player's choice; phones re-open it for each new name
  renderAll();
  // deal the ticket in for the new name
  const t = $("#ticket");
  t.classList.remove("enter"); void t.offsetWidth; t.classList.add("enter");
}
async function lockIn() {
  if (phase !== "guess" || !guess) return;
  const it = items[round];
  const answer = { lat: it.lat, lng: it.lng };
  gameMap.prefetchAround(answer); // start loading the answer's area now; the camera heads there next
  gameMap.setLabels("all");        // the pin is in: show every city and town name
  const radius = it.radius_km || DEFAULT_RADIUS_KM;
  const rawKm = distanceKm(guess, answer);       // to the city centre (shown on the card)
  const km = Math.max(0, rawKm - radius);         // to the city's edge: used for points, tier and sharing
  const inside = km === 0;
  const pts = pointsFor(km, hintUsed);
  const before = total();
  const tier = tierFor(km);
  const played = results.length + 1;
  const at = { lat: +guess.lat.toFixed(3), lng: +guess.lng.toFixed(3) }; // kept for the Full time map
  results.push({ id: it.id, guess: at, km, rawKm, inside, pts, hint: hintUsed, line: reactionFor(tier, inside), sports: pickSportsUnit(km, it.sport, results.map((x) => x.sports)) });
  if (mode === "daily") store.set(dailyKey, results);
  const card = collect(it.id, pts, today); // the card you win: "new", "upgrade" or ""
  loadVault(); // fetch the Vault's facts in the background, ready for the button
  phase = "reveal";
  setFolded(true); // fold the ticket to just the name, to make room for the result
  renderAll();
  live.set(before, played - 1); // the ball hops up once the result is in (below)

  // Numbers start at 0 and count up in step with the line drawing across the map.
  const kmBefore = totalKm() - km;
  const show = (t) => {
    $("#distNow").textContent = formatNumber(km * t);
    $("#ptsNow").textContent = Math.round(pts * t).toLocaleString();
    $("#total").textContent = Math.round(before + pts * t).toLocaleString();
    $("#distTotal").textContent = formatNumber(kmBefore + km * t);
  };
  show(0);
  // The line stops at the city's edge (or doesn't appear at all if the pin is already inside).
  const lineEnd = inside ? guess : pointAlong(guess, answer, rawKm - radius);
  await gameMap.showResult(guess, answer, { color: tier.color, onProgress: show, radiusKm: radius, lineEnd });
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
    const st = store.get("hg:stats", { played: 0, streak: 0, best: 0, last: null });
    if (st.last !== today) {
      st.streak = st.last === today - 1 ? st.streak + 1 : 1;
      st.played += 1; st.last = today;
      st.best = Math.max(st.best, total());
      st.maxStreak = Math.max(st.maxStreak || 0, st.streak);
      store.set("hg:stats", st);
      const history = store.get("hg:history", {}); // every finished daily's total, for the stats screen
      history[today] = total();
      store.set("hg:history", history);
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
    : mode === "replay" ? `Daily #${today + 1} · replay` : "Practice round";
  // Streak: days in a row with the daily set finished. It's still "alive" until a full day is missed.
  const st = store.get("hg:stats", { streak: 0, last: null });
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
  $("#ladderLive").hidden = phase === "done";
  if (phase !== "reveal") live.set(total(), results.length);
  renderUnitButton();

  const it = items[Math.min(round, ROUNDS - 1)];
  $("#roundLbl").textContent = phase === "done" ? "Full time" : `Round ${round + 1} / ${ROUNDS}`;
  $("#unitBtn").title = "Switch km / miles";
  $("#kindLbl").textContent = it.type === "team" ? "Team" : "Athlete";
  // the sport's icon next to its name (sportIcon returns trusted, hand-written SVG)
  $("#sportLbl").innerHTML = `${sportIcon(it.sport)}<span>${esc(it.sport)}</span>`;
  const revealed = phase !== "guess";
  $("#who").textContent = phase === "done" ? `${total().toLocaleString()} points` : shownName(it, revealed);
  document.title = phase === "done" ? "Full time · Home Ground" : `${shownName(it, revealed)} · Home Ground`;
  $("#ask").innerHTML = phase === "done" ? "<b>Full time</b>The scorecard's in."
    : it.type === "team" ? "<b>Where's home?</b>Pin the city they play in." : "<b>Where were they born?</b>Pin the city on the map.";
  if (phase === "done") { $("#kindLbl").textContent = mode === "practice" ? "Practice" : "Daily set"; $("#sportLbl").textContent = `${ROUNDS} rounds`; }

  renderPortrait(phase === "done" ? null : it, revealed);
  renderDock();
}

// The dock: big "lock it in" button while guessing, the result panel after.
function renderDock() {
  const dock = $("#dock");
  dock.classList.toggle("result-mode", phase === "reveal");
  if (phase === "guess") {
    const it = items[round];
    dock.innerHTML = `
      ${hintUsed ? `<div class="status"><b>Country: ${esc(it.country)}.</b> Half points now.</div>`
        : `<button class="minor" id="hintBtn" title="Shows the country on the map. Halves this round's points.">Reveal country <span>−50%</span></button>`}
      <button class="go" id="lockBtn" ${guess ? "" : "disabled"}>${guess ? "Lock it in" : "Drop a pin first"}</button>`;
    $("#lockBtn").onclick = lockIn;
    if (!hintUsed) $("#hintBtn").onclick = revealCountry;
  } else if (phase === "reveal") {
    // The scoreboard panel: huge distance, the points, the tier stamped on, then the answer.
    const it = items[round], r = results[round];
    const t = tierFor(r.km);
    dock.style.setProperty("--tier", t.color);
    dock.style.setProperty("--tier-ink", t.ink);
    dock.innerHTML = `<div class="result">
        <div class="stat big"><b id="distNow">${formatNumber(r.km)}</b><span>${r.inside ? "inside the city" : `${getUnit()} from the city`}</span></div>
        <div class="stat"><b id="ptsNow">${r.pts.toLocaleString()}</b><span>points${r.hint ? " · hint" : ""}</span></div>
        <div class="stamp">${t.name}</div>
        <div class="place">${esc(it.city)} <small>${esc(it.country)}${it.hint ? ` · ${esc(it.hint.replace(/^Home ground: /, ""))}` : ""}</small></div>
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

// Short enough to paste anywhere: the day, total and rank; one square per round; the link.
function shareText() {
  const head = mode === "daily" ? `Home Ground #${today + 1}` : mode === "replay" ? `Home Ground #${today + 1} (replay)` : "Home Ground (practice)";
  const done = results.length === ROUNDS;
  return [
    `${head} · ${total().toLocaleString()}${done ? ` · ${rankFor(total()).name}` : ""}`,
    results.map((r) => tierFor(r.km).share).join(""),
    "willbrucee.github.io/home-ground",
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
// A calm, full-screen scorecard, top to bottom: the total and the rank (the Climb), the five rounds in
// words, the map (one round at a time), then sharing and the countdown. One thing moves at a time: the
// climb, then the rank's stamp, then the list fades in and the map appears. Then everything is still.
let hero = null; // the end screen's staircase; stopped before the screen is drawn again
const cancelHero = () => { hero?.stop(); hero = null; };
let summaryMap = null;      // the Full time map; removed (markers, animations and all) before it's drawn again
function dropSummaryMap() { summaryMap?.destroy(); summaryMap = null; }
let ftTimers = [];          // the sequence's pending steps, cancelled if the screen is closed or redrawn
function showSummary({ instant = false } = {}) {
  cancelHero();
  dropSummaryMap();
  ftTimers.forEach(clearTimeout); ftTimers = [];
  sheetKind = "summary";
  const calm = instant || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = store.get("hg:stats", { played: 0, streak: 0, best: 0 });
  const rows = items.map((it, i) => {
    const r = results[i], t = tierFor(r.km);
    return `<li class="ft-row" style="--c:${t.color};--c-ink:${t.ink}" data-round="${i}" tabindex="0" aria-label="Round ${i + 1}: show it on the map">
      <span class="ft-num">${i + 1}</span>
      <div class="ft-who"><b>${esc(it.name)}</b>
        <span class="ft-said">You said: <i data-spot="${i}">${r.guess ? "…" : "not recorded"}</i></span>
        <span>Actually: ${esc(it.city)}, ${esc(it.country)}</span></div>
      <div class="ft-pts"><b>${r.pts.toLocaleString()}</b><span class="ft-tier">${t.name}</span><small>${r.inside ? "inside the city" : formatDistance(r.km)}${r.hint ? " · hint" : ""}</small></div>
    </li>`;
  }).join("");
  const title = mode === "daily" ? "Full time" : mode === "replay" ? "Replay over" : "Practice over";
  openSheet(`<div class="ft${calm ? " settled" : ""}" role="dialog" aria-labelledby="ftTitle">
    <header class="ft-top">
      <small class="ft-brand"><img src="favicon.svg" width="26" height="26" alt="">Home Ground · ${esc($("#puzzleNo").textContent)}</small>
      <h2 id="ftTitle">${title}</h2>
      <div class="ft-score"><b id="ftTotal">${calm ? total().toLocaleString() : 0}</b><span>of ${(ROUNDS * 1000).toLocaleString()}</span></div>
      ${calm ? "" : `<button class="ft-skip" id="skipAnim" type="button">Skip animation</button>`}
    </header>
    <section class="ft-hero" id="ftHero" aria-label="Today's rank"></section>
    <section class="ft-rounds" aria-label="Your five rounds">
      <ol class="ft-rows">${rows}</ol>
      <div class="ft-mapcol">
        <div class="ft-map-wrap"><div class="ft-map" id="ftMap"></div></div>
        <div class="ft-mapnav">
          <button class="minor" id="prevRound" aria-label="Previous round">‹</button>
          <span id="mapLabel">Round 1 of ${ROUNDS}</span>
          <button class="minor" id="nextRoundBtn" aria-label="Next round">›</button>
          <button class="minor" id="showAllBtn">Show all</button>
        </div>
      </div>
    </section>
    <section class="ft-share">
      <pre class="ft-sharetext" id="shareText">${esc(shareText())}</pre>
      <div class="actions"><button class="go" id="copyBtn">Copy result</button></div>
      ${mode === "daily" ? `<p class="next-in"><span id="countdown"></span>${st.streak > 0 ? ` · ${st.streak}-day streak` : ""}</p>` : ""}
      <div class="actions ft-more">${today > 0 || PREVIEW ? `<button class="minor" id="practiceBtn">Practice round</button>` : `<button class="minor" disabled title="Practice uses names from past days only">Practice opens tomorrow</button>`}
        ${mode !== "practice" ? `<button class="minor" id="replayBtn">Replay today's set</button>` : `<button class="minor" id="backBtn">Today's set</button>`}
        <button class="minor" id="statsLink">Your stats</button>
        <button class="minor" id="closeBtn">Back to the map</button></div>
      <div class="ft-cards"><h3>Today's cards</h3>
        <div class="ft-cardrow">${items.map((it, i) => `<button class="ft-cardbtn" data-round="${i}" aria-label="${esc(it.name)}: open the Vault">${cardHtml(it, results[i].pts)}</button>`).join("")}</div>
        <p>Tap a card to open its Vault.</p></div>
      ${imageCredits()}
      <p class="ft-geo">Place names: GeoNames (CC BY 4.0).</p>
    </section>
  </div>`);
  $("#sheet").classList.add("full");
  $("#copyBtn").onclick = copyResult;
  if ($("#practiceBtn")) $("#practiceBtn").onclick = startPractice;
  if ($("#replayBtn")) $("#replayBtn").onclick = startReplay;
  $("#closeBtn").onclick = hideSheet;
  $("#statsLink").onclick = showStats;
  if ($("#backBtn")) $("#backBtn").onclick = () => { hideSheet(); startDaily(); };
  document.querySelectorAll(".ft-cardbtn").forEach((b) => (b.onclick = () => showVault(+b.dataset.round, { back: true })));

  // "You said: near Lyon, France" once the town list has loaded
  loadPlaces().then(() => document.querySelectorAll("[data-spot]").forEach((el) => {
    const r = results[+el.dataset.spot];
    if (r?.guess) el.textContent = describeSpot(r.guess, countryShapes);
  }));

  // The map, made once the list is in: one round at a time, from the list, the arrows or the map itself.
  let current = 0;
  const focus = (i) => {
    current = i;
    document.querySelectorAll(".ft-row").forEach((row) => row.classList.toggle("picked", +row.dataset.round === i));
    $("#mapLabel").textContent = i < 0 ? `All ${ROUNDS} rounds` : `Round ${i + 1} of ${ROUNDS}`;
    $("#showAllBtn").setAttribute("aria-pressed", String(i < 0));
  };
  const makeMap = () => {
    if (summaryMap || !$("#ftMap")) return;
    summaryMap = createSummaryMap($("#ftMap"), items.map((it, i) => {
      const t = tierFor(results[i].km);
      return { guess: results[i].guess, answer: { lat: it.lat, lng: it.lng }, color: t.color, ink: t.ink,
        label: formatDistance(results[i].km), inside: results[i].inside };
    }), { onSelect: focus });
  };
  document.querySelectorAll(".ft-row").forEach((row) => {
    const go = () => { makeMap(); summaryMap?.select(+row.dataset.round); };
    row.onclick = go;
    row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });
  $("#prevRound").onclick = () => summaryMap?.select((Math.max(current, 0) + ROUNDS - 1) % ROUNDS);
  $("#nextRoundBtn").onclick = () => summaryMap?.select((current + 1) % ROUNDS);
  $("#showAllBtn").onclick = () => summaryMap?.showAll();

  // The sequence. Settled (reopened, or reduced motion): everything at once, nothing moves.
  hero = createClimb($("#ftHero"));
  const settle = () => {
    ftTimers.forEach(clearTimeout); ftTimers = [];
    hero?.skip();
    $("#ftTotal") && ($("#ftTotal").textContent = total().toLocaleString());
    $(".ft")?.classList.add("settled");
    $("#skipAnim")?.remove();
    makeMap();
  };
  if (calm) {
    hero.climb(0, total(), ROUNDS, { instant: true });
    makeMap();
  } else {
    // 1. the climb, with the total counting up beside it (about three seconds)
    const start = performance.now(), to = total();
    const count = (now) => {
      const el = $("#ftTotal"), t = Math.min(1, Math.max(0, (now - start) / 3000));
      if (!el || $(".ft")?.classList.contains("settled")) return;
      el.textContent = Math.round(to * t).toLocaleString();
      if (t < 1) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    hero.climb(0, to, ROUNDS, {
      // 2. the rank is stamped beside the staircase (CSS), 3. then the list fades in, 4. then the map
      onDone: () => {
        ftTimers.push(setTimeout(() => $(".ft")?.classList.add("list-in"), 700));
        ftTimers.push(setTimeout(settle, 1300));
      },
    });
    $("#skipAnim").onclick = settle;
  }

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

// ── Stats: kept on this device only ──────────────────────
// Games played, average, best, streaks, and how often you've finished on each rank (a histogram,
// like Wordle's guess distribution), with today's rank picked out.
function showStats() {
  sheetKind = "stats";
  const st = store.get("hg:stats", { played: 0, streak: 0, best: 0, last: null });
  const history = store.get("hg:history", {});
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
    <h2 id="statsTitle">Your stats</h2>
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
  await loadVault();
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
    <p>Drop a pin and lock it in. Anywhere inside the city counts as a hole in one. Outside it, closer means more points, up to 1,000 a round. Revealing the country halves the round.</p>
    <p>Your daily total earns a rank, from wooden spoon to Hall of Fame. Finish every day to keep your streak going.</p>
    <div class="tier-scale">${TIERS.map((t, i) => `<div><i style="background:${t.color}"></i><b>${t.name}</b><span>${tierRange(i)}</span></div>`).join("")}</div>
    <details class="credits"><summary>Credits</summary><ul>
      <li>Satellite imagery: Esri, Maxar, Earthstar Geographics and the GIS User Community</li>
      <li>Borders and place names: Esri World Boundaries and Places; country shapes from Natural Earth</li>
      <li>Country shapes: Natural Earth</li>
      <li>Players and teams: Wikidata. Vault facts: Wikidata and Wikipedia (summaries CC BY-SA 4.0)</li>
      <li>Photos and logos: Wikimedia Commons. Each picture's author and licence are behind the (i) on it.</li>
      <li>Map engine: MapLibre GL JS</li>
    </ul></details>
    <div class="actions"><button class="go" id="gotIt">Kick off</button></div>
  </div>`);
  $("#gotIt").onclick = hideSheet;
  store.set("hg:seenHelp", true);
}

// ── wiring (each listener is attached exactly once, here) ─────────
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") hideSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) hideSheet(); });
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
async function boot() {
  const [playersRes, countriesRes] = await Promise.all([fetch("data/players.json"), fetch("data/countries.geojson"), loadFacts()]);
  players = await playersRes.json();
  countryShapes = (await countriesRes.json()).features;
  for (const f of countryShapes) {
    const { name, aliases, fit } = f.properties;
    for (const key of [name.toLowerCase(), ...aliases]) countryIndex.set(key, { name, fit });
  }
  if (PREVIEW) startPractice(); else startDaily();
  if (!store.get("hg:seenHelp", false) && phase !== "done") showHelp();
}
boot().catch((err) => {
  console.error(err);
  $("#who").textContent = "No players loaded";
  $("#ask").textContent = "The player list didn't load. Serve this folder with a web server (see README) and reload.";
});
