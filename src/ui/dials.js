/* The Sky panel's dials (time, moon position, moon phase) and the day/night cycle controls. */
import { state } from '../core/state.js';
import { $, D2R } from '../core/util.js';
import { elongation, moonHours, fmtClock, phaseName } from '../sky/sky.js';

export const SVGNS = "http://www.w3.org/2000/svg";
export function dialAngle(svg, ev){
  const r = svg.getBoundingClientRect();
  const x = ev.clientX - (r.left + r.width / 2), y = ev.clientY - (r.top + r.height / 2);
  return ((Math.atan2(x, -y) / D2R) + 360) % 360;      // clockwise from the top
}
export function makeDial(id, onAngle, step){
  const svg = $(id);
  let drag = false;
  svg.addEventListener("pointerdown", (e) => { if (svg.getAttribute("aria-disabled") === "true") return; drag = true; svg.setPointerCapture(e.pointerId); onAngle(dialAngle(svg, e)); e.stopPropagation(); });
  svg.addEventListener("pointermove", (e) => { if (drag) onAngle(dialAngle(svg, e)); });
  svg.addEventListener("pointerup", () => { drag = false; });
  svg.addEventListener("keydown", (e) => {
    if (svg.getAttribute("aria-disabled") === "true") return;
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (d){ e.preventDefault(); e.stopPropagation(); onAngle(null, d * step); }
  });
}
export function dialSVG(svg, angle, labels, centre){
  let h = `<circle cx="42" cy="42" r="36" fill="rgba(255,255,255,0.04)" stroke="rgba(214,222,210,0.25)"/>`;
  for (let i = 0; i < 24; i++){
    const a = i * 15 * D2R, r0 = i % 6 === 0 ? 30 : 33;
    h += `<line x1="${42 + Math.sin(a) * r0}" y1="${42 - Math.cos(a) * r0}" x2="${42 + Math.sin(a) * 36}" y2="${42 - Math.cos(a) * 36}" stroke="rgba(214,222,210,0.35)"/>`;
  }
  labels.forEach(([a, t]) => { const ar = a * D2R; h += `<text x="${42 + Math.sin(ar) * 23}" y="${42 - Math.cos(ar) * 23 + 3}" font-size="7.5" text-anchor="middle" fill="#919a90" font-family="Martian Mono, monospace">${t}</text>`; });
  h += centre || "";
  const ar = angle * D2R;
  h += `<line x1="42" y1="42" x2="${42 + Math.sin(ar) * 31}" y2="${42 - Math.cos(ar) * 31}" stroke="#f0b25c" stroke-width="1.5"/>`;
  h += `<circle cx="${42 + Math.sin(ar) * 33}" cy="${42 - Math.cos(ar) * 33}" r="4.5" fill="#f0b25c" stroke="#0b0e10" stroke-width="1.5"/>`;
  svg.innerHTML = h;
}
export function phaseIcon(e){
  const k = (1 - Math.cos(e * D2R)) / 2, waxing = e < 180, r = 9, cx = 42, cy = 42, rx = r * Math.abs(1 - 2 * k);
  const d = waxing
    ? `M${cx},${cy - r} A${r},${r} 0 0 1 ${cx},${cy + r} A${rx},${r} 0 0 ${k < 0.5 ? 0 : 1} ${cx},${cy - r} Z`
    : `M${cx},${cy - r} A${r},${r} 0 0 0 ${cx},${cy + r} A${rx},${r} 0 0 ${k < 0.5 ? 1 : 0} ${cx},${cy - r} Z`;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#2a2f33"/><path d="${d}" fill="#e8e4d6"/>`;
}
export const hoursToAngle = (h) => ((h - 12) * 15 + 360) % 360;      // 12:00 at the top, midnight at the bottom
export const angleToHours = (a) => (12 + a / 15) % 24;
export const CLOCK = [[0, "12"], [90, "18"], [180, "0"], [270, "6"]];
/* Day/night cycle. The sun turns once per "day length". Realistic moon: the moon falls ~50 min behind the sun
   each day (one lap per 29.53 days), so its phase follows from where it is; its height follows the ecliptic (a
   full moon sits opposite the sun: high in winter, low in summer; the orbit's 5 degree tilt is left out).
   Otherwise the moon keeps pace with the sun and its phase moves on by a set step per night, changed only
   while the moon is below the horizon (if it never sets, slowly while up). */
export function syncCycleUI(){
  $("cycle").checked = state.cycle; $("realMoon").checked = state.realMoon;
  $("cycleSub").setAttribute("aria-disabled", String(!state.cycle));
  $("dayMin").disabled = !state.cycle; $("realMoon").disabled = !state.cycle;
  $("phaseStep").disabled = !state.cycle || state.realMoon;
  $("phaseStepRow").style.opacity = state.realMoon ? 0.45 : "";
  if (state.cycle && state.realMoon){ state.moonCouple = true; $("moonCouple").checked = true; }
  $("moonCouple").disabled = state.cycle && state.realMoon;
  $("moonDec").disabled = state.cycle && state.realMoon;
}
export function drawDials(){
  dialSVG($("dialTime"), hoursToAngle(state.timeH), CLOCK);
  dialSVG($("dialMoon"), hoursToAngle(moonHours()), CLOCK);
  dialSVG($("dialPhase"), state.phaseDeg, [[0, "full"], [180, "new"]], phaseIcon(elongation()));
  $("dialMoon").setAttribute("aria-disabled", String(state.moonCouple));
  $("timeOut").textContent = fmtClock(state.timeH);
  $("moonOut").textContent = fmtClock(moonHours());
  $("phaseOut").textContent = phaseName(elongation());
  $("dialTime").setAttribute("aria-valuetext", fmtClock(state.timeH));
  $("dialPhase").setAttribute("aria-valuetext", phaseName(elongation()));
}

// Wires up the dials and cycle controls; onChange refreshes the panel's readouts.
export function initDials(onChange){
  const updateReadouts = onChange;
  $("cycle").addEventListener("change", (e) => { state.cycle = e.target.checked; if (!state.cycle) state.realMoon = false; syncCycleUI(); updateReadouts(); });
  $("realMoon").addEventListener("change", (e) => { state.realMoon = e.target.checked; state.phaseDebt = 0; syncCycleUI(); updateReadouts(); });
  makeDial("dialTime", (a, d) => { state.timeH = a === null ? ((state.timeH + d * 0.25) % 24 + 24) % 24 : angleToHours(a); drawDials(); }, 1);
  makeDial("dialMoon", (a, d) => { state.moonH = a === null ? ((state.moonH + d * 0.25) % 24 + 24) % 24 : angleToHours(a); drawDials(); }, 1);
  makeDial("dialPhase", (a, d) => { state.phaseDeg = a === null ? ((state.phaseDeg + d * 5) % 360 + 360) % 360 : a; drawDials(); }, 1);
  $("moonCouple").addEventListener("change", (e) => { if (!e.target.checked) state.moonH = moonHours(); state.moonCouple = e.target.checked; drawDials(); });
  drawDials();
}
