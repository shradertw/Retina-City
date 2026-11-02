/* Discoveries: what people can learn, what each needs first, and what it changes.
   Each entry:
     key, name     short id and the name shown on the map
     needs         discoveries that must be known first (indices into TECH, by key)
     difficulty    how hard it is to come up with: the chance per 5-year step for a household of ordinary
                   ingenuity with some surplus is about 1 / difficulty (before the pace setting)
     resource      something that must be within reach of the household's home: 'copper', 'iron', 'coal',
                   'river' (within reach: 6 km for metals, 2 km for a river; through trade, later, further)
     yield         farmland yield multiplier while known
     labour        how many more times the land one family can work (farm machinery, fertiliser)
     era           the era name it starts, for the map's labels (the latest known era names a settlement)
   Known discoveries are kept as a bit mask per household (bit i = TECH[i]); up to 31 entries.
   Effects beyond yield are read where they matter in src/gen/sim.js (printing: knowledge spreads faster;
   medicine: fewer deaths; steam: factories; rail and cars: trade and commuting reach; steel frames and
   elevators: taller buildings). */
export const TECH = [
  { key: 'farming', name: 'farming', needs: [], difficulty: 6, era: 'Farming' },
  { key: 'plough', name: 'the plough', needs: ['farming'], difficulty: 60, yield: 1.35 },
  { key: 'masonry', name: 'masonry', needs: ['farming'], difficulty: 50, era: 'Masonry' },
  { key: 'wheel', name: 'the wheel and carts', needs: ['farming'], difficulty: 45 },
  { key: 'bronze', name: 'bronze working', needs: ['masonry'], difficulty: 70, resource: 'copper', yield: 1.1, era: 'Bronze' },
  { key: 'iron', name: 'iron working', needs: ['bronze'], difficulty: 110, resource: 'iron', yield: 1.2, era: 'Iron' },
  { key: 'rotation', name: 'crop rotation', needs: ['plough'], difficulty: 140, yield: 1.3 },
  { key: 'mill', name: 'water mills', needs: ['masonry', 'wheel'], difficulty: 120, resource: 'river', yield: 1.15, era: 'Mills' },
  // stage 4: the later discoveries (a resource is needed to invent; learning from others works anywhere)
  { key: 'printing', name: 'printing', needs: ['masonry', 'wheel'], difficulty: 5000, era: 'Printing' },
  { key: 'medicine', name: 'medicine', needs: ['printing'], difficulty: 7000 },
  { key: 'steam', name: 'steam power', needs: ['iron', 'mill', 'printing'], difficulty: 5000, resource: 'coal', era: 'Industry' },
  { key: 'machinery', name: 'farm machinery', needs: ['steam'], difficulty: 18000, yield: 1.4, labour: 2.5 },
  { key: 'rail', name: 'railways', needs: ['steam'], difficulty: 18000, era: 'Railways' },
  { key: 'steel', name: 'steel frames', needs: ['steam'], difficulty: 22000 },
  { key: 'electricity', name: 'electricity', needs: ['steam'], difficulty: 28000, era: 'Electric' },
  { key: 'fertiliser', name: 'fertiliser', needs: ['electricity'], difficulty: 22000, yield: 1.5, labour: 2 },
  { key: 'elevator', name: 'elevators', needs: ['steel', 'electricity'], difficulty: 22000 },
  { key: 'car', name: 'cars', needs: ['steel', 'electricity'], difficulty: 32000, era: 'Cars' },
];
export const TECH_INDEX = Object.fromEntries(TECH.map((t, i) => [t.key, i]));
export const bit = (key) => 1 << TECH_INDEX[key];
for (const t of TECH) t.mask = t.needs.reduce((m, k) => m | bit(k), 0);
/** farmland yield multiplier for a knowledge mask */
export function yieldOf(mask){
  let y = 1;
  TECH.forEach((t, i) => { if (t.yield && mask & (1 << i)) y *= t.yield; });
  return y;
}
/** the era a knowledge mask is in (the latest era-starting discovery known) */
export function eraOf(mask){
  let e = 'Foragers';
  TECH.forEach((t, i) => { if (t.era && mask & (1 << i)) e = t.era; });
  return e;
}
/** names of the discoveries in a mask */
export const namesOf = (mask) => TECH.filter((t, i) => mask & (1 << i)).map((t) => t.name);
/** how many bits are set */
export const count = (m) => { let n = 0; while (m){ m &= m - 1; n++; } return n; };
