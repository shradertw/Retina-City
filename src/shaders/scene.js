/* The scene: one ray per sampling cell through the raymarched city, sky, sun and moon. */
import { VS, FS, LUMA, LIDS, PROJ, CELLFN } from './common.js';

/* Feature switches (NO_REFL, NO_DOORS, NO_SPRITES, NO_SHADOW, NO_MATERIALS, NO_LAMPLIGHT, NO_SKYDETAIL)
   exist only for the compile-time diagnostic page (diag.html); the game never sets them. */
export const SCENE_FS = `#version 300 es
precision highp float;
precision highp int;
/* The scene is drawn in five passes over the same cells, each a smaller shader (the Direct3D compiler used
   by browsers on Windows slows down out of proportion as one shader grows):
     PASS_GEOM     the ray: distance, material, surface direction             -> uG0
     PASS_MAT      materials: colour, glass, reflectivity, bumped direction   -> uM0, uM1, uM2
     PASS_LIGHT    sun shadow, ambient occlusion, street-light illumination   -> uL0
     PASS_REFL     what glass reflects                                        -> uRf
     PASS_COMPOSE  everything combined, and the sky where rays hit nothing    -> the scene image
   With none defined, one shader does it all (kept for comparison: ?single). */
#if !defined(PASS_GEOM) && !defined(PASS_MAT) && !defined(PASS_LIGHT) && !defined(PASS_REFL) && !defined(PASS_COMPOSE)
#define PASS_ALL
#endif
#ifdef PASS_MAT
layout(location = 0) out vec4 oM0;
layout(location = 1) out vec4 oM1;
layout(location = 2) out vec4 oM2;
#else
out vec4 outColor;
#endif
uniform highp sampler2D uG0, uM0, uM1, uM2, uL0, uRf;   // the earlier passes' results, at this cell
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform mat3 uCamRot;
uniform vec2 uGaze;
uniform vec3 uGazeDir;
uniform float uAcuity;
uniform float uZoom;
uniform int uMode;
uniform uint uSeed;
// Always 0, but unknown to the compiler: loops start at ZERO so the Direct3D shader compiler (used by
// browsers on Windows) cannot unroll them into one copy of the body per iteration. Unrolled, the scene
// shader took ~100 s to compile.
uniform int uZero;
#define ZERO uZero
// sampling layout: every fragment of this pass is one cell = one ray
uniform int uLayout;      // 0 = square-grid level, 1 = retina rings (log-polar)
uniform float uCell;      // cell size in screen pixels for this grid level
uniform int uLvl;
uniform vec2 uLvlOff;
uniform int uFov, uLpMode, uFast;
uniform float uBase, uMult, uA, uR2, uR0, uNth, uS, uE2, uPixVis;
uniform vec2 uJit;
uniform int uAttn, uAttnBld;   // attention on; the gazed-at thing is a building
uniform vec3 uAttnP;          // world point under the gaze
uniform vec2 uAttnB;          // that building's centre
uniform float uAttnK;         // attention strength: attended falloff x k, the rest / sqrt(k)
uniform int uReflMode;        // what glass reflects: 0 sky only, 1 the city (simple), 2 simple + shadows, 3 full
uniform float uReflReach;     // how far reflected rays travel before fading to sky (m)
${PROJ}
${CELLFN}

// Sky and light, computed each frame from the time, moon and cloud dials. "Normalised" values are
// divided by the overall light level, so the stored image stays near 1 day or night; the eye model
// multiplies the real level back in at the end.
uniform vec3 uSunDir, uMoonDir, uKeyDir;
uniform float uMoonSize, uMoonPhase;   // moon size (1 = real); phase from the dial (0 full, +pi/2 first quarter, +-pi new, -pi/2 last quarter)
uniform vec3 uKeyCol, uSunColor, uAmbTint, uFogCol;
uniform float uSunK, uAmbK, uSkyK, uTwi, uNightSky, uMoonDisk, uCloud;
uniform float uSunDiskK;   // sun disk brightness where it shows (clouds dim the light, not the disk in a gap)
uniform float uCloudGrey;  // how far clouds grey the sky colour (0 when clouds do not affect lighting)
uniform float uShadowK;    // shadow sharpness: ~60 under a clear sun, lower as cloud diffuses the light
uniform float uEyeScale;   // the eye's current brightness gain (for star visibility)
uniform float uLampK;      // street-light irradiance (lux) -> scene light, 0 when the lights are off
uniform float uLampEmit;   // brightness of a lit lamp lens in scene units
uniform float uAbsScale;   // cd/m2 per unit of normalised scene light
uniform vec2 uCloudOff;
uniform mat3 uStarRot;                     // turns the star field with the time of day

/* ---- hashing: identical to the JavaScript copy ---- */
uint hu(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
uint h2(ivec2 c, uint s){ return hu((uint(c.x + 1048576) * 0x9E3779B1u) ^ hu(uint(c.y + 1048576) + s)); }
float hf(uint h){ return float(h >> 8u) * (1.0/16777216.0); }
float rnd(uint h, uint k){ return hf(hu(h + k * 0x632BE5ABu)); }

/* ---- detail gating ---- */
// A feature is resolved once it spans about two receptor footprints (sampling limit).
// Layers fade out over a wide range (0.75 to 2.5 footprints) so there is no visible edge where they stop
float gate(float size, float f){ return smoothstep(0.75, 2.5, size / f); }

/* Box-filtered line pattern: exact fraction of a receptor footprint (width f)
   covered by lines of width L repeating every P. Converges to L/P when f >> P. */
float pI(float x, float P, float L){ float k = floor(x / P); return k * L + min(x - P * k, L); }
// The pattern repeats every P, so wrap x into one period first: subtracting two large, nearly equal
// numbers (world positions hundreds of metres out) and dividing by a tiny footprint destroys precision.
float pulseF(float x, float P, float L, float f){
  f = max(f, 1e-5);
  float xm = x - P * floor(x / P);
  return clamp((pI(xm + 0.5*f, P, L) - pI(xm - 0.5*f, P, L)) / f, 0.0, 1.0);
}

float hash2f(vec2 i){ return hf(h2(ivec2(i), uSeed ^ 0xA511E9B3u)); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
  float a = hash2f(i), b = hash2f(i + vec2(1,0)), c = hash2f(i + vec2(0,1)), d = hash2f(i + vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
// A small dot of radius r (repeating every P) filtered by the footprint. Once it is smaller than a
// receptor it spreads into a fainter, wider smudge with the same total darkness, so it stays visible.
float dotF(vec2 q, float r, float P, vec2 f){
  vec2 R = sqrt(r*r + 0.25*f*f);
  float amp = r*r / (R.x*R.y);
  float d = length(q / R);
  float k = clamp(0.5*max(f.x/R.x, f.y/R.y), 0.02, 0.9);
  float m = amp * (1.0 - smoothstep(1.0 - k, 1.0 + k, d));
  return mix(m, 3.14159*r*r/(P*P), smoothstep(0.25*P, 0.5*P, max(R.x, R.y)));
}

// Fine detail is computed on coordinates wrapped every 64 m: a world position like 800 m can only be
// stored to about 0.1 mm, and a 64 m repeat is invisible at millimetre scale.
vec2 fineP(vec2 p, float size){ return size < 0.05 ? mod(p, 64.0) : p; }

// Fractal noise that keeps adding finer layers until they are smaller than a receptor
// (or reach minSize). Layers too fine to resolve contribute their average (zero).
// Height-only mode: surface relief needs heights at two extra nearby points for every pixel; colour
// layers do not change height, so they are skipped there (they are the bulk of the work).
bool gHOnly = false;
float fbmG(vec2 p, float size0, float minSize, float f){
  if (gHOnly) return 0.0;                 // fractal noise is only ever used for colour
  float s = 0.0, a = 0.5, sz = size0;
  for (int i = 0 + ZERO; i < 14; i++){
    if (sz < minSize) break;
    float w = gate(sz, f);
    if (w <= 0.0) break;
    s += w * a * (vnoise(fineP(p, sz) / sz + float(i) * 7.31) * 2.0 - 1.0);
    a *= 0.5; sz *= 0.5;
  }
  return s * 1.6;
}

// Cellular noise: distinct grains. x = this grain's random value, y = distance to the nearest grain edge,
// z = distance to the grain's centre, w = a second random value for the grain.
vec4 grains(vec2 p, uint salt){
  vec2 i = floor(p), fr = p - i;
  float d1 = 8.0, d2 = 8.0, id = 0.0, id2 = 0.0;
  for (int y = -1 + ZERO; y <= 1; y++) for (int x = -1 + ZERO; x <= 1; x++){
    vec2 g = vec2(float(x), float(y));
    uint h = h2(ivec2(i + g), uSeed ^ salt);
    vec2 r = g + vec2(rnd(h, 1u), rnd(h, 2u)) - fr;
    float d = dot(r, r);
    if (d < d1){ d2 = d1; d1 = d; id = rnd(h, 3u); id2 = rnd(h, 4u); } else if (d < d2) d2 = d;
  }
  return vec4(id, sqrt(d2) - sqrt(d1), sqrt(d1), id2);
}
// A layer of grains of a given size: x = colour variation around 0, y = crevice between grains (0..1).
// Fades to its average once grains are smaller than a receptor.
vec2 grainLayer(vec2 uv, float size, uint salt, float fe){
  float w = gate(size, fe);
  if (w <= 0.0) return vec2(0.0);
  vec4 g = grains(fineP(uv, size) / size, salt);
  float soft = 0.08 + 0.6 * clamp(fe / size, 0.0, 1.0);
  return vec2((g.x - 0.5) * w, (1.0 - smoothstep(0.0, soft, g.y)) * w);
}
// Rounded stones scattered through a binder (concrete aggregate).
// x = stone colour variation, y = how much of the spot is stone. Unresolved: average coverage.
vec2 stoneLayer(vec2 uv, float size, float coverage, uint salt, float fe){
  float avg = coverage * 0.36;
  if (gHOnly) return vec2(0.0, avg);      // colour only
  float w = gate(size, fe);
  if (w <= 0.0) return vec2(0.0, avg);
  vec4 g = grains(fineP(uv, size) / size, salt);
  float r = 0.28 + 0.16*g.w;
  float soft = 0.04 + 0.5 * clamp(fe / size, 0.0, 1.0);
  float m = g.w < coverage ? 1.0 - smoothstep(r - soft, r + soft, g.z) : 0.0;
  return vec2((g.x - 0.5) * m * w, mix(avg, m, w));
}
// Sparse small pits (air voids, chips). Each cell may hold one pit; once smaller than a receptor
// a pit spreads into a fainter smudge, and at a distance the layer becomes its average darkness.
float pits(vec2 uv, float cellSize, float rMin, float rMax, float chance, uint salt, vec2 f){
  vec2 q = fineP(uv, cellSize) / cellSize;
  vec2 i = floor(q);
  uint h = h2(ivec2(i), uSeed ^ salt);
  float r = mix(rMin, rMax, rnd(h, 3u));
  vec2 c = (i + 0.25 + 0.5*vec2(rnd(h, 1u), rnd(h, 2u))) * cellSize;
  float m = rnd(h, 4u) < chance ? dotF(fineP(uv, cellSize) - c, r, 1e6, f) : 0.0;
  float rAvg = 0.5*(rMin + rMax);
  float far = smoothstep(0.25*cellSize, 0.5*cellSize, sqrt(rAvg*rAvg + 0.25*max(f.x, f.y)*max(f.x, f.y)));
  return mix(m, chance * 3.14159 * rAvg*rAvg / (cellSize*cellSize), far);
}

/* ---- the world as data: render cells (see src/gen/cells.js for the layouts) ----
   Cells of 32 m, 16 x 16 per 512 m chunk, 9 x 9 chunks around the player in wrapping slots. Each cell lists
   the buildings, street lights and road pieces that can matter inside it; a cell of a chunk not (yet) in its
   slot reads as empty. */
uniform highp sampler2D uCells, uList, uLand, uLampTex;
uniform int uLampN;          // street lights in uLampTex (nearest the camera first)
uniform float uLampR;        // lights farther than this are not in uLampTex: drawn neither as poles nor glows
uniform float uWorldHalf;    // the world square: -half..half on both axes
const float RC = 32.0, PAD = 8.0, LAMP_H = 8.0;
const int SLOT_TEX = 12288;
vec4 wT(int i){ return texelFetch(uList, ivec2(i & 4095, i >> 12), 0); }
// The cell at xz: list start (global texel), counts, empty rings around it, tallest top. False if not loaded.
bool cellAt(vec2 xz, out int base, out ivec4 n, out float top, out vec2 lo){
  vec2 cf = floor(xz / RC);
  lo = cf * RC;
  vec2 ch = floor(cf / 16.0), sl = mod(ch, 9.0);
  vec4 v = texelFetch(uCells, ivec2(mod(cf, 144.0)), 0);
  base = 0; n = ivec4(0, 0, 0, 1); top = 0.0;
  if (v.z != (ch.x + 512.0) * 1024.0 + ch.y + 513.0) return false;
  int k = int(v.y);
  base = int(sl.y * 9.0 + sl.x) * SLOT_TEX + int(v.x);
  n = ivec4(k & 63, (k >> 6) & 63, (k >> 12) & 63, k >> 18);
  top = v.w;
  return true;
}
bool isLand(vec2 xz){ return texture(uLand, (xz + uWorldHalf) / (2.0 * uWorldHalf)).r > 0.0; }

// Materials (the second number map() returns): 0 road, 1 sidewalk (and curbs), 2 building, 5 podium,
// 6 paved lot, 7 lamp pole, 8 lamp head, 9 water. For buildings and podiums, + 16 x the building's first
// texel, so the material pass can read the building's data.
float matId(float m){ return m - 16.0 * floor(m / 16.0); }
int bldOf(float m){ return int(m / 16.0); }
struct Bld { vec2 c; vec2 u; vec2 hs; float top; float podH; float kind; float var; float doorOff; int door; };
Bld getBld(int k){
  vec4 a = wT(k), b = wT(k + 1), c = wT(k + 2);
  Bld r; r.c = a.xy; r.u = a.zw; r.hs = b.xy; r.top = b.z; r.podH = b.w; r.kind = c.x; r.var = c.y; r.doorOff = c.z; r.door = int(c.w);
  return r;
}

float sdBox(vec3 p, vec3 b){ vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }

// Door openings: Wn wide (leaf + 6 cm frame each side), Hn tall from the sidewalk (leaf 2.2 m, frame,
// optional 46 cm transom window, frame). Each is a niche 25 cm deep in the wall.
void doorDims(int code, out float Wn, out float Hn){
  Wn = ((code & 2) != 0 ? 1.8 : 0.95) + 0.12;
  Hn = 2.32 + ((code & 1) != 0 ? 0.46 : 0.0);
}

// step limits set by map(): gBound, a distance nothing unlisted can be nearer than; and the region
// (gRegLo..gRegHi, above gTop) a ray can cross without being able to hit anything (see rayJump)
float gBound = 1e9, gTop = 1e9;
vec2 gRegLo = vec2(0.0), gRegHi = vec2(0.0);
float rayJump(vec3 p, vec3 rd){
  if (p.y < gTop) return 0.0;
  vec2 d = vec2(abs(rd.x) < 1e-6 ? 1e-6 : rd.x, abs(rd.z) < 1e-6 ? 1e-6 : rd.z);
  vec2 tx = (mix(gRegLo, gRegHi, step(0.0, d)) - p.xz) / d;
  float t = min(tx.x, tx.y);
  if (rd.y < 0.0) t = min(t, (p.y - gTop) / -rd.y);
  return t + 0.01;
}

/* ---- street lights: upside-down L poles at the curb, arm over the road ----
   Pole 8 m tall, 0.6 m back from the road edge, with a 2.5 m arm. Data: (pole x, z, arm direction x, z). */
vec3 lampHead(vec4 L){ return vec3(L.x + L.z * 2.5, LAMP_H - 0.25, L.y + L.w * 2.5); }
// distance and material (7 pole and arm, 8 lamp head); lb = distance to a box around the whole light
vec2 lampSDF(vec3 p, vec4 L, out float lb){
  vec2 base = L.xy, arm = L.zw, side = vec2(-arm.y, arm.x);
  vec2 q = p.xz - base;
  vec2 lq = vec2(dot(q, arm), dot(q, side));            // along the arm, across it
  lb = sdBox(vec3(lq.x - 1.3, p.y - 4.1, lq.y), vec3(1.75, 4.0, 0.45));
  float pole = max(length(q) - 0.09, max(p.y - LAMP_H, 0.15 - p.y));      // capped cylinder (approx.)
  float armD = sdBox(vec3(lq.x - 1.3, p.y - (LAMP_H - 0.12), lq.y), vec3(1.3, 0.05, 0.05));
  float headD = sdBox(vec3(lq.x - 2.5, p.y - (LAMP_H - 0.25), lq.y), vec3(0.36, 0.08, 0.17));
  float d = min(pole, armD);
  return headD < d ? vec2(headD, 8.0) : vec2(d, 7.0);
}
// How bright a lamp lens looks from a viewing direction: the light leaves in a downward cone, so the lens
// is fully bright from inside it and dims to ~8% seen from far off to the side (cosUp: the ray's upward part).
float lensView(float cosUp){ return mix(0.08, 1.0, smoothstep(0.42, 0.85, cosUp)); }
// Lamp lenses seen from afar. A lens smaller than a pixel or cell would be hit by some rays and missed by
// others, so it twinkles. Instead each lens adds its light spread over the ray's footprint, with the same
// total light; close up (lens bigger than a pixel) the lens itself is drawn.
vec3 lampSprites(vec3 ro, vec3 rd, float tMax, float fa){
#ifdef NO_SPRITES
  return vec3(0.0);
#else
  vec3 acc = vec3(0.0);
  if (uLampEmit <= 0.0) return acc;
  for (int i = ZERO; i < 128; i++){
    if (i >= uLampN) break;
    vec3 head = lampHead(texelFetch(uLampTex, ivec2(i, 0), 0));
    vec3 v = head - vec3(0.0, 0.08, 0.0) - ro;
    float along = dot(v, rd);
    if (along <= 0.3 || along > tMax + 0.3 || v.y <= 0.0) continue;
    float dist = length(v), rl = 0.2 / dist;           // lens angular radius
    float k = smoothstep(0.5, 2.0, fa / rl);           // 1 = lens much smaller than the footprint
    if (k <= 0.0) continue;
    float R = max(rl, fa) * 2.0;
    float da = length(v - rd * along) / along;
    if (da > R) continue;
    float facing = v.y / dist * lensView(v.y / dist);   // the lens faces down
    acc += (1.0 - smoothstep(0.4 * R, R, da)) * k * facing * (rl * rl) / (0.52 * R * R) * exp(-along * 0.0007);
  }
  return acc * vec3(1.0, 0.66, 0.3) * uLampEmit;
#endif
}
// light from the street lights reaching point p with normal n (lux, before colour). Old-style
// sodium lamps: a narrow cone straight down (full inside ~22 degrees, gone by ~40).
float lampIrradiance(vec3 p, vec3 n){
#ifdef NO_LAMPLIGHT
  return 0.0;
#else
  float E = 0.0;
  int base; ivec4 cn; float top; vec2 lo;
  if (!cellAt(p.xz, base, cn, top, lo)) return 0.0;
  for (int i = ZERO; i < 15; i++){
    if (i >= cn.y) break;
    vec4 L = wT(base + cn.x * 3 + i);
    vec3 v = p - (lampHead(L) - vec3(0.0, 0.1, 0.0));      // from the lens, just under the head
    float d2 = dot(v, v);
    if (d2 > 160.0 || v.y > -0.05) continue;
    float id = inversesqrt(d2);
    float cone = smoothstep(0.77, 0.93, -v.y * id);  // cosine of the angle from straight down
    E += 750.0 * cone * max(dot(n, -v * id), 0.0) / max(d2, 0.25);     // ~12 lux under the lamp
  }
  return E;
#endif
}

vec2 map(vec3 p){
  // Buildings and street lights listed for the cell p is in. The ground is found exactly by groundHit().
  int base; ivec4 cn; float top; vec2 lo;
  bool loaded = cellAt(p.xz, base, cn, top, lo);
  // anything not listed here stays PAD away from the cell (or from the empty square of cells around it)
  float r = float(max(cn.w - 1, 0)) * RC;
  gRegLo = lo - r; gRegHi = lo + RC + r;
  gBound = min(min(p.x - gRegLo.x, gRegHi.x - p.x), min(p.z - gRegLo.y, gRegHi.y - p.z)) + PAD;
  gTop = cn.w > 0 ? -1e9 : top;
  if (cn.w > 0) return vec2(gBound, -1.0);
  if (p.y > top + 1.0) return vec2(min(p.y - top, gBound), -1.0);
  vec2 res = vec2(1e9, -1.0);
  for (int i = ZERO; i < 31; i++){
    if (i >= cn.x) break;
    int k = base + i * 3;
    vec4 a = wT(k), b = wT(k + 1);
    vec2 q = p.xz - a.xy;
    vec2 l = vec2(dot(q, a.zw), dot(q, vec2(-a.w, a.z)));   // along the frontage; away from the road
    if (length(max(abs(l) - b.xy, 0.0)) >= res.x) continue;  // its footprint is farther than what we have
    float d, dp = 1e9;
    if (b.w > 0.0){
      // a tower on a podium: the podium covers the footprint, the tower is set back 2.5 m all round
      dp = sdBox(vec3(l.x, p.y - b.w * 0.5, l.y), vec3(b.x, b.w * 0.5, b.y));
      float th = (b.z - b.w) * 0.5;
      d = sdBox(vec3(l.x, p.y - b.w - th, l.y), vec3(b.x - 2.5, th, b.y - 2.5));
    } else d = sdBox(vec3(l.x, p.y - b.z * 0.5, l.y), vec3(b.x, b.z * 0.5, b.y));
#ifndef NO_DOORS
    // the door niche, cut into the front wall (a tower's podium), looked up only close to it
    float host = b.w > 0.0 ? dp : d;
    if (host < 0.6 && p.y < 3.5){
      vec4 c = wT(k + 2);
      if (c.w >= 0.0){
        float Wn, Hn; doorDims(int(c.w), Wn, Hn);
        host = max(host, -sdBox(vec3(l.x - c.z, p.y - (0.15 + 0.5 * Hn), l.y + b.y), vec3(0.5 * Wn, 0.5 * Hn, 0.25)));
        if (b.w > 0.0) dp = host; else d = host;
      }
    }
#endif
    float id = float(k) * 16.0;
    if (d < res.x) res = vec2(d, id + 2.0);
    if (dp < res.x) res = vec2(dp, id + 5.0);
  }
  for (int i = ZERO; i < 15; i++){
    if (i >= cn.y) break;
    vec4 L = wT(base + cn.x * 3 + i);
    if (distance(L.xy, uCamPos.xz) > uLampR) continue;     // only lights near the camera have poles
    float lb;
    vec2 ld = lampSDF(p, L, lb);
    if (lb < res.x && ld.x < res.x) res = ld;
  }
  return res;
}

/* The road pieces at P: signed distance to the nearest road edge (< 0 on a road), the direction from that
   road's centre line toward P (g), and the road frame there:
   fr = (distance along the road, across it (signed), half width or -1 in a crossing, road length + 1000 if main). */
float roadAt(vec2 P, out vec2 g, out vec4 fr){
  g = vec2(1.0, 0.0); fr = vec4(0.0, 0.0, -1.0, 0.0);
  int base; ivec4 cn; float top; vec2 lo;
  if (!cellAt(P, base, cn, top, lo)) return 1e9;
  float best = 1e9;
  vec2 d1 = vec2(0.0); bool crossing = false;
  for (int i = ZERO; i < 31; i++){
    if (i >= cn.z) break;
    int k = base + cn.x * 3 + cn.y + i * 2;
    vec4 a = wT(k), b = wT(k + 1);
    vec2 ab = a.zw - a.xy;
    float L = max(length(ab), 1e-4);
    vec2 dir = ab / L, nrm = vec2(-dir.y, dir.x);
    float s = clamp(dot(P - a.xy, dir), 0.0, L);
    vec2 dv = P - a.xy - dir * s;
    float dc = length(dv), d = dc - b.x;
    if (d < 0.0){
      if (dot(d1, d1) == 0.0) d1 = dir;
      else if (abs(dot(dir, d1)) < 0.7) crossing = true;   // inside two roads that cross
    }
    if (d < best){
      best = d;
      g = dc > 1e-5 ? dv / dc : nrm;
      fr = vec4(b.y + dot(P - a.xy, dir), dot(P - a.xy, nrm), b.x, b.z + 1000.0 * b.w);
    }
  }
  if (crossing) fr.z = -1.0;
  return best;
}

// Exact hit with the ground: roads and water at y = 0, sidewalks and lots at 0.15 (on land, off the roads),
// and the curbs between. Returns the distance, the material and the normal.
float groundHit(vec3 ro, vec3 rd, out float gm, out vec3 gn){
  gm = 0.0; gn = vec3(0.0, 1.0, 0.0);
  if (rd.y > -1e-6) return 1e9;
  float t15 = (0.15 - ro.y) / rd.y, t0 = -ro.y / rd.y, h = max(length(rd.xz), 1e-6);
  float t = max(t15, 0.0);
  // from where the ray passes the sidewalk height down to the road: while over a road, move on to where it
  // could leave it (the distance to the road edge); on leaving it, that is a curb
  for (int k = ZERO; k < 12; k++){
    vec2 P = ro.xz + rd.xz * t;
    if (!isLand(P)){ gm = 9.0; return t0; }
    vec2 g; vec4 fr;
    float dR = roadAt(P, g, fr);
    if (dR > 0.0){
      if (k == 0){ gm = dR < 3.0 ? 1.0 : 6.0; return t; }
      gm = 1.0; gn = vec3(-g.x, 0.0, -g.y); return t;
    }
    t += max(-dR / h, 0.02);
    if (t >= t0) break;
  }
  gm = 0.0;
  return t0;
}

vec3 calcN(vec3 p, float t){
  // four taps (1,-1,-1), (-1,-1,1), (-1,1,-1), (1,1,1), written as a loop so map() is compiled once here
  float e = max(0.0008, 0.0004*t); vec3 n = vec3(0.0);
  for (int i = ZERO; i < 4; i++){
    vec3 k = 2.0 * vec3(float(((i + 3) >> 1) & 1), float((i >> 1) & 1), float(i & 1)) - 1.0;
    n += k * map(p + k*e).x;
  }
  return normalize(n);
}
// Soft shadow: how closely the ray toward the sun passes by geometry.
// Uses the closest approach between samples (not only at them) to avoid banding,
// and a per-pixel, per-frame start offset that frame blending averages out.
float softShadow(vec3 ro, vec3 rd, float jit){
#ifdef NO_SHADOW
  return 1.0;
#else
  float res = 1.0, t = 0.03 + 0.08*jit, ph = -1.0, st = 0.0;
  // enough steps for rays that skim along the ground before reaching a building
  for (int i = 0 + ZERO; i < 128; i++){
    vec3 p = ro + rd*t;
    if (p.y > 150.0) break;
    float h = map(p).x;
    // Two samples a step st apart, each with a clear sphere around it: estimate where along
    // the step the ray came closest to the surface, and how close (dd).
    float y = 0.0, dd = h;
    if (ph > 0.0){
      y = (h*h - ph*ph + st*st) / (2.0*st);
      if (y > 0.0 && y < st) dd = sqrt(max(h*h - y*y, 0.0)); else y = 0.0;
    }
    // k = 60: penumbra about 1 degree wide (the sun's disk is ~0.5 degree, plus some sky scatter)
    res = min(res, uShadowK*dd / max(t - y, 1e-3));
    ph = h;
    st = clamp(min(h, gBound), 0.04, 6.0);
    float j = rayJump(p, rd);
    if (j > st){ st = j; ph = -1.0; }     // above everything here: nothing to come close to on the way
    t += st;
    if (res < 0.002 || t > 400.0) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res*res*(3.0 - 2.0*res);
#endif
}
float calcAO(vec3 p, vec3 n){
  float o = 0.0, s = 1.0;
  for (int i = 1 + ZERO; i <= 4; i++){ float h = 0.12*float(i*i); o += (h - map(p + n*h).x) * s; s *= 0.6; }
  return clamp(1.0 - 0.45*o, 0.0, 1.0);
}

// Stars: real illuminance from magnitude, judged against the sky behind them. The eye detects a
// point once its illuminance passes a threshold that rises with background brightness (about mag 6 under
// a dark sky, mag 0 at dusk, nothing but Venus by day); visible stars ramp from faint to white over
// ~1.5 decades. Returns light already divided by the eye's gain, so it lands at that brightness on screen.
// Cells of 0.6 degrees; a star's spot is checked in this cell and its neighbours.
vec3 stars(vec3 rd, float ang, float bgCd){
#ifdef NO_SKYDETAIL
  return vec3(0.0);
#else
  vec3 d = uStarRot * rd;
  float lat = asin(clamp(d.y, -1.0, 1.0)), lon = atan(d.z, d.x);
  const float CS = 0.0104720;                       // 0.6 degrees in radians
  float li = floor(lat / CS);
  float r = max(0.6 * ang, 6e-5), r2 = r * r;
  float Eth = 1e-8 * sqrt(max(bgCd, 1e-6) / 2e-4);      // lux needed to see a point on this background
  vec3 acc = vec3(0.0);
  for (int j = -1 + ZERO; j <= 1; j++){
    float lc = (li + float(j) + 0.5) * CS;
    float nLon = max(1.0, floor(6.2831853 * cos(lc) / CS));
    float lj = floor((lon + 3.14159265) / 6.2831853 * nLon);
    for (int i = -1 + ZERO; i <= 1; i++){
      float lk = mod(lj + float(i), nLon);
      uint h = h2(ivec2(int(lk), int(li) + j), uSeed ^ 0x5A17u);
      if (rnd(h, 1u) > 0.3) continue;
      float slat = (li + float(j) + rnd(h, 2u)) * CS;
      float slon = (lk + rnd(h, 3u)) / nLon * 6.2831853 - 3.14159265;
      vec3 sd = vec3(cos(slat) * cos(slon), sin(slat), cos(slat) * sin(slon));
      float dd = 1.0 - dot(d, sd);                  // ~ angle^2 / 2
      if (dd > 8.0 * r2) continue;
      float mag = 8.0 + 2.0 * log(max(rnd(h, 4u), 1e-6)) / log(10.0);   // many faint, few bright
      float E = 2.5e-6 * pow(10.0, -0.4 * mag) * exp(-0.25 / (max(rd.y, 0.0) + 0.04));   // lux, dimmed near the horizon
      float vis = smoothstep(0.0, 1.0, log(E / Eth) / log(10.0) / 1.5);
      if (vis <= 0.0) continue;
      float k = 1.0 - smoothstep(0.6, 1.0, sqrt(2.0 * dd / r2));   // compact spot, one receptor wide
      float tcol = rnd(h, 5u);
      acc += vis * k * 1.2 / max(uEyeScale, 1e-12) * mix(vec3(1.0, 0.85, 0.7), vec3(0.8, 0.88, 1.0), tcol);
    }
  }
  return acc;
#endif
}
// The moon: a lit sphere, so its phase and the tilt of the lit side follow the sun's real direction.
// The moon's near side, drawn on the visible disk (x to the left on screen = lunar west, y up; radius 1):
// dark plains (maria) at their real positions (x, y, size in radians) and the bright craters Tycho (with
// rays), Copernicus, Kepler and Aristarchus. Flat distances across the disk keep this cheap.
const vec3 MARIA_D[24] = vec3[24](
  vec3(0.231, 0.545, 0.3709), vec3(-0.266, 0.469, 0.2182), vec3(-0.509, 0.148, 0.2618), vec3(-0.820, 0.292, 0.1745),
  vec3(-0.770, -0.139, 0.2400), vec3(-0.554, -0.259, 0.1200), vec3(0.273, -0.358, 0.2182), vec3(0.575, -0.407, 0.1309),
  vec3(0.385, -0.174, 0.1309), vec3(-0.068, 0.225, 0.0873), vec3(0.191, 0.829, 0.1091), vec3(-0.000, 0.839, 0.1091),
  vec3(-0.191, 0.829, 0.1091), vec3(-0.369, 0.819, 0.0873), vec3(0.770, 0.342, 0.2618), vec3(0.816, 0.087, 0.2618),
  vec3(0.704, -0.087, 0.1963), vec3(0.612, 0.500, 0.1963), vec3(0.663, 0.643, 0.1745), vec3(0.511, 0.122, 0.1309),
  vec3(-0.017, 0.035, 0.0654), vec3(0.375, 0.707, 0.1091), vec3(-0.998, -0.035, 0.1309), vec3(-0.972, 0.225, 0.1091));
const vec2 TYCHO = vec2(0.141, -0.686), COPERNICUS = vec2(0.339, 0.167), KEPLER = vec2(0.610, 0.141), ARISTARCHUS = vec2(0.674, 0.402);
float moonAlbedo(vec2 xy){
  float a = 1.0;
  for (int i = ZERO; i < 24; i++){
    // irregular outlines that run into each other
    float d = length(xy - MARIA_D[i].xy) + 0.07 * (vnoise(xy * 10.0 + float(i) * 7.1) - 0.5);
    float r = MARIA_D[i].z;
    a -= 0.5 * (1.0 - smoothstep(r * 0.5, r * 1.15, d));
  }
  a = max(a, 0.38);
  // highland mottling and small craters (subtle)
  a *= 0.95 + 0.07 * vnoise(xy * 14.3) + 0.03 * vnoise(xy * 63.0);
  // bright young craters (distances in degrees of lunar arc); Tycho's rays reach across the southern half
  vec2 dv = (xy - TYCHO) * 57.3;
  float t = length(dv);
  a += 0.9 * (1.0 - smoothstep(0.8, 2.2, t));
  a += 0.25 * pow(max(0.0, sin(atan(dv.y, dv.x) * 9.0 + 1.3)), 24.0) * (1.0 - smoothstep(10.0, 60.0, t));
  a += 0.6 * (1.0 - smoothstep(0.7, 2.0, length(xy - COPERNICUS) * 57.3));
  a += 0.4 * (1.0 - smoothstep(0.4, 1.2, length(xy - KEPLER) * 57.3));
  a += 0.9 * (1.0 - smoothstep(0.3, 0.9, length(xy - ARISTARCHUS) * 57.3));
  return a;
}
vec3 moonDisk(vec3 rd, float ang){
#ifdef NO_SKYDETAIL
  return vec3(0.0);
#else
  float R = 0.0045 * uMoonSize;                     // the real moon is 0.26 degrees in radius
  float cd = dot(rd, uMoonDir);
  if (cd < cos(R + 3.0 * ang + 0.002)) return vec3(0.0);
  vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0) + vec3(1e-4, 0.0, 0.0)));   // points left
  vec3 t2 = cross(t1, uMoonDir);                                                     // points up
  vec3 q = rd - uMoonDir * cd;
  vec2 xy = vec2(dot(q, t1), dot(q, t2)) / R;
  float rr = length(xy);
  float edge = 1.0 - smoothstep(1.0 - max(ang / R, 0.02), 1.0 + max(ang / R, 0.02), rr);
  float z = sqrt(max(1.0 - rr*rr, 0.0));
  vec3 nrm = xy.x * t1 + xy.y * t2 - z * uMoonDir;
  // sunlight from the phase dial, all the way round: new (from behind the moon) -> lit from the right while
  // waxing -> full (from behind you) -> lit from the left while waning -> new (as seen from the north)
  vec3 Ld = -cos(uMoonPhase) * uMoonDir - sin(uMoonPhase) * t1;
  // the moon's dusty surface looks almost flat out to its edge (Lommel-Seeliger), not like a matte ball
  float mu0 = max(dot(nrm, Ld), 0.0), mu = max(z, 1e-3);
  float lit = 2.0 * mu0 / (mu0 + mu);
  // Earthshine: the dark part is lit only by light reflected from the Earth, a few thousand times dimmer
  // than sunlight on the moon (kept at ~1/900 here so it is just findable at night, never in daylight).
  float earthshine = 0.0015 * (1.0 - cos(uMoonPhase)) * 0.5;   // the dark part, faintly lit by the Earth (strongest near new moon)
  // shown ~1/1500 of its real brightness: the part of the retina looking at the moon adapts to it on its own,
  // so its dark plains stay visible (the moonlight falling on the city is computed separately)
  return vec3(1.0, 0.97, 0.92) * moonAlbedo(xy) * (lit * 0.65 + earthshine) * edge * 6.5e-4;
#endif
}
float cloudNoise(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0 + ZERO; i < 4; i++){ s += a * vnoise(p + float(i) * 13.7); p *= 2.03; a *= 0.5; }
  return s / 0.9375;
}
// The sky's broad brightness and colour in a direction, without sun disk, moon, stars or clouds.
// Rough surfaces reflect this blurred version.
vec3 skyBase(vec3 rd){
  float y = clamp(rd.y, 0.0, 1.0);
  vec3 day = mix(vec3(0.62, 0.72, 0.84), vec3(0.20, 0.36, 0.66), pow(y, 0.45));
  day = mix(day, vec3(0.64, 0.66, 0.69), 0.85 * uCloudGrey);
  float toward = dot(normalize(uSunDir.xz + 1e-5), normalize(rd.xz + 1e-5)) * 0.5 + 0.5;
  vec3 twi = mix(vec3(0.38, 0.45, 0.80), vec3(1.6, 0.78, 0.36), pow(toward, 3.0) * exp(-y * 6.0));
  return mix(day, day * twi, uTwi) * uSkyK + vec3(0.45, 0.55, 0.85) * mix(1.0, 0.6, y) * uNightSky;
}
bool gNoStars = false;   // set while computing reflections: stars in a window are faint pinpoints, left out
// ang = receptor footprint (radians) for stars, the sun and the moon edge
vec3 skyCol(vec3 rd, float sunVis, float ang){
  float y = clamp(rd.y, 0.0, 1.0);
  vec3 day = mix(vec3(0.62, 0.72, 0.84), vec3(0.20, 0.36, 0.66), pow(y, 0.45));
  day = mix(day, vec3(0.64, 0.66, 0.69), 0.85 * uCloudGrey);
  // sunset / twilight: warm low sky toward the sun, deeper blue away from it and overhead
  float toward = dot(normalize(uSunDir.xz + 1e-5), normalize(rd.xz + 1e-5)) * 0.5 + 0.5;
  vec3 twi = mix(vec3(0.38, 0.45, 0.80), vec3(1.6, 0.78, 0.36), pow(toward, 3.0) * exp(-y * 6.0));
  day = mix(day, day * twi, uTwi);
  vec3 c = day * uSkyK;
  float s = max(dot(rd, uSunDir), 0.0);
  c += uSunColor * pow(s, 8.0) * 0.18 * uSkyK * (1.0 + 2.0 * uTwi);
  c += uSunColor * pow(s, 900.0) * 30.0 * sunVis * uSunDiskK;               // bright haze around the sun
  {
    float rs = 0.00465, re = max(rs, 0.8 * ang);                        // sun radius, and the area it is spread over (most of a cell)
    float a = acos(clamp(dot(rd, uSunDir), -1.0, 1.0));
    c += uSunColor * 2.6e5 * (rs * rs) / (re * re) * (1.0 - smoothstep(re * 0.8, re * 1.2, a)) * sunVis * uSunDiskK;
  }
  c += vec3(0.45, 0.55, 0.85) * mix(1.0, 0.6, y) * uNightSky;          // airglow and moonlit sky
  if (ang > 0.0 && rd.y > -0.02 && !gNoStars) c += stars(rd, ang, dot(c, vec3(0.2126, 0.7152, 0.0722)) * uAbsScale);
  c += moonDisk(rd, max(ang, 2e-4)) * uMoonDisk;
#ifdef NO_SKYDETAIL
  if (false){
#else
  if (uCloud > 0.001 && rd.y > 0.005){
#endif
    float tc = (1800.0 - uCamPos.y) / rd.y;
    if (tc > 0.0){
      vec2 P = (uCamPos.xz + rd.xz * tc + uCloudOff) / 1400.0;
      // the cloud here, and a little toward the sun for its shading, from one call site
      float n = 0.0, n2 = 0.0;
      for (int k = ZERO; k < 2; k++){
        float v = cloudNoise(P + float(k) * uSunDir.xz / max(uSunDir.y + 0.15, 0.1) * 0.08);
        if (k == 0) n = v; else n2 = v;
      }
      float th = 1.0 - uCloud * 1.05;
      float dens = smoothstep(th - 0.05, th + 0.22, n);
      if (dens > 0.0){
        float shade = clamp(1.0 - (n2 - n) * 3.0, 0.35, 1.0);
        vec3 cc = uSunColor * uSunK * 0.45 * shade + vec3(0.78, 0.80, 0.86) * (uSkyK * 0.85 + uNightSky * 1.5)
                + uKeyCol * 0.15 * shade * step(uSunK, 0.001);
        float fade = exp(-tc / 14000.0);
        c = mix(c, cc, dens * fade);
      }
    }
  }
  if (rd.y < 0.0) c = mix(c, c * 0.25, smoothstep(0.0, 0.15, -rd.y));
  return c;
}

/* ---- materials: every line below is a detail layer with a real-world size ----
   f is the receptor footprint on the surface per axis (x along uv.x, y along uv.y).
   A surface seen at a slant is squeezed in one direction only. */
struct Surf { vec3 alb; float h; float glass; float refl; vec3 interior; vec2 tilt; float emit; };
Surf blank(){ Surf s; s.alb = vec3(0.5); s.h = 0.0; s.glass = 0.0; s.refl = 0.05; s.interior = vec3(0.0); s.tilt = vec2(0.0); s.emit = 0.0; return s; }
// set by doorSurf when the point is on a wall beside a door: the door's centre along the wall (world
// metres, same axis as uv.x) and half width. Ground-floor windows that would overlap it are left out.
float gDoorU = 1e9, gDoorHW = 0.0;
// street-light pole (painted metal) and head (dark housing; the downward face is the lens)
Surf lampSurf(float mat, vec3 n, vec2 uv, vec2 f){
  Surf s = blank();
  s.alb = vec3(0.13, 0.135, 0.14) * (1.0 + 0.15 * fbmG(uv, 0.05, 0.002, max(f.x, f.y)));
  s.refl = 0.12;
  if (mat > 7.5){ s.alb = vec3(0.08); if (n.y < -0.7){ s.alb = vec3(0.55, 0.55, 0.5); s.emit = 1.0; } }
  return s;
}


Surf brickWall(vec2 uv, float v, vec2 f, Bld b){
  Surf s = blank();
  float fe = sqrt(f.x*f.y), fn = max(f.x, f.y);
  vec3 pal0 = vec3(0.36, 0.11, 0.07), pal1 = vec3(0.30, 0.16, 0.10), pal2 = vec3(0.50, 0.36, 0.24), pal3 = vec3(0.22, 0.12, 0.09);
  int pi = int(b.var * 3.999);
  vec3 base = pi == 0 ? pal0 : (pi == 1 ? pal1 : (pi == 2 ? pal2 : pal3));
  vec3 mortar = vec3(0.50, 0.48, 0.44);
  float row = floor(v / 0.075);
  float bx = uv.x + 0.1125 * mod(row, 2.0);
  float mh = pulseF(v, 0.075, 0.01, f.y), mv = pulseF(bx, 0.225, 0.01, f.x);
  float mc = 1.0 - (1.0 - mh)*(1.0 - mv);
  float wB = gate(0.065, fe);                             // individual bricks: 6.5 cm
  float bv = hf(h2(ivec2(int(floor(bx / 0.225)), int(row)), uSeed + 77u));
  vec3 bc = base * mix(1.0, 0.7 + 0.6*bv, wB);
  bc *= 1.0 + 0.30 * fbmG(uv, 0.025, 0.0002, fn);         // fired-clay mottle, down to the receptor
  vec2 sand = grainLayer(uv, 0.0009, 41u, fe);            // sand grains in the clay: ~1 mm
  bc *= 1.0 + 0.22*sand.x - 0.10*sand.y;
  float pit = pits(uv, 0.012, 0.0004, 0.0013, 0.35, 43u, f);  // chips and pits
  bc = mix(bc, bc*0.45, pit);
  vec2 msand = gHOnly ? vec2(0.0) : grainLayer(uv, 0.0006, 47u, fe);   // mortar is coarse sand and lime
  vec3 mort = mortar * (1.0 + 0.25*msand.x - 0.12*msand.y);
  vec3 wall = mix(bc, mort, mc);
  wall *= 1.0 + 0.18 * fbmG(uv * vec2(1.0, 0.35), 3.0, 0.5, fn); // weathering
  float off = b.var * 7.0;
  float win = pulseF(uv.x + off, 3.0, 1.2, f.x) * pulseF(v - 0.9, 3.2, 1.8, f.y);
  float gy = pulseF(v - 0.96, 3.2, 1.68, f.y);
  float gl = pulseF(uv.x + off - 0.06, 3.0, 1.08, f.x) * gy;
  gl = max(gl - pulseF(uv.x + off - 0.57, 3.0, 0.06, f.x) * gy, 0.0);
  if (v < 3.2 && abs(floor((uv.x + off) / 3.0) * 3.0 - off + 0.6 - gDoorU) < gDoorHW + 0.9){ win = 0.0; gl = 0.0; }
  float fr = max(win - gl, 0.0);
  s.alb = mix(wall, vec3(0.70, 0.69, 0.65), fr);
  s.glass = gl; s.refl = 0.05;
  float wid = hf(h2(ivec2(int(floor((uv.x + off)/3.0)), int(floor((v - 0.9)/3.2))), uSeed + 99u));
  float wI = gate(1.2, fe);
  vec3 room = wid > 0.78 ? vec3(0.30, 0.27, 0.22) : vec3(0.02, 0.02, 0.025) * (0.6 + wid);
  s.interior = mix(vec3(0.075, 0.07, 0.06), room, wI);
  s.h = (-0.008*mc - 0.0008*pit - 0.0002*sand.y)*(1.0 - win) - 0.05*fr - 0.12*gl;
  return s;
}

Surf concreteWall(vec2 uv, float v, vec2 f, Bld b){
  Surf s = blank();
  float fe = sqrt(f.x*f.y), fn = max(f.x, f.y);
  vec3 base = mix(vec3(0.50, 0.49, 0.46), vec3(0.60, 0.56, 0.48), b.var);
  float jc = 1.0 - (1.0 - pulseF(v, 3.2, 0.02, f.y)) * (1.0 - pulseF(uv.x, 2.4, 0.02, f.x));
  vec2 cq = mod(vec2(uv.x, v), 0.6) - 0.3;                // form-tie holes: 2.6 cm
  float hole = dotF(cq, 0.013, 0.6, f) * (1.0 - pulseF(v - 1.0, 3.2, 1.5, f.y));   // none on the windows
  vec2 agg = stoneLayer(uv, 0.008, 0.55, 51u, fe);        // rounded aggregate stones: ~5 mm
  vec2 snd = gHOnly ? vec2(0.0) : grainLayer(uv, 0.0012, 53u, fe);   // sand in the cement paste
  base *= mix(1.0, 0.92 + 0.5*agg.x + 0.08, agg.y);       // stones: slightly different, varied tones
  base *= 1.0 + 0.10*snd.x;
  base *= 1.0 + 0.06 * fbmG(uv, 0.004, 0.0002, fn);       // paste texture, down to the receptor
  base *= 1.0 + 0.15 * fbmG(uv, 1.5, 0.3, fn);            // mottling
  float voids = pits(uv, 0.02, 0.0005, 0.0018, 0.4, 57u, f);  // air voids: 1-4 mm
  float st = vnoise(vec2(uv.x*1.5, v*0.08));              // rain streaks
  float wS = gate(0.4, f.x);
  base *= mix(0.95, mix(1.0, 0.72, smoothstep(0.55, 0.9, st)), wS);
  vec3 wall = mix(base, base*0.55, jc);
  wall = mix(wall, base*0.30, voids);
  wall = mix(wall, base*0.18, hole);
  float wy = pulseF(v - 1.0, 3.2, 1.5, f.y);
  if (v < 3.2 && abs((floor(uv.x / 1.6) + 0.53) * 1.6 - gDoorU) < gDoorHW + 0.85) wy = 0.0;
  float mul = pulseF(uv.x, 1.6, 0.1, f.x);
  float gl = wy * (1.0 - mul), fr = wy * mul;
  s.alb = mix(wall, vec3(0.08, 0.085, 0.09), fr);
  s.glass = gl; s.refl = 0.06;
  float wid = hf(h2(ivec2(int(floor(uv.x/1.6)), int(floor((v - 1.0)/3.2))), uSeed + 31u));
  float wI = gate(1.5, fe);
  s.interior = mix(vec3(0.05), vec3(0.03, 0.032, 0.035) * (0.5 + wid) + vec3(0.08, 0.075, 0.06)*step(0.85, wid), wI);
  s.h = -0.01*jc - 0.012*hole - 0.0015*voids*(1.0 - wy) - 0.2*gl - 0.15*fr;
  return s;
}

Surf glassWall(vec2 uv, float v, vec2 f, Bld b){
  Surf s = blank();
  float fe = sqrt(f.x*f.y);
  int pi = int(b.var * 2.999);
  vec3 tint = pi == 0 ? vec3(0.05, 0.09, 0.10) : (pi == 1 ? vec3(0.09, 0.07, 0.05) : vec3(0.06, 0.065, 0.075));
  float mull = 1.0 - (1.0 - pulseF(uv.x, 1.5, 0.07, f.x)) * (1.0 - pulseF(v, 3.2, 0.1, f.y));
  float spand = pulseF(v - 0.1, 3.2, 0.85, f.y);
  float gl = 1.0 - mull;
  s.alb = vec3(0.30, 0.32, 0.34);
  s.glass = gl; s.refl = 0.22;
  // A daytime office seen through tinted glass is roughly a tenth as bright as what the glass reflects
  // (interior ~100-300 cd/m2 at 30-50% transmission vs sunlit facades at 5,000-10,000 cd/m2 x ~20%).
  vec3 office = tint*0.25;
  s.interior = mix(office, tint*0.15, spand);
  float wP = gate(1.5, fe);                               // per-pane warp
  uint pid = h2(ivec2(int(floor(uv.x/1.5)), int(floor(v/3.2))), uSeed + 5u);
  s.tilt = (vec2(rnd(pid, 1u), rnd(pid, 2u)) - 0.5) * 0.035 * wP;
  s.h = 0.08 * mull;
  return s;
}

Surf stonePodium(vec2 uv, float v, vec2 f, Bld b){
  Surf s = blank();
  float fe = sqrt(f.x*f.y), fn = max(f.x, f.y);
  float row = floor(v / 0.6);
  float jx = uv.x + 0.6*mod(row, 2.0);
  float jc = 1.0 - (1.0 - pulseF(v, 0.6, 0.006, f.y)) * (1.0 - pulseF(jx, 1.2, 0.006, f.x));
  float wS = gate(0.6, fe);                               // per-slab colour
  float sv = hf(h2(ivec2(int(floor(jx/1.2)), int(row)), uSeed + 13u));
  vec3 stone = vec3(0.62, 0.58, 0.52) * mix(1.0, 0.85 + 0.3*sv, wS);
  vec2 gran = gHOnly ? vec2(0.0) : grainLayer(uv, 0.003, 61u, fe);   // granite crystals: ~3 mm
  stone *= 1.0 + 0.45*gran.x - 0.05*gran.y;
  stone *= 1.0 + 0.10 * fbmG(uv, 0.02, 0.0002, fn);
  vec3 wall = mix(stone, stone*0.6, jc);
  float wy = pulseF(v - 0.5, 100.0, 3.2, f.y);
  if (abs((floor(uv.x / 2.4) + 0.52) * 2.4 - gDoorU) < gDoorHW + 1.25) wy = 0.0;
  float mul = pulseF(uv.x, 2.4, 0.1, f.x);
  float gl = wy * (1.0 - mul), fr = wy * mul;
  s.alb = mix(wall, vec3(0.12, 0.12, 0.13), fr);
  s.glass = gl; s.refl = 0.08;
  s.interior = vec3(0.10, 0.09, 0.08);
  s.h = -0.004*jc - 0.1*gl;
  return s;
}

/* ---- doors ----
   Leaf coordinates: u across a leaf from its hinge edge, y up from the sill (metres). Every part is a box
   whose edges are softened over the receptor footprint, so handles and panel edges fade into an average
   colour at a distance instead of sparkling. */
float boxF(float x, float a, float b, float f){ float w = max(f, 1e-4); return clamp((x - a)/w + 0.5, 0.0, 1.0) * clamp((b - x)/w + 0.5, 0.0, 1.0); }
float rectF(vec2 q, vec4 r, vec2 f){ return boxF(q.x, r.x, r.z, f.x) * boxF(q.y, r.y, r.w, f.y); }
float knobF(vec2 d, float rad, vec2 f){ float w = max(max(f.x, f.y), 1e-4); return clamp((rad - length(d))/w + 0.5, 0.0, 1.0) * min(1.0, 4.0*rad*rad/(w*w)); }
// paint / stain / frame colours, by type x 4 + colour: wood (walnut, oak, red, green), glass-door frames
// (aluminium, black, bronze, grey), steel (grey, green, maroon, navy)
const vec3 DOOR_PAINT[12] = vec3[12](
  vec3(0.16, 0.09, 0.05), vec3(0.36, 0.22, 0.11), vec3(0.42, 0.07, 0.05), vec3(0.07, 0.20, 0.13),
  vec3(0.62, 0.63, 0.64), vec3(0.05, 0.05, 0.055), vec3(0.20, 0.13, 0.07), vec3(0.40, 0.40, 0.42),
  vec3(0.32, 0.33, 0.34), vec3(0.09, 0.19, 0.13), vec3(0.25, 0.07, 0.06), vec3(0.09, 0.11, 0.16));
vec3 doorPaint(int type, int col){ return DOOR_PAINT[type * 4 + col]; }
// raised panels: the panel field is sunk 1 cm with a 4 cm bevel
float panelH(vec2 q, vec4 r, vec2 f){ return -0.010 * rectF(q, r, f) + 0.006 * rectF(q, r + vec4(0.04, 0.04, -0.04, -0.04), f); }
/* Door designs as data, one entry per type x 4 + variety:
   wood: 4-panel, 6-panel, boards, half-glazed · glass: frameless, narrow aluminium, heavy frame with a mid
   rail, kick plate · steel: flush with a kick plate, wired-glass window, ribbed, louvre vent.
   One short piece of code reads them, with no branch per design: the Direct3D shader compiler (used by
   browsers on Windows) took tens of seconds over the earlier version with a branch for each. "None" is a
   range above the door (5 m). */
const vec2 D_ROW0[12] = vec2[12](vec2(0.22, 0.95), vec2(0.20, 0.80), vec2(5.0), vec2(0.20, 0.90), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0));
const vec2 D_ROW1[12] = vec2[12](vec2(1.12, 2.08), vec2(0.96, 1.56), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0));
const vec2 D_ROW2[12] = vec2[12](vec2(5.0), vec2(1.70, 2.08), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0), vec2(5.0));
// glass pane: x0 = a0 x leaf width + b0, x1 = a1 x leaf width + b1 (D_GX = a0, b0, a1, b1); heights D_GY
const vec4 D_GX[12] = vec4[12](vec4(0.0), vec4(0.0), vec4(0.0), vec4(0.0, 0.11, 1.0, -0.11),
  vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0, 0.055, 1.0, -0.055), vec4(0.0, 0.10, 1.0, -0.10), vec4(0.0, 0.07, 1.0, -0.07),
  vec4(0.0), vec4(0.5, -0.13, 0.5, 0.13), vec4(0.0), vec4(0.0));
const vec2 D_GY[12] = vec2[12](vec2(5.0), vec2(5.0), vec2(5.0), vec2(1.05, 2.08), vec2(0.0, 2.2), vec2(0.25, 2.14), vec2(0.15, 2.10), vec2(0.32, 2.14),
  vec2(5.0), vec2(1.30, 1.90), vec2(5.0), vec2(5.0));
// D_FLAGS: x = split panels into two columns, y = cross bar on the pane, z = mid rail on the glass, w = patch fittings
const vec4 D_FLAGS[12] = vec4[12](vec4(1, 0, 0, 0), vec4(1, 0, 0, 0), vec4(0), vec4(0, 1, 0, 0), vec4(0, 0, 0, 1), vec4(0), vec4(0, 0, 1, 0), vec4(0), vec4(0), vec4(0), vec4(0), vec4(0));
// D_SURF: x = board grooves, y = wired glass, z = ribs, w = louvre vent
const vec4 D_SURF[12] = vec4[12](vec4(0), vec4(0), vec4(1, 0, 0, 0), vec4(0), vec4(0), vec4(0), vec4(0), vec4(0), vec4(0), vec4(0, 1, 0, 0), vec4(0, 0, 1, 0), vec4(0, 0, 0, 1));
// D_KICK: kick plate height and how metallic; D_HANDLE: 0 knob, 1 lever on a rose, 2 vertical pull bar, 3 push bar
const vec2 D_KICK[12] = vec2[12](vec2(0.0), vec2(0.0), vec2(0.0), vec2(0.0), vec2(0.0), vec2(0.0), vec2(0.0), vec2(0.32, 0.6), vec2(0.25, 0.7), vec2(0.0), vec2(0.0), vec2(0.0));
const int D_HANDLE[12] = int[12](0, 0, 0, 0, 2, 3, 2, 3, 1, 1, 1, 1);
const vec3 D_METAL[3] = vec3[3](vec3(0.55, 0.42, 0.17), vec3(0.70, 0.70, 0.68), vec3(0.55, 0.55, 0.54));
Surf doorLeaf(int code, float a, float y, vec2 f, vec3 wp){
  int type = code >> 6, vr = (code >> 4) & 3, col = (code >> 2) & 3, d = type * 4 + vr;
  bool dbl = (code & 2) != 0, tr = (code & 1) != 0;
  float Wl = dbl ? 1.8 : 0.95, hw = 0.5*Wl, lw = dbl ? hw : Wl;
  float u = dbl ? hw - abs(a) : a + hw;               // single: hinge on the left; double: hinges outside
  vec2 q = vec2(u, y);
  float fn = max(f.x, f.y);
  float isWood = type == 0 ? 1.0 : 0.0, isGlass = type == 1 ? 1.0 : 0.0, isSteel = type == 2 ? 1.0 : 0.0;
  vec3 paint = DOOR_PAINT[type * 4 + col];
  Surf s = blank();
  // frame around the leaves and the transom, standing 1.2 cm proud
  s.alb = paint * mix(0.8, 1.0, isGlass); s.h = 0.012; s.refl = mix(0.06, 0.25, isGlass);
  float leaf = boxF(a, -hw, hw, f.x) * boxF(y, 0.0, 2.2, f.y);
  float trn = tr ? boxF(a, -hw, hw, f.x) * boxF(y, 2.26, 2.72, f.y) : 0.0;
  vec4 fl = D_FLAGS[d], sf = D_SURF[d];
  // paint or wood grain (along the boards for wood), and wear near the bottom of steel doors
  vec3 c = paint;
  c *= 1.0 + mix(0.05 * isSteel, 0.22, isWood) * fbmG(isWood > 0.5 ? vec2(u, y * 0.12) : q, isWood > 0.5 ? 0.05 : 0.3, isWood > 0.5 ? 0.0008 : 0.002, fn);
  c *= 1.0 - 0.12 * isSteel * boxF(y, 0.0, 0.3, f.y) * smoothstep(0.35, 0.85, vnoise(vec2(u + wp.x + wp.z, y) * 4.0)) * gate(0.2, fn);
  float hh = 0.0;
  // raised panels: up to three rows, in one or two columns
  float x0 = 0.11, x1 = lw - 0.11, xm = 0.5*lw;
  bool two = fl.x > 0.5 && lw > 0.6;
  vec2 c0 = two ? vec2(x0, xm - 0.05) : vec2(x0, x1), c1 = two ? vec2(xm + 0.05, x1) : vec2(5.0);
  for (int r = ZERO; r < 3; r++){
    vec2 ry = r == 0 ? D_ROW0[d] : (r == 1 ? D_ROW1[d] : D_ROW2[d]);
    hh += panelH(q, vec4(c0.x, ry.x, c0.y, ry.y), f) + panelH(q, vec4(c1.x, ry.x, c1.y, ry.y), f);
  }
  // boards with V-grooves, each a slightly different tone; ribs; louvre vent
  hh -= 0.006 * sf.x * pulseF(u, 0.14, 0.012, f.x);
  c *= 1.0 + sf.x * 0.12 * (hf(h2(ivec2(int(floor((u + wp.x + wp.z) / 0.14)), code), uSeed + 211u)) - 0.5) * gate(0.14, f.x);
  hh += 0.006 * sf.z * pulseF(y, 0.10, 0.05, f.y) * boxF(y, 0.1, 2.1, f.y);
  float lv = sf.w * rectF(q, vec4(0.15, 0.12, lw - 0.15, 0.50), f);
  c = mix(c, c * 0.25, lv * pulseF(y, 0.04, 0.02, f.y)); hh -= 0.004 * lv;
  // the glass pane, less what crosses it: a cross bar, a mid rail, patch fittings, wire mesh
  vec4 gx = D_GX[d]; vec2 gy = D_GY[d];
  float pane = rectF(q, vec4(gx.x * lw + gx.y, gy.x, gx.z * lw + gx.w, gy.y), f);
  float bar = fl.y * max(boxF(u, xm - 0.02, xm + 0.02, f.x), boxF(y, 1.545, 1.585, f.y));
  float rail = fl.z * boxF(y, 0.95, 1.07, f.y);
  float fit = fl.w * (rectF(q, vec4(0.0, 0.0, 0.26, 0.11), f) + rectF(q, vec4(0.0, 2.09, 0.26, 2.2), f));
  float wire = sf.y * 0.6 * max(pulseF(u, 0.025, 0.0015, f.x), pulseF(y, 0.025, 0.0015, f.y));
  float gl = pane * (1.0 - bar) * (1.0 - rail) * (1.0 - fit) * (1.0 - wire);
  hh -= 0.004 * sf.y * rectF(q, vec4(0.5*lw - 0.16, 1.27, 0.5*lw + 0.16, 1.93), f) * (1.0 - pane);   // the small window's recessed frame
  // metal parts: fittings, a kick plate, and the handle
  vec2 kick = D_KICK[d];
  float kp = kick.y * rectF(q, vec4(0.0, 0.0, lw, kick.x), f);
  int ht = D_HANDLE[d];
  float knob = knobF(q - vec2(lw - 0.07, 0.98), ht == 0 ? 0.028 : 0.03, f);
  float lever = max(rectF(q, vec4(lw - 0.18, 0.965, lw - 0.06, 0.995), f), knob);
  float pull = rectF(q, vec4(lw - 0.13, 0.80, lw - 0.10, 1.50), f);
  float push = rectF(q, vec4(0.08, 0.96, lw - 0.08, 1.02), f);
  float handle = ht == 0 ? knob : (ht == 1 ? lever : (ht == 2 ? pull : push));
  float met = max(max(fit, kp), handle);
  // the gap between the leaves of a double door
  if (dbl) c = mix(c, c * 0.15, boxF(a, -0.004, 0.004, f.x));
  c = mix(c, D_METAL[type], met);
  s.alb = mix(s.alb, c, leaf);
  s.h = mix(s.h, hh + 0.004 * met, leaf);
  s.refl = mix(s.refl, mix(mix(0.05, 0.10, isSteel), 0.45, met), leaf);
  s.glass = clamp(gl * leaf + trn * boxF(y, 2.30, 2.68, f.y) * boxF(a, -hw + 0.04, hw - 0.04, f.x), 0.0, 1.0);
  s.interior = vec3(0.10, 0.085, 0.065);        // a dim hallway or lobby behind the glass
  return s;
}
// Which door surface (if any) p is on. Also sets gDoorU when p is on a wall right beside a door.
bool doorSurf(Bld b, vec3 p, vec3 n, vec2 f, out Surf s){
#ifdef NO_DOORS
  s = blank(); return false;
#else
  s = blank();
  if (b.door < 0) return false;
  vec2 v = vec2(-b.u.y, b.u.x);                       // away from the road (the front faces -v)
  vec2 q = p.xz - b.c;
  float lx = dot(q, b.u), lz = dot(q, v);
  float y = p.y - 0.15;
  float Wn, Hn; doorDims(b.door, Wn, Hn);
  float dpt = lz + b.hs.y;                            // depth into the front wall
  float a = -(lx - b.doorOff);                        // + = to the right, seen from the street
  float hw = 0.5 * Wn;
  if (abs(a) > hw + 1.6 || y > Hn + 0.5 || dpt > 0.3 || dpt < -0.05) return false;
  gDoorU = dot(b.c, b.u) + b.doorOff; gDoorHW = hw;   // in the wall's u (along b.u on the front face)
  vec2 out2 = -v;
  if (!(dpt < 0.02 || (abs(a) <= hw + 0.02 && y <= Hn + 0.02))) return false;
  vec3 trim = b.kind > 1.5 ? vec3(0.06, 0.06, 0.065) : vec3(0.56, 0.54, 0.50);   // stone surround; dark metal on podiums
  if (dpt < 0.02){
    // on the wall: a 10 cm surround around the opening
    if (abs(a) < hw + 0.1 && y < Hn + 0.1 && dot(n.xz, out2) > 0.7){
      s.alb = trim * (1.0 + 0.08 * fbmG(vec2(lx, p.y), 0.05, 0.002, max(f.x, f.y))); return true;
    }
    return false;
  }
  if (dpt > 0.22 && dot(n.xz, out2) > 0.7){ s = doorLeaf(b.door, a, y, f, p); return true; }
  // inside the opening: the step, and the reveals around it
  if (n.y > 0.7){ s.alb = vec3(0.46, 0.45, 0.43); return true; }
  s.alb = (b.door >> 6) == 1 ? doorPaint(1, (b.door >> 2) & 3) : trim * 0.85; s.refl = 0.06; return true;
#endif
}

Surf roof(vec2 uv, vec2 f){
  Surf s = blank();
  float fn = max(f.x, f.y);
  vec2 grav = grainLayer(uv, 0.012, 71u, sqrt(f.x*f.y));   // gravel stones: ~1.2 cm
  s.alb = vec3(0.33, 0.32, 0.30) * (1.0 + 0.5*grav.x - 0.35*grav.y) * (1.0 + 0.2*fbmG(uv, 2.0, 0.4, fn));
  s.alb *= 1.0 + 0.1*fbmG(uv, 0.004, 0.0002, fn);
  s.h = -0.004*grav.y;
  return s;
}

Surf sidewalk(vec2 uv, vec2 f){
  Surf s = blank();
  float fe = sqrt(f.x*f.y), fn = max(f.x, f.y);
  float jc = 1.0 - (1.0 - pulseF(uv.x, 1.0, 0.008, f.x)) * (1.0 - pulseF(uv.y, 1.0, 0.008, f.y));
  float wP = gate(1.0, fe);
  float pv = hf(h2(ivec2(floor(uv)), uSeed + 21u));
  vec3 c = vec3(0.45, 0.44, 0.42) * mix(1.0, 0.9 + 0.2*pv, wP);
  vec2 agg = grainLayer(uv, 0.005, 81u, fe);              // exposed aggregate
  c *= 1.0 + 0.18*agg.x - 0.06*agg.y;
  c *= 1.0 + 0.08*fbmG(uv, 0.003, 0.0002, fn);
  c *= 1.0 + 0.15*fbmG(uv, 1.5, 0.3, fn);
  float vd = pits(uv, 0.018, 0.0005, 0.0015, 0.3, 83u, f);
  c = mix(c, c*0.4, vd);
  s.alb = mix(c, c*0.55, jc);
  s.h = -0.004*jc - 0.001*vd - 0.0003*agg.y;
  return s;
}

Surf plaza(vec2 uv, vec2 f){
  Surf s = blank();
  float fe = sqrt(f.x*f.y), fn = max(f.x, f.y);
  float jc = 1.0 - (1.0 - pulseF(uv.x, 0.5, 0.004, f.x)) * (1.0 - pulseF(uv.y, 0.5, 0.004, f.y));
  float wC = gate(0.5, fe);                               // two-tone checker pavers
  float ch = mod(floor(uv.x/0.5) + floor(uv.y/0.5), 2.0);
  vec3 c = mix(vec3(0.46, 0.40, 0.34), mix(vec3(0.58, 0.52, 0.44), vec3(0.34, 0.28, 0.24), ch), wC);
  vec2 pg = gHOnly ? vec2(0.0) : grainLayer(uv, 0.002, 91u, fe);     // fine stone grain
  c *= 1.0 + 0.20*pg.x;
  c *= 1.0 + 0.08*fbmG(uv, 0.015, 0.0002, fn);
  s.alb = mix(c, c*0.6, jc);
  s.h = -0.003*jc;
  return s;
}

// The footprint (given along world x and z) measured along a unit direction d
float fpAlong(vec2 f, vec2 d){ return length(f * d); }
// fr: the road frame at this point (see roadAt); dir: the road's direction
Surf road(vec2 uv, vec4 fr, vec2 dir, vec2 f){
  Surf s = blank();
  float fn = max(f.x, f.y);
  vec3 c = vec3(0.045, 0.045, 0.048);
  float fe = sqrt(f.x*f.y);
  vec2 stones = grainLayer(uv, 0.008, 101u, fe);          // stones in dark binder: ~8 mm
  c *= 1.0 + 0.55*max(stones.x, 0.0) - 0.4*stones.y;
  c *= 1.0 + 0.15*fbmG(uv, 0.004, 0.0002, fn);
  c *= 1.0 + 0.25*fbmG(uv, 6.0, 1.0, fn);                 // patch repairs
  float vd = pits(uv, 0.02, 0.001, 0.003, 0.45, 103u, f); // voids between stones
  c = mix(c, c*0.35, vd);
  float paint = 0.0;
  if (fr.z > 0.0){                                        // not inside a crossing
    float fa = fpAlong(f, dir), fc = fpAlong(f, vec2(-dir.y, dir.x));
    float sA = fr.x, ac = fr.y, hw = fr.z, L = mod(fr.w, 1000.0);
    bool major = fr.w >= 1000.0;
    float e = min(sA, L - sA);                            // distance from the nearer end (a crossing)
    if (e > 7.5 && e < 10.5) paint = pulseF(ac + 0.25, 1.0, 0.5, fc);                // zebra crossing
    else if (e >= 10.5){
      if (major){
        paint = max(boxF(ac, 0.08, 0.20, fc), boxF(ac, -0.20, -0.08, fc));            // double centre line
        paint = max(paint, (boxF(abs(ac), 0.5*hw - 0.06, 0.5*hw + 0.06, fc)) * pulseF(sA, 9.0, 3.0, fa));   // lane lines
      } else paint = boxF(ac, -0.06, 0.06, fc) * pulseF(sA, 9.0, 3.0, fa);             // dashed centre line
    }
  }
  s.alb = mix(c, vec3(0.62, 0.60, 0.52), paint);
  s.h = -0.002*vd - 0.0008*stones.y;
  s.refl = 0.012;
  return s;
}

// open water: dark, reflecting, with a little ripple
Surf water(vec2 uv, vec2 f){
  Surf s = blank();
  s.alb = vec3(0.02, 0.04, 0.05); s.glass = 1.0; s.refl = 0.02;
  s.interior = vec3(0.015, 0.045, 0.05);
  float wR = gate(1.5, sqrt(f.x*f.y));
  s.tilt = vec2(vnoise(uv * 0.35) - 0.5, vnoise(uv.yx * 0.35 + 17.0) - 0.5) * 0.06 * wR;
  return s;
}

Surf surfAt(float mat, vec3 p, vec3 n, vec2 uv, vec2 f){
#ifdef NO_MATERIALS
  return blank();
#else
  float m = matId(mat);
  bool top = n.y > 0.7;
  if (m < 1.5){
    // road or sidewalk: patterns follow the road
    vec2 g; vec4 fr;
    roadAt(p.xz - n.xz * 0.05, g, fr);
    vec2 dir = vec2(-g.y, g.x);
    if (m < 0.5) return road(uv, fr, dir, f);
    if (top) return sidewalk(vec2(fr.x, fr.y), vec2(fpAlong(f, dir), fpAlong(f, g)));
    return roof(uv * vec2(1.0, 3.0), f);                 // a curb face
  }
  if (m > 8.5) return water(uv, f);
  if (m > 6.5) return lampSurf(m, n, uv, f);
  if (m > 5.5){ if (top) return plaza(uv, f); return roof(uv * vec2(1.0, 3.0), f); }
  Bld b = getBld(bldOf(mat));
  gDoorU = 1e9;
  if (p.y < 3.6 && (m > 4.5 || b.kind < 1.5)){ Surf ds; if (doorSurf(b, p, n, f, ds)) return ds; }
  if (top) return roof(uv, f);
  if (m > 4.5) return stonePodium(uv, p.y, f, b);
  if (b.kind < 0.5) return brickWall(uv, p.y, f, b);
  if (b.kind < 1.5) return concreteWall(uv, p.y, f, b);
  return glassWall(uv, p.y - b.podH, f, b);
#endif
}

/* ---- reflections in glass: one bounce into the city ----
   The reflected ray is marched through the same scene. What it hits is shaded either simply (base colour of
   the material, a coarse window pattern, sun and sky light, optionally one shadow ray) or with the full
   materials. Glass seen inside a reflection shows only a dim blur of the sky (no second bounce). */
vec3 reflAlbedo(float mat, vec3 p, vec3 n, vec2 uv, vec2 f, out float glassy){
  glassy = 0.0;
  float m = matId(mat);
  if (m < 0.5) return vec3(0.05);                                     // road
  if (m < 1.5) return vec3(0.34, 0.33, 0.31);                         // sidewalk
  if (m > 8.5){ glassy = 0.9; return vec3(0.02, 0.04, 0.05); }        // water
  if (m > 7.5) return vec3(0.08);                                     // lamp head
  if (m > 6.5) return vec3(0.13);                                     // pole
  if (m > 5.5) return vec3(0.40, 0.38, 0.35);                         // paved lot
  if (n.y > 0.7) return vec3(0.32);                                   // roofs
  Bld b = getBld(bldOf(mat));
  float v = p.y;
  if (m > 4.5){                                                       // podium
    glassy = pulseF(v - 0.5, 100.0, 3.2, f.y) * (1.0 - pulseF(uv.x, 2.4, 0.1, f.x)) * 0.9;
    return vec3(0.60, 0.56, 0.50);
  }
  if (b.kind < 0.5){
    int pi = int(b.var * 3.999);
    vec3 base = pi == 0 ? vec3(0.36, 0.11, 0.07) : (pi == 1 ? vec3(0.30, 0.16, 0.10) : (pi == 2 ? vec3(0.50, 0.36, 0.24) : vec3(0.22, 0.12, 0.09)));
    float off = b.var * 7.0;
    glassy = pulseF(uv.x + off, 3.0, 1.2, f.x) * pulseF(v - 0.9, 3.2, 1.8, f.y) * 0.8;
    return base * 0.88 + 0.06;                                        // bricks and mortar, averaged
  }
  if (b.kind < 1.5){ glassy = pulseF(v - 1.0, 3.2, 1.5, f.y) * 0.9; return mix(vec3(0.50, 0.49, 0.46), vec3(0.60, 0.56, 0.48), b.var) * 0.85; }
  v -= b.podH;                                                        // glass curtain wall: mullions 1.5 m, floors 3.2 m
  glassy = 0.9 * (1.0 - pulseF(uv.x, 1.5, 0.07, f.x)) * (1.0 - pulseF(v, 3.2, 0.1, f.y));
  return vec3(0.31);
}
// ro: a point just off the glass; rd: reflected direction; cone: spread (radians) of what one cell sees
// after the bounce (receptor footprint plus the waviness of real glass); t0: distance already travelled.
vec3 reflScene(vec3 ro, vec3 rd, float cone, float t0, float sunVis, bool traced){
#ifdef NO_REFL
  return skyCol(rd, sunVis, max(cone, 0.015));
#else
  float gm = 0.0; vec3 gn = vec3(0.0, 1.0, 0.0);
  float tG = traced ? groundHit(ro, rd, gm, gn) : 1e9;
  float tMax = min(tG, uReflReach);
  int steps = uReflMode == 3 ? 220 : 110;
  float t = 0.05, tPrev = 0.05; vec2 h = vec2(1e9, -1.0); bool hit = false, reached = false, forced = false;
  for (int i = 0 + ZERO; i < 220; i++){
    if (i >= steps || !traced) break;
    vec3 q = ro + rd * t;
    if (q.y > 150.0 && rd.y > 0.0) break;
    h = map(q);
    if (h.x < 0.0015 * t + 0.01){ hit = true; break; }
    // coarser than the main rays (reflections are small and blurred): at least 0.4% of the distance per step
    float st = min(h.x, gBound);
    forced = st < 0.004 * t;
    tPrev = t;
    float j = rayJump(q, rd);
    if (j > max(st, 0.004 * t)){ forced = false; t += j; } else t += forced ? 0.004 * t : st;
    if (t > tMax){ reached = true; break; }
  }
  // a forced step may have gone into the wall: search back for its surface, so shading and the shadow
  // ray start on the outside (otherwise the shadow ray starts inside and marks the spot fully shaded)
  if (hit && forced){
    float lo = tPrev, hi = t;
    for (int j = 0 + ZERO; j < 8; j++){ float mid = 0.5 * (lo + hi); if (map(ro + rd * mid).x < 0.0015 * mid + 0.01) hi = mid; else lo = mid; }
    t = hi; h = map(ro + rd * t);
  }
  vec3 sky = skyCol(rd, sunVis, max(cone, 0.015));
  if (!hit && rd.y < 0.0) sky = mix(sky, vec3(0.10, 0.10, 0.11), 0.6);   // out of reach, below the horizon
  bool gHit = !hit && reached && tG <= uReflReach;
  if (!hit && !gHit) return sky;
  if (gHit) t = tG;
  vec3 p = ro + rd * t;
  vec3 n = gHit ? gn : calcN(p, t + t0);
  float mat = gHit ? gm : h.y;
  vec3 an = abs(n);
  vec2 uv = an.y > 0.7 ? p.xz : vec2(dot(p.xz, normalize(vec2(-n.z, n.x))), p.y);
  vec2 f = vec2(cone * (t + t0) + 0.005);
  vec3 alb; float glassy; vec3 inter = vec3(0.04);
  // Every mode uses the simple colours: calling the full material code here as well doubled the shader
  // the Direct3D compiler has to digest (~55 s more on Windows). "Full" adds ambient occlusion.
  alb = reflAlbedo(mat, p, n, uv, f, glassy);
  float shd = 1.0;
  if (uReflMode >= 2) shd = (dot(uKeyCol, vec3(1.0)) > 0.0 && dot(n, uKeyDir) > -0.05) ? softShadow(p + n * max(0.05, 0.0015 * t), uKeyDir, 0.5) : 0.0;
  float ao = uReflMode == 3 ? calcAO(p, n) : 1.0;
  vec3 amb = mix(vec3(0.30, 0.28, 0.26), vec3(0.42, 0.52, 0.68), n.y * 0.5 + 0.5) * ao * uAmbTint;
  vec3 c = alb * (max(dot(n, uKeyDir), 0.0) * shd * vec3(2.6, 2.4, 2.1) * uKeyCol + amb * 0.9 * uAmbK);
  if (uLampK > 0.0) c += alb * vec3(1.0, 0.62, 0.24) * lampIrradiance(p, n) * uLampK;
  if (matId(mat) > 7.5 && matId(mat) < 8.5 && n.y < -0.7) c += vec3(1.0, 0.66, 0.3) * uLampEmit * lensView(-rd.y);
  // windows of other buildings: dim rooms, and the sky reflected as real glass does (~6% head-on, more at a slant)
  vec3 R2 = reflect(rd, n);
  float F2 = 0.06 + 0.94 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
  c = mix(c, mix(inter * min(uAmbK, 1.0), skyBase(vec3(R2.x, max(R2.y, 0.0), R2.z)), F2), glassy);
  c = mix(c, uFogCol, 1.0 - exp(-(t + t0) * 0.0007));
  c += lampSprites(ro, rd, t, cone);
  return mix(c, sky, smoothstep(0.75 * uReflReach, uReflReach, t));   // fade out toward the reach limit
#endif
}

vec3 camRay(vec2 px){ return normalize(uCamRot * projDir(px)); }

vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03)) / (x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }


// unit directions stored in two numbers (octahedral mapping)
vec2 octEnc(vec3 n){
  n /= abs(n.x) + abs(n.y) + abs(n.z);
  return n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
}
vec3 octDec(vec2 e){
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return normalize(n);
}

void main(){
  // 1. Which screen point does this cell stand for? (the same in every pass, so they cover the same cells)
  vec2 spx; float cell;
  if (uLayout == 0){
    vec2 ci = floor(gl_FragCoord.xy - uLvlOff);
    vec2 c = (ci + 0.5) * uCell;
    if (c.x - 0.5*uCell > uRes.x || c.y - 0.5*uCell > uRes.y) discard;
    if (uFov == 1){
      float r = distance(c, uGaze), m = 0.75*uCell;
      // retina-ring mode: square cells only fill the centre disk
      if (uLpMode == 1 && r - m > uR0 + 2.0*uS*(uR0 + uR2) + uCell) discard;
      // Only cells whose size matches the eye model here (plus the next level, for blending).
      // Distances come from last frame, checked at the centre and corners of the cell.
      float dc = prevDepthAt(c);
      float Lmin = log2(cellPx(max(r - m, 0.0), dc)/uBase), Lmax = log2(cellPx(r + m, dc)/uBase);
      for (int i = 1 + ZERO; i < 5; i++){
        vec2 q = c + vec2((i == 1 || i == 3) ? -m : m, i < 3 ? -m : m);
        float L = log2(cellPx(distance(q, uGaze), prevDepthAt(q))/uBase);
        Lmin = min(Lmin, L); Lmax = max(Lmax, L);
      }
      float k = float(uLvl);
      if (k < floor(Lmin) || k > floor(Lmax) + 1.0) discard;
    }
    spx = c + uJit*uCell;
    cell = uCell;
  } else {
    vec2 uw = gl_FragCoord.xy + uJit;
    float th = (uw.x / uNth - 0.5) * 6.2831853;
    float r = (uR0 + uR2)*exp(uw.y*uS) - uR2;
    cell = uS*(r + uR2);
    if (r < uR0 - 2.0*cell) discard;
    spx = uGaze + r*vec2(cos(th), sin(th));
    if (spx.x < -cell || spx.y < -cell || spx.x > uRes.x + cell || spx.y > uRes.y + cell) discard;
  }

  vec3 rd = camRay(spx);
  // eccentricity as the viewer sees it on screen (zoom magnifies the world, not the eye)
  float eVis = uFast == 1 ? distance(spx, uGaze) * degrees(uPixVis)
                          : degrees(acos(clamp(dot(rd, normalize(uCamRot*uGazeDir)), -1.0, 1.0))) * uZoom;
  float recAng = uAcuity * (1.0 + eVis / uE2);   // receptor size here (visual angle)
  float cellAng = cell * uPixVis / uZoom;
  vec3 ro = uCamPos;
  ivec2 gp = ivec2(gl_FragCoord.xy);

#if defined(PASS_GEOM) || defined(PASS_ALL)
  // 2. The ray
  float gm; vec3 gn;
  float tG = groundHit(ro, rd, gm, gn);
  float tMax = min(tG, 1800.0);       // only buildings closer than the ground need marching
  float t = 0.0, ph = 1e9, tPrev = 0.0; vec2 h = vec2(1e9, -1.0); bool hit = false, ranOut = true, big = false;
  for (int i = 0 + ZERO; i < 640; i++){   // most rays finish in far fewer; long street-canyon rays need more
    vec3 p = ro + rd*t;
    if (p.y > 150.0 && rd.y > 0.0){ ranOut = false; break; }
    h = map(p);
    if (h.x < 0.0004*t + 0.0008){
      if (big){
        // the last step was a long one and may have gone past the surface: search back for it
        float lo = tPrev, hi = t;
        for (int j = 0 + ZERO; j < 10; j++){
          float mid = 0.5 * (lo + hi);
          if (map(ro + rd*mid).x < 0.0004*mid + 0.0008) hi = mid; else lo = mid;
        }
        t = hi; h = map(ro + rd*t);
      }
      hit = true; ranOut = false; break;
    }
    // A ray skimming along a wall stays the same small distance from it and would crawl.
    // When the ray is not getting closer to anything, let it step at least 2% of the distance travelled.
    float st = h.x;
    big = h.x > 0.85 * ph && 0.02 * t > h.x;
    if (big) st = 0.02 * t;
    ph = h.x; tPrev = t;
    float adv = min(st, gBound), j = rayJump(p, rd);
    if (j > adv){ adv = j; big = false; }   // nothing to hit before leaving the region (or reaching its top)
    t += adv;
    if (t > tMax){ ranOut = false; break; }
  }
  // A ray skimming along a wall takes tiny steps and can run out of budget. If it is still touching
  // that wall, shade it as a hit; otherwise it reaches the ground, or the distance haze.
  if (ranOut && h.x < 0.5) hit = true;
  bool gHit = false;
  if (!hit && tG < 1800.0){ hit = true; gHit = true; t = tG; h = vec2(0.0, gm); }
  float depth = hit ? t : 10000.0;
  vec3 n = vec3(0.0, 1.0, 0.0);
  if (hit) n = gHit ? gn : calcN(ro + rd*t, t);
#else
  vec4 g0 = texelFetch(uG0, gp, 0);
  float depth = g0.x, t = g0.x;
  bool hit = depth < 9000.0;
  vec2 h = vec2(0.0, g0.y);
  vec3 n = octDec(g0.zw);
#endif

#ifdef PASS_GEOM
  outColor = vec4(depth, h.y, octEnc(n));
#else
  vec3 col = vec3(0.0);
  if (!hit){
#if defined(PASS_COMPOSE) || defined(PASS_ALL)
    // below the horizon but too far to reach: ground lost in haze
    float skyAng = max(cellAng, recAng / uZoom);
    vec3 skyc = skyCol(rd, 1.0, skyAng);
    col = rd.y < 0.0 ? mix(uFogCol, skyc, 0.15) : skyc;
    col += lampSprites(ro, rd, 1e9, skyAng);
#elif defined(PASS_MAT)
    oM0 = vec4(0.0); oM1 = vec4(0.0); oM2 = vec4(0.0); return;
#else
    outColor = vec4(0.0); return;
#endif
  } else {
    vec3 p = ro + rd*t;
    vec3 a = abs(n);
    vec2 uv; vec3 T, B;
    if (a.y > 0.7){ uv = p.xz; T = vec3(1,0,0); B = vec3(0,0,1); }
    else {
      // walls (at any angle): u runs along the wall, v up
      vec2 tx = normalize(vec2(-n.z, n.x));
      uv = vec2(dot(p.xz, tx), p.y); T = vec3(tx.x, 0.0, tx.y); B = vec3(0.0, 1.0, 0.0);
    }

    // Footprint of one cell/receptor on the surface. Seen at a slant it stretches along the
    // viewing direction only; across it, it stays the same width (anisotropic filtering).
    // receptor size and focus blur combine; each cell averages everything inside its footprint
    // Attention: whatever you are looking at (the whole building, or a patch of ground around the
    // gaze point) keeps its sharpness further from the centre of vision; everything else a bit less.
    if (uAttn == 1){
      float rad = max(0.75, 0.06 * length(uAttnP - uCamPos));
      float aw = 1.0 - smoothstep(rad, 2.5*rad, distance(p, uAttnP));
      if (uAttnBld == 1 && h.y >= 16.0 && distance(wT(bldOf(h.y)).xy, uAttnB) < 0.05) aw = 1.0;
      recAng = uAcuity * (1.0 + eVis / (uE2 * mix(1.0 / sqrt(uAttnK), uAttnK, aw)));
    }
    float dfA = defocusAng(t);
    float eyeAng = sqrt(recAng*recAng + dfA*dfA) / uZoom;
    float ang = uMode == 1 ? cellAng : max(cellAng, eyeAng);
    float f0 = t * ang;
    float cosv = max(abs(dot(n, rd)), 0.02);
    vec3 sa = rd - n*dot(rd, n);
    float sal = length(sa);
    sa = sal > 1e-5 ? sa / sal : T;
    vec3 sb = cross(n, sa);
    vec2 f = vec2(length(vec2(f0/cosv*dot(sa, T), f0*dot(sb, T))),
                  length(vec2(f0/cosv*dot(sa, B), f0*dot(sb, B))));

    // 3. Materials
#if defined(PASS_MAT) || defined(PASS_ALL)
    // the material here and at two points beside it (for the surface relief), from one call site
    vec2 eps = max(f*0.5, vec2(0.0015));
    Surf s, su, sv;
    for (int k = ZERO; k < 3; k++){
      vec2 du = k == 1 ? vec2(eps.x, 0.0) : (k == 2 ? vec2(0.0, eps.y) : vec2(0.0));
      gHOnly = k > 0;
      Surf r = surfAt(h.y, p + T*du.x + B*du.y, n, uv + du, f);
      if (k == 0) s = r; else if (k == 1) su = r; else sv = r;
    }
    gHOnly = false;
    // surface relief slope, capped (~60 degrees) so sharp steps cannot flip the shading normal
    float dhu = clamp((su.h - s.h)/eps.x, -1.7, 1.7), dhv = clamp((sv.h - s.h)/eps.y, -1.7, 1.7);
    vec3 N = normalize(n - (dhu + s.tilt.x)*T - (dhv + s.tilt.y)*B);
#else
    vec4 m0 = texelFetch(uM0, gp, 0), m1 = texelFetch(uM1, gp, 0), m2 = texelFetch(uM2, gp, 0);
    Surf s = blank();
    s.alb = m0.rgb; s.glass = m0.a; s.refl = m1.z; s.emit = m1.w; s.interior = m2.rgb; s.h = m2.w;
    vec3 N = octDec(m1.xy);
#endif
#ifdef PASS_MAT
    oM0 = vec4(s.alb, s.glass); oM1 = vec4(octEnc(N), s.refl, s.emit); oM2 = vec4(s.interior, s.h);
    return;
#else

    // 4. Light: the sun's shadow, ambient occlusion, street lights
#if defined(PASS_LIGHT) || defined(PASS_ALL)
    // start offset varies per pixel and frame only while frames are blended (otherwise it would be static noise)
    float sj = dot(uJit, uJit) > 0.0 ? fract(sin(dot(spx + uJit*17.31, vec2(12.9898, 78.233))) * 43758.5453) : 0.5;
    // no shadow ray for surfaces facing away from the sun or moon: they get no direct light anyway
    float sh = (dot(uKeyCol, vec3(1.0)) > 0.0 && dot(n, uKeyDir) > -0.05) ? softShadow(p + n*0.02, uKeyDir, sj) : 0.0;
    float ao = calcAO(p, n);
    float lampE = uLampK > 0.0 ? lampIrradiance(p, N) : 0.0;
#else
    vec4 l0 = texelFetch(uL0, gp, 0);
    float sh = l0.x, ao = l0.y, lampE = l0.z;
#endif
#ifdef PASS_LIGHT
    outColor = vec4(sh, ao, lampE, 0.0);
    return;
#else

    // 5. What the surface reflects
    vec3 R = reflect(rd, N);
#if defined(PASS_REFL) || defined(PASS_ALL)
    gNoStars = true;
    // Glass traces its reflection into the city (a flat mirror keeps the cell's sharpness, plus a little glass
    // waviness); everything else reflects only the sky (spread ~1 degree: no surface is perfectly flat).
    // One call either way, so the sky's code is compiled once here.
    bool traced = uReflMode > 0 && s.glass > 0.02;
    vec3 refl = reflScene(p + N * 0.03, R, traced ? ang + 0.0003 : ang * 2.0, t, sh, traced);
    gNoStars = false;
#else
    vec3 refl = texelFetch(uRf, gp, 0).rgb * 4.0;
#endif
#ifdef PASS_REFL
    outColor = vec4(clamp(refl, 0.0, 2.6e5) * 0.25, 0.0);     // stored at 1/4 scale: stays inside half-float range
    return;
#else

    // 6. All of it together
    float heat = clamp(1.0 - (log2(sqrt(f.x*f.y)) / log2(10.0) + 3.0) / 3.0, 0.0, 1.0);
    float cavity = clamp(1.0 + s.h*4.0, 0.55, 1.0);
    float dif = max(dot(N, uKeyDir), 0.0) * sh;
    vec3 amb = mix(vec3(0.30, 0.28, 0.26), vec3(0.42, 0.52, 0.68), N.y*0.5 + 0.5) * ao * cavity * uAmbTint;
    vec3 lit = s.alb * (dif * vec3(2.6, 2.4, 2.1) * uKeyCol + amb * 0.9 * uAmbK);
    if (uLampK > 0.0) lit += s.alb * vec3(1.0, 0.62, 0.24) * lampE * uLampK * cavity;
    lit += s.emit * vec3(1.0, 0.66, 0.3) * uLampEmit * lensView(rd.y) * (1.0 - smoothstep(0.5, 2.0, ang * t / 0.2));   // far: drawn as a glow instead
    float cv = max(dot(N, -rd), 0.0);
    float F = s.refl + (1.0 - s.refl) * pow(1.0 - cv, 5.0);
    // rooms behind the glass are lit by daylight through the windows (dark at night, for now)
    vec3 glassCol = mix(s.interior * (0.6 + 0.4*ao) * min(uAmbK, 1.0), refl, clamp(F, 0.0, 1.0));
    // Rough surfaces only pick up a blurred average of the sky, and never reach full mirror
    // reflectance at grazing angles; only glass shows a sharp image of the sky and sun.
    float Fr = s.refl + (1.0 - s.refl) * pow(1.0 - cv, 5.0) * 0.25;
    vec3 roughRefl = skyBase(vec3(R.x, max(R.y, 0.0), R.z));
    col = mix(lit + roughRefl*Fr*0.08*(1.0 - s.glass), glassCol, s.glass);

    float fog = 1.0 - exp(-t * 0.0007);
    col = mix(col, uFogCol, fog);
    col += lampSprites(ro, rd, t, ang);
    if (uMode == 2){
      vec3 ramp = heat < 0.25 ? mix(vec3(0.07,0.10,0.23), vec3(0.16,0.31,0.63), heat/0.25)
               : heat < 0.5 ? mix(vec3(0.16,0.31,0.63), vec3(0.18,0.65,0.60), (heat-0.25)/0.25)
               : heat < 0.75 ? mix(vec3(0.18,0.65,0.60), vec3(0.90,0.76,0.29), (heat-0.5)/0.25)
               : mix(vec3(0.90,0.76,0.29), vec3(0.96,0.95,0.89), (heat-0.75)/0.25);
      col = ramp * (0.55 + 0.45*max(dot(N, uKeyDir), 0.0)*sh);
      outColor = vec4(pow(col, vec3(2.2)) * 0.25, depth);
      return;
    }
#endif
#endif
#endif
  }
#if defined(PASS_COMPOSE) || defined(PASS_ALL)
  if (uMode == 2 && !hit){ outColor = vec4(vec3(0.02) * 0.25, depth); return; }
  // linear light, stored at 1/4 scale; exposure, eye adaptation and tone mapping happen at the end
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  outColor = vec4(clamp(col, 0.0, 2.6e5) * 0.9 * 0.25, depth);   // stays inside half-float range
#endif
#endif
}`;

// The five pass shaders: the scene source with one pass switched on.
const pass = (name) => SCENE_FS.replace('#version 300 es', '#version 300 es\n#define PASS_' + name);
export const SCENE_GEOM_FS = pass('GEOM'), SCENE_MAT_FS = pass('MAT'), SCENE_LIGHT_FS = pass('LIGHT'),
  SCENE_REFL_FS = pass('REFL'), SCENE_COMPOSE_FS = pass('COMPOSE');
