/* Behaviour traits of households (family groups). Each is a scale from 0 to 1 between two ways of acting,
   named so that neither end is good or bad; 0.5 is "as likely either way". A trait is not one behaviour: it
   tilts every choice it bears on, by a weight per kind of choice (BEARS_ON below).
   Households start with traits drawn around their band's or family's, pass them to their branches with some
   change, and drift toward the settlement's average (people take on the ways of those around them).
   For now the traits are recorded and shown; the choices that use them come later (see the design doc:
   "Behaviour traits"). */
export const TRAITS = [
  { key: 'sharing', low: 'keeps to its own', high: 'shares with others' },
  { key: 'force', low: 'avoids force', high: 'uses force readily' },
  { key: 'novelty', low: 'keeps to known ways', high: 'tries new ways' },
  { key: 'order', low: 'acts as things come', high: 'plans and keeps rules' },
  { key: 'roaming', low: 'stays put', high: 'moves on' },
  { key: 'trust', low: 'wary of outsiders', high: 'trusting of outsiders' },
];
export const NT = TRAITS.length;
export const TI = Object.fromEntries(TRAITS.map((t, i) => [t.key, i]));
/* How strongly each trait tilts each kind of choice (positive: the high end makes it likelier). Planned uses:
     share       giving food to households that are short               sharing +, trust +
     trade       sending surplus to other settlements' markets           trust +, sharing +
     raid        taking food from another settlement by force            force +, sharing -, trust -
     defend      resisting a raid                                        force +, order +
     adopt       taking up a discovery seen elsewhere                    novelty +, trust +
     invent      making a discovery                                      novelty +
     leave       a branch moving far away                                roaming +, novelty +
     plan        laying streets out in a grid (vs growing them)          order +
     join        joining a bigger settlement nearby                      trust +, order +, force - */
export const BEARS_ON = {
  share: { sharing: 1, trust: 0.4 },
  trade: { trust: 0.8, sharing: 0.3 },
  raid: { force: 1.2, sharing: -0.6, trust: -0.6 },
  defend: { force: 0.8, order: 0.4 },
  adopt: { novelty: 0.8, trust: 0.4 },
  invent: { novelty: 0.8 },
  leave: { roaming: 1, novelty: 0.3 },
  plan: { order: 1 },
  join: { trust: 0.6, order: 0.3, force: -0.4 },
};
/** how much a household's traits tilt a choice: a multiplier, 1 for an average household; each trait moves
 *  it by up to 2^(weight) either way @param {Float32Array | number[]} tr @param {string} choice */
export function inclination(tr, choice){
  let m = 1;
  for (const [k, wgt] of Object.entries(BEARS_ON[choice])) m *= Math.pow(2, wgt * (tr[TI[k]] - 0.5) * 2);
  return m;
}
/** a word for a trait value */
export const describe = (i, v) => v < 0.35 ? TRAITS[i].low : v > 0.65 ? TRAITS[i].high : null;
