// Small line icons for the "no picture" badge. Hand-drawn SVG on a 24×24 grid, using currentColor,
// so they take the badge's gold. Sports without their own icon get a plain ball.

const ball = '<circle cx="12" cy="12" r="9"/>';
const oval = '<ellipse cx="12" cy="12" rx="10" ry="6.5" transform="rotate(-35 12 12)"/>';

const ICONS = {
  "Football": `${ball}<path d="M12 7.5l4 2.9-1.5 4.7h-5L8 10.4z"/><path d="M12 3v4.5M16 10.4l4.3-1.4M14.5 15.1l2.6 3.7M9.5 15.1l-2.6 3.7M8 10.4 3.7 9"/>`,
  "Basketball": `${ball}<path d="M3 12h18M12 3v18M5.6 5.6c3 2.7 3 10.1 0 12.8M18.4 5.6c-3 2.7-3 10.1 0 12.8"/>`,
  "Tennis": `${ball}<path d="M5.5 5.8c3.5 3 3.5 9.4 0 12.4M18.5 5.8c-3.5 3-3.5 9.4 0 12.4"/>`,
  "Baseball": `${ball}<path d="M7.5 4.8c1.6 2 2.4 4.4 2.4 7.2s-.8 5.2-2.4 7.2M16.5 4.8c-1.6 2-2.4 4.4-2.4 7.2s.8 5.2 2.4 7.2"/>`,
  "American football": `${oval}<path d="M9.2 14.8l5.6-5.6M10.5 11.4l1.4 1.4M12.1 9.8l1.4 1.4M8.9 13l1.4 1.4"/>`,
  "Rugby union": `${oval}<path d="M6.5 17.5c3-4 6.5-7.8 11-11"/>`,
  "Rugby league": `${oval}<path d="M6.5 17.5c3-4 6.5-7.8 11-11"/>`,
  "Australian rules football": `${oval}<path d="M6.5 17.5c3-4 6.5-7.8 11-11M8.5 9.5l6 6"/>`,
  "Cricket": `<path d="M15.5 3.5l3 3-9.5 9.5-3-3z"/><path d="M6 13l-2.5 2.5 3 3L9 16"/><circle cx="18" cy="17" r="2.5"/>`,
  "Golf": `<path d="M8 21V3l9 3.5L8 10"/><path d="M4 21h12"/>`,
  "Formula 1": `<path d="M5 21V3"/><path d="M5 4h14v9H5"/><path d="M9.7 4v9M14.3 4v9M5 8.5h14"/>`,
  "Ice hockey": `<path d="M6 3l6 13h7"/><ellipse cx="8" cy="18.5" rx="4" ry="1.8"/>`,
  "Cycling": `<circle cx="6" cy="16" r="4"/><circle cx="18" cy="16" r="4"/><path d="M6 16l4-7h6l2 7M10 9l2 7h-6M9 6h3"/>`,
  "Athletics": `<rect x="3" y="6" width="18" height="12" rx="6"/><rect x="7" y="9.5" width="10" height="5" rx="2.5"/>`,
  "Boxing": `<path d="M7 11V8a5 5 0 0 1 10 0v5a4 4 0 0 1-4 4H9a2 2 0 0 1-2-2"/><path d="M7 11h3a2 2 0 0 1 0 4H7z"/><path d="M8 17v4h7v-4"/>`,
  "MMA": `<path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z"/>`,
};

// A few sports read better on the small map pin as a different object.
const PIN_ICONS = {
  "Formula 1": `<path d="M3.5 16a8.5 8.5 0 0 1 17 0v2.5h-17z"/><path d="M10 11.5h10.2M10 11.5v3.5h10.4"/>`, // helmet and visor
  "Ice hockey": `<ellipse cx="12" cy="10" rx="8" ry="3.5"/><path d="M4 10v4c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-4"/>`, // puck
};

// Returns the inline <svg> markup for a sport (stroke-only, inherits colour from CSS).
// { pin: true } picks the map-pin version where there is one.
export function sportIcon(sport, { pin = false } = {}) {
  const body = (pin && PIN_ICONS[sport]) || ICONS[sport] || ball;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
