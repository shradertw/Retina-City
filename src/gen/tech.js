/* Discoveries: what people can learn, what each needs first, and what it changes.
   Each entry:
     key, name     short id and the name shown on the map
     needs         discoveries that must be known first (indices into TECH, by key)
     difficulty    how hard it is to come up with: the chance per 5-year step for a household of ordinary
                   ingenuity with some surplus is about 1 / difficulty (before the pace setting)
     resource      something that must be within reach of the household's home: 'copper', 'iron', 'coal',
                   'river' (within reach: 6 km for metals, 2 km for a river; through trade, later, further)
     yield         farmland yield multiplier while known
     era           the era name it starts, for the map's labels (the latest known era names a settlement)
   Known discoveries are kept as a bit mask per household (bit i = TECH[i]); up to 31 entries.
   Stage 1 has the first eight; later stages add printing, steam, rail, steel frames, electricity, lifts, cars. */
export const TECH = [
  { key: 'farming', name: 'farming', needs: [], difficulty: 6, era: 'Farming' },
  { key: 'plough', name: 'the plough', needs: ['farming'], difficulty: 60, yield: 1.35 },
  { key: 'masonry', name: 'masonry', needs: ['farming'], difficulty: 50, era: 'Masonry' },
  { key: 'wheel', name: 'the wheel and carts', needs: ['farming'], difficulty: 45 },
  { key: 'bronze', name: 'bronze working', needs: ['masonry'], difficulty: 70, resource: 'copper', yield: 1.1, era: 'Bronze' },
  { key: 'iron', name: 'iron working', needs: ['bronze'], difficulty: 110, resource: 'iron', yield: 1.2, era: 'Iron' },
  { key: 'rotation', name: 'crop rotation', needs: ['plough'], difficulty: 140, yield: 1.3 },
  { key: 'mill', name: 'water mills', needs: ['masonry', 'wheel'], difficulty: 120, resource: 'river', yield: 1.15, era: 'Mills' },
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
