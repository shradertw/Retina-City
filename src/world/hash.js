/* Shared world data: the integer hash used by both the JavaScript and the shaders (same results in both). */
export const SEED = 1337;
export function hu(x){ x>>>=0; x=(x^(x>>>16))>>>0; x=Math.imul(x,0x7feb352d)>>>0; x=(x^(x>>>15))>>>0; x=Math.imul(x,0x846ca68b)>>>0; x=(x^(x>>>16))>>>0; return x; }
export function h2(cx,cz,s){ return hu(((Math.imul((cx+1048576)>>>0,0x9E3779B1)>>>0) ^ hu((((cz+1048576)>>>0)+s)>>>0))>>>0); }
export function hf(h){ return (h>>>8)/16777216; }
export function rnd(h,k){ return hf(hu((h+Math.imul(k,0x632BE5AB))>>>0)); }
