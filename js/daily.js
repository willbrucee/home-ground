// Picks the same set of players for everyone on a given date.
import { EPOCH, ROUNDS, ROUND_DIFFICULTY } from "./config.js";

// FNV-1a hash: turns a string into a 32-bit number. Same input gives the same output on every device.
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Days since the puzzle's day 1, using the player's local calendar date.
export function dayNumber(date = new Date()) {
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const start = Date.UTC(EPOCH.year, EPOCH.month - 1, EPOCH.day);
  return Math.floor((today - start) / 864e5);
}

// Each difficulty pool is put in a "random" order by sorting on hash(id + cycle).
// Day 0 takes the first slots, day 1 the next ones, and so on, so nobody repeats until
// the whole pool has been used. Then the cycle number changes and a fresh order starts.
// Because the order comes from each player's id, adding new players only slots them in;
// it doesn't reshuffle everybody else.
// `salt` keeps each game mode's order separate ("" for the daily mix, so its order never changes).
function orderFor(pool, cycle, salt = "") {
  return [...pool].sort((a, b) => hash(`${salt}${a.id}|${cycle}`) - hash(`${salt}${b.id}|${cycle}`) || (a.id < b.id ? -1 : 1));
}

function slot(pool, index, salt) {
  const cycle = Math.floor(index / pool.length);
  return orderFor(pool, cycle, salt)[index % pool.length];
}

// One day's picks. `rounds` lists what each round draws: its difficulty and, optionally, which list
// ("legend" or "current" in Football). Entries are grouped into pools by difficulty (and list), and each
// pool hands out its next slots every day, so nobody repeats until their pool has been used up.
export function dailyPicks(players, day, { rounds = ROUND_DIFFICULTY.slice(0, ROUNDS).map((d) => ({ d })), salt = "" } = {}) {
  const pools = {};
  const keyOf = (d, list) => (list ? `${d}|${list}` : `${d}`);
  for (const p of players) {
    for (const r of rounds) {
      const k = keyOf(p.difficulty || 2, r.list && p.list);
      (pools[k] ||= new Set()).add(p);
    }
  }
  for (const k in pools) pools[k] = [...pools[k]];
  // If a pool is empty, borrow from the nearest difficulty (same list) that has players.
  const nearest = (r) => {
    for (const d of [r.d, r.d - 1, r.d + 1, r.d - 2, r.d + 2]) if (pools[keyOf(d, r.list)]?.length) return keyOf(d, r.list);
    return Object.keys(pools)[0];
  };
  const wanted = rounds.map(nearest);

  const perDay = {}; // how many rounds per day draw from each pool
  wanted.forEach((k) => (perDay[k] = (perDay[k] || 0) + 1));

  const used = {};
  const picks = [];
  for (const k of wanted) {
    const n = used[k] = (used[k] ?? -1) + 1;
    let index = day * perDay[k] + n;
    let pick = slot(pools[k], index, salt);
    // Rare: where one cycle ends and the next begins, the same player could land twice in one day. Skip ahead.
    for (let tries = 0; picks.includes(pick) && tries < 20; tries++) pick = slot(pools[k], ++index, salt);
    picks.push(pick);
  }
  return picks;
}

// Practice plays names from PAST dailies only (an archive), so practising never shows tomorrow's answers.
// Five at random from everyone who has already come up. (On launch day there's no past yet, so the
// Full time screen doesn't offer practice.)
// everything: the whole pool, future days included (the owner's ?preview link only)
// how: the mode's daily settings, or a function of the day that returns them
export function practicePicks(players, today, everything = false, how = {}) {
  const seen = new Map();
  for (let day = 0; day < today; day++) for (const p of dailyPicks(players, day, typeof how === "function" ? how(day) : how)) seen.set(p.id, p);
  const pool = everything ? [...players] : [...seen.values()];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, ROUNDS);
}
