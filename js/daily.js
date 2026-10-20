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
function orderFor(pool, cycle) {
  return [...pool].sort((a, b) => hash(`${a.id}|${cycle}`) - hash(`${b.id}|${cycle}`) || (a.id < b.id ? -1 : 1));
}

function slot(pool, index) {
  const cycle = Math.floor(index / pool.length);
  return orderFor(pool, cycle)[index % pool.length];
}

export function dailyPicks(players, day) {
  const pools = { 1: [], 2: [], 3: [] };
  for (const p of players) (pools[p.difficulty] || pools[2]).push(p);

  // If a difficulty has no players yet, borrow from the nearest one that does.
  const nearest = (d) => [d, d - 1, d + 1, d - 2, d + 2].find((x) => pools[x]?.length);
  const wanted = ROUND_DIFFICULTY.slice(0, ROUNDS).map(nearest);

  const perDay = {}; // how many rounds per day draw from each pool
  wanted.forEach((d) => (perDay[d] = (perDay[d] || 0) + 1));

  const used = {};
  const picks = [];
  for (const d of wanted) {
    const k = used[d] = (used[d] ?? -1) + 1;
    let index = day * perDay[d] + k;
    let pick = slot(pools[d], index);
    // Rare: where one cycle ends and the next begins, the same player could land twice in one day. Skip ahead.
    for (let tries = 0; picks.includes(pick) && tries < 20; tries++) pick = slot(pools[d], ++index);
    picks.push(pick);
  }
  return picks;
}

export function practicePicks(players) {
  const copy = [...players];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, ROUNDS);
}
