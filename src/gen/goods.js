/* Goods and livelihoods (Stage B; design: "Goods and livelihoods" in the design doc). Used by the history
   simulation (src/gen/sim.js).

   Four goods besides food, counted in units: one unit is worth one person's food for a 5-year step when it
   is neither short nor plentiful.
     wood     timber for building and repairs, and fuel for warmth (more in cold places)
     stone    for building once masonry is known (stone buildings, paved streets)
     metal    tools (once bronze is known; more with iron): farmers and producers get more done with them
     coal     fuel and factory power once steam is known (it stands in for part of the wood burned)

   Five livelihoods for country families (WORK): farming, fishing (food), logging (wood), quarrying (stone)
   and mining (metal, or coal at a coal deposit). A family takes one up when it settles somewhere new, by how
   well it expects its needs met there (see moveOut in sim.js). Nothing says where each should be: fishing
   villages, logging camps, quarry and mining towns grow where the resource is and a market nearby is short of
   what it makes. */

export const GOODS = ['wood', 'stone', 'metal', 'coal'];
export const G = { wood: 0, stone: 1, metal: 2, coal: 3 };
export const WORK = ['farming', 'fishing', 'logging', 'quarrying', 'mining'];
export const W = { farm: 0, fish: 1, wood: 2, stone: 3, metal: 4 };

// output per person per step, before tools and the resource's limits (units; fish in people's food)
export const RATE = { fish: 1.5, wood: 1.6, stone: 1.3, metal: 0.8, coal: 1.2 };

// wood in a 128 m land cell of full-grown forest (units); forest regrowth per step (logistic, plus seeding)
export const WOOD_CELL = 100, REGROW = 0.15, SEED = 0.01;
// natural tree cover by kind of land (src/gen/world.js LIFE)
export const FOREST_OF = [0, 0, 0, 0, 0.08, 0.9, 0.1, 0.15, 0.9, 0.02, 0.3, 1, 0];

// demand per person per step: fuel (times 0.3 + cold), tools (with bronze; 1.5x with iron), factory power
export const FUEL = 0.05, TOOL = 0.015, POWER = 0.06;
// what a new building takes: a home (wood, or with masonry stone and a little wood), per storey of a town
// building (twice a home's), a factory (stone and metal); repairs per building per step
export const BUILD = { home: [3, 0, 0], homeStone: [1, 2, 0], town: [6, 0, 0], townStone: [2, 4, 0], factory: [2, 6, 2] };
export const UPKEEP = 0.01;

// how far each good travels (times the food trade's reach): heavy goods less; along water and roads further
export const REACH = [0.6, 0.35, 0.7, 0.5];
export const WATER_REACH = 2.5, ROAD_REACH = 1.5;
// a good's price where it is sold: what is wanted over what arrives, within these bounds
export const PRICE_MIN = 0.4, PRICE_MAX = 3;
export const priceOf = (want, got) => Math.min(PRICE_MAX, Math.max(PRICE_MIN, want / Math.max(got, 1e-3)));

// fishing grounds: people's food a km2 of water yields each step, sustained (sea near the shore, lakes,
// rivers); the stock (0-1 of what the water holds) grows back logistically, and the most that can be caught
// in a step is twice the sustained yield times the stock
export const FISH_KM2 = [0, 10, 6, 15], FISH_SHORE = 3000;
// people a quarry's rock and a deposit can employ before each more adds less
export const ROCK_PEOPLE = 40, MINE_PEOPLE = 80;
