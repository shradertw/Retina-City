/* Builds render cells in the background, so the view never waits for new chunks. It builds its own copy of
   the world from the same options (the generators give the same result anywhere), then answers requests for
   chunks. Results go back as transferred buffers (no copying). */
import { buildWorld } from './world.js';
import { makeRoads } from './roads.js';
import { makeBlocks } from './blocks.js';
import { makeCells } from './cells.js';

let cells = null, id = 0;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init'){
    const w = buildWorld(m.options), roads = makeRoads(w);
    cells = makeCells(roads, makeBlocks(w, roads));
    id = m.id;
    return;
  }
  if (m.type === 'pack'){
    if (m.id !== id || !cells) return;            // from a world that has since been replaced
    const p = cells.pack(m.cx, m.cz);
    self.postMessage({ id, p }, [p.cells.buffer, p.data.buffer, p.lamps.buffer]);
  }
};
