/* Small shared helpers. */
export const $ = (id) => document.getElementById(id);
export const D2R = Math.PI / 180;
export const sstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
