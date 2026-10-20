// Result tiers, by how far the guess was from the real place.
// Tune the distances here; everything else (colours on the map, scorecard, share text) follows.
//
// share: the emoji used in the copy-and-paste result. There's no light-blue square emoji,
// so Cold uses purple and Frozen uses white; the tier names are written out in the share text too.
export const TIERS = [
  { key: "bullseye", name: "Bullseye", maxKm: 25, color: "#ffc928", share: "🎯", effect: "confetti" },
  { key: "scorching", name: "Scorching", maxKm: 150, color: "#ff4d1f", share: "🟥", effect: "embers", strength: 1 },
  { key: "hot", name: "Hot", maxKm: 500, color: "#ff8a1f", share: "🟧", effect: "embers", strength: 0.55 },
  { key: "warm", name: "Warm", maxKm: 1200, color: "#f5d547", share: "🟨", effect: "glow" },
  { key: "cool", name: "Cool", maxKm: 2500, color: "#7cc8f2", share: "🟦", effect: "frost", strength: 0.35 },
  { key: "cold", name: "Cold", maxKm: 5000, color: "#2f7fe0", share: "🟪", effect: "frost", strength: 0.7 },
  { key: "frozen", name: "Frozen", maxKm: Infinity, color: "#dff3ff", share: "⬜", effect: "frost", strength: 1 },
];

export function tierFor(km) {
  return TIERS.find((t) => km < t.maxKm);
}

// Short lines for the result card, a few per tier so it doesn't get repetitive.
export const REACTIONS = {
  bullseye: ["Right on the spot.", "Top corner. Unstoppable.", "Pinpoint. Take a bow.", "Couldn't have placed it better with a tape measure."],
  scorching: ["Within shouting distance.", "Inches from the line.", "Just off the target. So close.", "Right neighbourhood, wrong street."],
  hot: ["Right region, wrong city.", "Close enough to hear the crowd.", "Good read. Not quite there.", "In the right postcode, almost."],
  warm: ["Right part of the world.", "In the area. Needs a sharper finish.", "Decent effort. Keep working the angles.", "On the right side of the pitch."],
  cool: ["Drifting wide.", "A long way from the box.", "Right continent, maybe.", "Wide of the post."],
  cold: ["Wrong side of the map.", "That one's sailed into the stands.", "Way off the pace.", "Not this time."],
  frozen: ["Other side of the world.", "Lost in the post.", "Wrong hemisphere, wrong everything.", "Somebody check the compass."],
};

export function reactionFor(tier) {
  const lines = REACTIONS[tier.key];
  return lines[Math.floor(Math.random() * lines.length)];
}
