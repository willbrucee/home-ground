// Reads colours from the palette in css/style.css, so the map, the effects and the page all share
// one set of colours. Use these instead of writing hex values in JS.

const styles = () => getComputedStyle(document.documentElement);

// color("--gold") → "#ffc928"
export function color(name) {
  return styles().getPropertyValue(name).trim();
}

// withAlpha("--ink", 0.9) → "rgba(14, 23, 20, 0.9)": a palette colour, partly see-through.
export function withAlpha(name, alpha) {
  const hex = color(name).replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.replace(/./g, "$&$&") : hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
