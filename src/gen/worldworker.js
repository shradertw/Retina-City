/* Builds a new world and its history in the background (Generate), reporting progress, so the page stays
   responsive even for big worlds. The grids come back as transferred buffers; functions are added again on
   the other side (worldFromData). */
import { buildWorld } from './world.js';
import { runSim } from './sim.js';

self.onmessage = (e) => {
  const { opts, id } = e.data;
  const progress = (what, f) => self.postMessage({ id, progress: { what, f } });
  progress('Natural maps', 0);
  const w = buildWorld(opts);
  progress('History', 0);
  let last = 0;
  const h = runSim(w, opts, (f, year) => { const t = performance.now(); if (t - last > 100){ last = t; progress('History, year ' + year, f); } });
  const { heightAt, isLand, gridIndex, ...data } = w;
  const bufs = [data.height, data.elev, data.water, data.flow, data.temp, data.humid, data.fert, data.life].map((a) => a.buffer);
  self.postMessage({ id, world: data, history: h }, bufs);
};
