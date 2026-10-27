/* Compass: heading strip along the bottom, with the body direction marked. */
import { state } from '../core/state.js';
import { $ } from '../core/util.js';

export const compassEl = $("compass"), cctx = compassEl.getContext("2d");
let compassKey = "";
export function drawCompass(){
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(compassEl.clientWidth * dpr), ch = Math.round(compassEl.clientHeight * dpr);
  const head = state.yaw * 180 / Math.PI, body = state.bodyYaw * 180 / Math.PI;
  const key = cw + "," + ch + "," + head.toFixed(1) + "," + body.toFixed(1) + "," + state.camMode;
  if (key === compassKey || !cw) return;
  compassKey = key;
  if (compassEl.width !== cw || compassEl.height !== ch){ compassEl.width = cw; compassEl.height = ch; }
  const c = cctx, span = 120;                       // degrees shown either side of the head direction
  const X = (deg) => cw / 2 + (deg / span) * (cw / 2);
  const rel = (deg) => ((deg - head) % 360 + 540) % 360 - 180;
  c.clearRect(0, 0, cw, ch);
  c.font = (10 * dpr) + "px 'Martian Mono', ui-monospace, monospace";
  c.textAlign = "center"; c.textBaseline = "top";
  const ink = "rgba(240,240,232,1)", shade = "rgba(0,0,0,0.55)";
  const line = (x, y0, y1, w) => {
    c.lineWidth = w + 2 * dpr; c.strokeStyle = shade; c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
    c.lineWidth = w; c.strokeStyle = ink; c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
  };
  const y = 6 * dpr;
  for (let d = Math.ceil((head - span) / 15) * 15; d <= head + span; d += 15){
    const x = X(rel(d)), m = ((d % 360) + 360) % 360;
    const major = m % 45 === 0;
    line(x, y, y + (major ? 9 : 5) * dpr, dpr);
    if (major){
      const t = ["N","NE","E","SE","S","SW","W","NW"][m / 45];
      c.fillStyle = shade; c.fillText(t, x + dpr, y + 12 * dpr + dpr); c.fillStyle = ink; c.fillText(t, x, y + 12 * dpr);
    }
  }
  // where the head points: notch at the centre
  c.fillStyle = shade; c.beginPath(); c.moveTo(cw/2 - 6*dpr, 0); c.lineTo(cw/2 + 6*dpr, 0); c.lineTo(cw/2, 7*dpr); c.fill();
  c.fillStyle = ink; c.beginPath(); c.moveTo(cw/2 - 4.5*dpr, 0); c.lineTo(cw/2 + 4.5*dpr, 0); c.lineTo(cw/2, 5.5*dpr); c.fill();
  // where the body faces: amber arrow under the strip (clamped to the edge, pointing outward, if off-scale)
  if (state.camMode !== 0){
    const r = rel(body), off = Math.abs(r) > span;
    const bx = off ? (r > 0 ? cw - 7*dpr : 7*dpr) : X(r), by = ch - 2*dpr;
    c.fillStyle = "rgba(240,178,92,1)"; c.strokeStyle = shade; c.lineWidth = 2*dpr; c.beginPath();
    if (off){ const s = r > 0 ? 1 : -1; c.moveTo(bx + s*6*dpr, by - 6*dpr); c.lineTo(bx - s*5*dpr, by - 12*dpr); c.lineTo(bx - s*5*dpr, by); }
    else { c.moveTo(bx, by - 12*dpr); c.lineTo(bx + 6*dpr, by); c.lineTo(bx - 6*dpr, by); }
    c.closePath(); c.stroke(); c.fill();
  }
}

