// The Vault: extra facts about each name, unlocked by how well you scored on it, plus the
// collectible cards you win (kept on this device, and upgraded when you do better).
// Every fact comes from data/vault.json, which scripts/build_vault.py fetches from Wikidata and
// Wikipedia. Nothing here is written by hand.
import { sportIcon } from "./sporticons.js";
import { formatLength, formatDistance, sportsDistance, cityFact } from "./units.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Five levels. A round's points decide how far into the file you get, and which card you collect.
export const LEVELS = [
  { key: "programme", name: "Programme", min: 0, card: "Bronze" },
  { key: "statline", name: "Stat line", min: 200, card: "Silver" },
  { key: "scout", name: "Scout report", min: 500, card: "Gold" },
  { key: "film", name: "Film room", min: 750, card: "Platinum" },
  { key: "hof", name: "Hall of Fame file", min: 950, card: "Legend" },
];
export const levelFor = (pts) => LEVELS.filter((l) => pts >= l.min).length - 1; // 0–4
export const rarityKey = (pts) => LEVELS[levelFor(pts)].card.toLowerCase();

// ── data ────────────────────────────────────────────────
// Each game mode has its own file (data/vault.json, data/football-vault.json); each is fetched once.
let vault = null;
const vaults = {};
export async function loadVault(path = "data/vault.json") {
  if (!vaults[path]) vaults[path] = fetch(path).then((r) => r.json()).catch(() => ({}));
  vault = await vaults[path];
  return vault;
}

// ── the five levels ─────────────────────────────────────
const fact = (label, value) => (value || value === 0 ? `<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>` : "");
const ageOn = (iso) => { const b = new Date(iso); if (isNaN(b)) return ""; const n = new Date(); return n.getFullYear() - b.getFullYear() - (n < new Date(n.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0); };
const longDate = (iso) => { const d = new Date(iso + "T12:00:00Z"); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }); };

// Your shot, in things a sports fan can picture: "about 74 marathons (42.2 km each)", and how many
// city-widths away the pin was. Everyone sees this (it's in the first level).
function yourShot(it, r) {
  if (!r || r.inside) return `<p class="shot">Your pin was inside the city.</p>`;
  const units = r.sports ? `${formatDistance(r.km)} off: ${sportsDistance(r.km, r.sports)}.` : "";
  return `<p class="shot"><b>Your shot</b> ${esc(units)} ${esc(cityFact(r.km, it.city, it.radius_km))}</p>`;
}

// Football: the same five levels, with the club career, caps and honours from Wikidata.
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
function footballBody(key, it, v, r) {
  switch (key) {
    case "programme":
      return `${yourShot(it, r)}<dl>${fact("Born", v.born ? `${esc(longDate(v.born))}${!v.died && /^\d{4}-\d\d-\d\d$/.test(v.born) ? ` <small>(age ${ageOn(v.born)})</small>` : ""}` : "") +
        fact("Died", v.died ? esc(longDate(v.died)) : "") +
        fact("Nationality", esc((it.nationality || []).join(", ") || v.country)) + fact("Position", esc((it.positions || []).join(", ") || v.position)) +
        fact("Now at", esc(it.club_now))}</dl>`;
    case "statline": {
      const honours = (v.honours || it.achievements || []).map((h) => `<li>${esc(h)}</li>`).join("");
      return honours ? `<ul class="honours-list">${honours}</ul><p class="source">Trophies and awards on Wikidata.</p>` : "<p>No trophies or awards on Wikidata yet.</p>";
    }
    case "film": {
      const spells = (v.career || []).map((c) => `<li><b>${c.from}${c.to ? (c.to !== c.from ? `–${c.to}` : "") : "–"}</b> ${esc(c.club)}${c.apps != null ? ` <small>${plural(c.apps, "game", "games")}${c.goals != null ? `, ${plural(c.goals, "goal", "goals")}` : ""}</small>` : ""}</li>`).join("");
      const intl = v.caps ? `<p class="intl"><b>International:</b> ${plural(v.caps, "cap", "caps")}${v.intlGoals != null ? `, ${plural(v.intlGoals, "goal", "goals")}` : ""}</p>` : "";
      return spells || intl ? `${spells ? `<ol class="timeline">${spells}</ol>` : ""}${intl}` : "<p>No dated club career on Wikidata.</p>";
    }
    default:
      return levelBody(key, { ...it, list: null }, v, r);
  }
}

function levelBody(key, it, v, r) {
  if (it.list) return footballBody(key, it, v, r);
  const team = it.type === "team";
  switch (key) {
    case "programme":
      return `${yourShot(it, r)}<dl>${team
        ? fact("Plays in", esc(it.city)) + fact("League", esc(v.league)) + fact("Founded", v.founded)
        : fact("Born", v.born ? `${esc(longDate(v.born))}${!v.died && /^\d{4}-\d\d-\d\d$/.test(v.born) ? ` <small>(age ${ageOn(v.born)})</small>` : ""}` : "") +
          fact("Died", v.died ? esc(longDate(v.died)) : "") +
          fact("Nationality", esc(v.country)) + fact("Position", esc(v.position))}</dl>`;
    case "statline":
      return `<dl>${fact("Honours", esc(it.achievement)) + (team
        ? fact("Home ground", esc(v.ground)) + fact("Capacity", v.capacity?.toLocaleString()) + fact("Head coach", esc(v.coach))
        : fact("Height", v.heightM ? esc(formatLength(v.heightM)) : "") + fact("Shirt number", esc(v.number)))}</dl>`;
    case "scout":
      return `${v.summary ? `<p class="summary">${esc(v.summary)}</p>` : `<p class="summary">No Wikipedia summary for this one.</p>`}
        <p class="links">${v.wikiUrl ? `<a href="${esc(v.wikiUrl)}" target="_blank" rel="noopener">Read the full article on Wikipedia</a>` : ""}
        ${v.hometownUrl ? `<a href="${esc(v.hometownUrl)}" target="_blank" rel="noopener">${esc(it.city)} on Wikipedia</a>` : ""}</p>
        <p class="source">Summary from Wikipedia, CC BY-SA 4.0.</p>`;
    case "film": {
      const tl = (v.timeline || []).map((x) => `<li><b>${x.from}${x.to && x.to !== x.from ? `–${x.to}` : ""}</b> ${esc(x.what)}</li>`).join("");
      return tl ? `<ol class="timeline">${tl}</ol>` : "<p>No dated career record on Wikidata.</p>";
    }
    case "hof": {
      const years = (v.timeline || []).map((x) => x.from).filter(Boolean);
      return `<dl>${fact("Nickname", esc(v.nickname)) +
        fact(team ? "Ground opened" : "Career on file", team ? v.groundOpened : years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "") +
        fact("Wikipedia", v.sitelinks ? `an article in ${v.sitelinks} languages` : "") +
        fact("Rated", ["", "Easy", "Medium", "Hard"][it.difficulty] || "")}</dl>`;
    }
  }
  return "";
}

// The whole file for one round. Levels above your score are shown, dimmed and locked.
// Newly unlocked levels get --i so CSS can stagger their entrance.
export function vaultHtml(it, r) {
  const v = (vault && vault[it.id]) || {};
  const reached = levelFor(r.pts);
  return `<div class="vault" style="--rar:var(--r-${rarityKey(r.pts)})">
    ${LEVELS.map((l, i) => {
      const open = i <= reached;
      return `<section class="level${open ? " open" : " locked"}" style="--i:${i}">
        <h3><span class="lv">${i + 1}</span>${l.name}<small>${open ? `${l.card} card` : `Score ${l.min}+ to unlock`}</small></h3>
        ${open ? levelBody(l.key, it, v, r) : ""}
      </section>`;
    }).join("")}
  </div>`;
}

// ── collectible cards ───────────────────────────────────
// A trading card: picture, name, sport, rarity. `pts` decides the rarity.
export function cardHtml(it, pts, { flip = false, i = 0 } = {}) {
  const rar = rarityKey(pts);
  // the sport's icon sits underneath, so a picture that fails to load (and removes itself) leaves the icon
  const pic = `<span class="noimg">${sportIcon(it.sport)}</span>` + (it.image
    ? `<img src="${esc(it.image.replace(/width=\d+/, "width=300"))}" alt="${esc(it.name)}" loading="lazy" width="240" height="240"${it.imageFocus ? ` style="object-position:${esc(it.imageFocus)}"` : ""} onerror="this.remove()">` : "");
  return `<div class="tcard rar-${rar}${flip ? " flip" : ""}" style="--rar:var(--r-${rar});--i:${i}" data-type="${it.type}">
    <div class="tcard-in">
      <div class="tcard-back" aria-hidden="true"><span>Home Ground</span></div>
      <div class="tcard-face">
        <div class="tcard-pic">${pic}</div>
        <div class="tcard-meta"><b>${esc(it.name)}</b><span>${esc(it.sport)}</span></div>
        <div class="tcard-rar">${LEVELS[levelFor(pts)].card}<small>${pts.toLocaleString()}</small></div>
      </div>
    </div>
  </div>`;
}

// ── the collection ──────────────────────────────────────
// localStorage "hg:cabinet" (the old name, kept so collections carry over): { id: { pts, day } }. A card only ever upgrades.
const KEY = "hg:cabinet";
export function collection() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
// Returns "new", "upgrade" or "" (already had it at this level or better).
export function collect(id, pts, day) {
  const all = collection(), had = all[id];
  if (had && had.pts >= pts) return "";
  const upgraded = had && levelFor(pts) > levelFor(had.pts);
  all[id] = { pts, day };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
  return had ? (upgraded ? "upgrade" : "") : "new";
}

