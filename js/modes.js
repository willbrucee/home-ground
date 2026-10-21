// The two ways to play. Everything mode-specific lives here; the game itself is shared.
//   data:    the player list to load (vault: its Vault facts)
//   prefix:  where this mode keeps its results on the device (the daily mix keeps its original keys)
//   salt:    keeps each mode's daily order separate
//   rounds:  what each of the five rounds draws (difficulty, and in Football which list)
//   share:   the first words of the share text
// Every Football day has at least two legends and two current players.
import { ROUND_DIFFICULTY } from "./config.js";

export const MODES = {
  mix: {
    key: "mix", name: "Daily mix", share: "Home Ground", data: "data/players.json", vault: "data/vault.json", prefix: "hg:", salt: "",
    blurb: "Five names from every sport: athletes where they were born, teams where they play.",
    rounds: () => ROUND_DIFFICULTY.map((d) => ({ d })),
  },
  football: {
    key: "football", name: "Football", share: "Home Ground Football", data: "data/football-players.json", vault: "data/football-vault.json", prefix: "hg:fb:", salt: "fb|",
    blurb: "Five footballers, legends and current stars. Pin where each was born.",
    // easy to hard (1, 1, 2, 2, 3): two legends, two current players, and a harder legend to finish
    // (current players are all well known, so there are no 3s among them)
    rounds: () => [
      { d: 1, list: "legend" }, { d: 1, list: "current" }, { d: 2, list: "legend" }, { d: 2, list: "current" },
      { d: 3, list: "legend" },
    ],
  },
};

// ?mode=football in the address picks Football; anything else (or nothing) is the daily mix.
export function modeFromUrl() {
  const m = new URLSearchParams(location.search).get("mode");
  return MODES[m] ? m : null;
}

// Football entries are stored with football names for their fields; the game reads the common ones.
export function normalise(entry) {
  if (!entry.birth_place) return entry;
  return { ...entry, city: entry.birth_place, country: entry.birth_country };
}
