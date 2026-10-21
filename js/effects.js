// Short celebration effects drawn on one transparent canvas laid over the map.
// Plain canvas, no libraries. The loop only runs while particles are alive, so it costs nothing when idle.
// Every effect is done within about 1.8 seconds.

import { color } from "./palette.js";

let canvas, ctx, particles = [], running = false, dpr = 1;

export function initEffects(el) {
  canvas = el;
  ctx = canvas.getContext("2d");
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();
}

const rand = (a, b) => a + Math.random() * (b - a);

// tier: an entry from TIERS. at: { x, y } pixel position of the answer pin.
export function playEffect(tier, at) {
  if (!canvas || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const s = tier.strength ?? 1;

  if (tier.effect === "confetti") {
    // A burst of paper confetti and sparkles from the pin, plus a quick flash of the whole stage.
    const colors = [tier.color, color("--surface"), color("--primary"), color("--t-hot"), color("--t-cool")];
    for (let i = 0; i < 90; i++) {
      const angle = rand(-Math.PI, 0); // upwards half-circle
      const speed = rand(4, 11);
      particles.push({ kind: "paper", x: at.x, y: at.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 2,
        g: 0.28, drag: 0.985, life: rand(1.1, 1.7), size: rand(4, 8), spin: rand(-0.3, 0.3), rot: rand(0, 6), color: colors[i % colors.length] });
    }
    for (let i = 0; i < 24; i++) {
      particles.push({ kind: "spark", x: at.x + rand(-40, 40), y: at.y + rand(-50, 20), vx: 0, vy: -0.3, g: 0, drag: 1,
        life: rand(0.5, 1.2), delay: rand(0, 0.5), size: rand(2, 4), color: color("--surface") });
    }
    flash(tier.color, "pulse");
  } else if (tier.effect === "embers") {
    // Glowing embers drifting up from the pin, with a short heat haze.
    for (let i = 0; i < Math.round(55 * s); i++) {
      particles.push({ kind: "ember", x: at.x + rand(-26, 26), y: at.y + rand(-6, 10), vx: rand(-0.6, 0.6), vy: rand(-2.6, -1),
        g: -0.015, drag: 0.99, wobble: rand(0, 6), life: rand(0.8, 1.6), delay: rand(0, 0.35), size: rand(1.5, 3.4),
        color: Math.random() < 0.5 ? tier.color : color("--t-warm") });
    }
    particles.push({ kind: "glow", x: at.x, y: at.y, life: 1.1, size: 70 + 40 * s, color: tier.color });
    flash(tier.color, "heat");
  } else if (tier.effect === "glow") {
    // Warm: one soft glow that swells and fades.
    particles.push({ kind: "glow", x: at.x, y: at.y, life: 1.3, size: 90, color: tier.color });
  } else if (tier.effect === "frost") {
    // Snowflakes drift down over the map; the colder the result, the more of them, plus frosted edges.
    for (let i = 0; i < Math.round(60 * s); i++) {
      particles.push({ kind: "snow", x: rand(0, w), y: rand(-h * 0.3, h * 0.6), vx: rand(-0.4, 0.4), vy: rand(0.8, 2),
        g: 0, drag: 1, wobble: rand(0, 6), life: rand(1.1, 1.8), delay: rand(0, 0.3), size: rand(1.5, 3.5) + s, color: color("--t-frozen") });
    }
    if (s >= 0.7) flash(color("--t-frozen"), "frost");
  }
  if (!running) { running = true; last = performance.now(); requestAnimationFrame(loop); }
}

// A CSS overlay over the map (a coloured flash, frosted edges...). We never scale or move the map
// container itself: CSS transforms on it would throw off where clicks land.
function flash(color, kind) {
  const el = document.querySelector("#flash");
  if (!el) return;
  el.style.setProperty("--flash", color);
  el.className = "";
  void el.offsetWidth; // restart the CSS animation
  el.className = `flash-${kind}`;
}

let last = 0;
function loop(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); // seconds since the last frame (capped, in case the tab was hidden)
  last = now;
  const k = dt * 60; // movement values above are "per frame at 60fps"; this keeps speed steady at other frame rates
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  particles = particles.filter((p) => {
    if (p.delay > 0) { p.delay -= dt; return true; }
    p.age = (p.age || 0) + dt;
    if (p.age >= p.life) return false;
    const fade = 1 - p.age / p.life;

    if (p.kind !== "glow") {
      p.vx *= Math.pow(p.drag, k);
      p.vy = p.vy * Math.pow(p.drag, k) + p.g * k;
      p.x += (p.vx + (p.wobble !== undefined ? Math.sin(p.age * 5 + p.wobble) * 0.5 : 0)) * k;
      p.y += p.vy * k;
    }

    ctx.globalAlpha = Math.max(0, fade);
    ctx.fillStyle = p.color;
    if (p.kind === "paper") {
      p.rot += p.spin * k;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * Math.abs(Math.cos(p.rot * 2)) + 1); // flips like paper
      ctx.restore();
    } else if (p.kind === "glow") {
      const r = p.size * (0.4 + 0.6 * Math.sin(Math.min(1, p.age / p.life) * Math.PI)); // swell then shrink
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, p.color + "aa");
      g.addColorStop(1, p.color + "00");
      ctx.fillStyle = g;
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === "spark") {
      const r = p.size * Math.sin(fade * Math.PI); // twinkle
      ctx.beginPath(); // four-point star
      ctx.moveTo(p.x, p.y - r * 2.5); ctx.lineTo(p.x + r * 0.5, p.y); ctx.lineTo(p.x, p.y + r * 2.5); ctx.lineTo(p.x - r * 0.5, p.y); ctx.closePath();
      ctx.moveTo(p.x - r * 2.5, p.y); ctx.lineTo(p.x, p.y + r * 0.5); ctx.lineTo(p.x + r * 2.5, p.y); ctx.lineTo(p.x, p.y - r * 0.5); ctx.closePath();
      ctx.fill();
    } else {
      // embers and snow: soft dots
      ctx.shadowColor = p.color;
      ctx.shadowBlur = p.kind === "ember" ? 8 : 4;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    return true;
  });

  ctx.globalAlpha = 1;
  if (particles.length) requestAnimationFrame(loop);
  else { running = false; ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight); }
}

export function clearEffects() {
  particles = [];
}
