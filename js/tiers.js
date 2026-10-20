// Result tiers, by how far the guess was from the edge of the real city.
// Tune the distances here; everything else (colours on the map, scorecard, share text) follows.
// `key` stays the same even if you rename a tier, so saved games keep working.
//
// share: the emoji used in the copy-and-paste result. There's no light-blue square emoji,
// so Air ball uses purple and Own goal uses white; the tier names are written out in the share text too.
export const TIERS = [
  { key: "bullseye", name: "Hole in one", maxKm: 25, color: "#ffc928", share: "🎯", effect: "confetti" },
  { key: "scorching", name: "Top corner", maxKm: 150, color: "#ff4d1f", share: "🟥", effect: "embers", strength: 1 },
  { key: "hot", name: "Slam dunk", maxKm: 500, color: "#ff8a1f", share: "🟧", effect: "embers", strength: 0.55 },
  { key: "warm", name: "On the board", maxKm: 1200, color: "#f5d547", share: "🟨", effect: "glow" },
  { key: "cool", name: "Off the pace", maxKm: 2500, color: "#7cc8f2", share: "🟦", effect: "frost", strength: 0.35 },
  { key: "cold", name: "Air ball", maxKm: 5000, color: "#2f7fe0", share: "🟪", effect: "frost", strength: 0.7 },
  { key: "frozen", name: "Own goal", maxKm: Infinity, color: "#dff3ff", share: "⬜", effect: "frost", strength: 1 },
];

export function tierFor(km) {
  return TIERS.find((t) => km < t.maxKm);
}

// Short lines for the result card, a few per tier so it doesn't get repetitive.
export const REACTIONS = {
  bullseye: ["Straight in the cup.", "Pinpoint. Take a bow.", "Couldn't have placed it better with a tape measure."],
  scorching: ["Picked out the top corner.", "Inches from perfect.", "Keeper had no chance. Nearly."],
  hot: ["Right region, wrong city.", "Close enough to hear the crowd.", "Good read. Not quite there."],
  warm: ["Points on the board.", "In the area. Needs a sharper finish.", "Right part of the world."],
  cool: ["Drifting wide.", "Off the pace, but still in the race.", "Right continent, maybe."],
  cold: ["Nothing but air.", "That one's sailed into the stands.", "Wrong side of the map."],
  frozen: ["Into your own net.", "Other side of the world.", "Somebody check the compass."],
};

// `inside`: the pin landed within the city area, so the line can say so.
export function reactionFor(tier, inside = false) {
  if (inside) return "Hole in one.";
  const lines = REACTIONS[tier.key];
  return lines[Math.floor(Math.random() * lines.length)];
}

// ── The daily ladder ─────────────────────────────────────────────────────────
// Your total out of 5,000 earns a rank. `min` is the lowest total for that rank.
// For a feel of the numbers: five "On the board" rounds (~500 km out each) make about 3,300.
// `big` ranks get their own reveal on the scorecard.
export const LADDER = [
  { key: "spoon", name: "Wooden spoon", min: 0 },
  { key: "reserve", name: "Reserve", min: 1000 },
  { key: "starter", name: "Starter", min: 2000 },
  { key: "allstar", name: "All-star", min: 3000 },
  { key: "captain", name: "Captain", min: 3800, big: true },
  { key: "hof", name: "Hall of Fame", min: 4400, big: true },
];

export function rankFor(total) {
  return [...LADDER].reverse().find((r) => total >= r.min);
}
