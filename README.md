# Retina-City
Working with Claude.AI to make a procedural city you see the way a human eye sees it. Raymarched in the browser with eye adaptation, glare, squinting, blinking, after-images, and focus, plus a seeded world of cities and districts with simulated history and NPCs with schedules and such. Very much a work in progress.

## Running it
- **Online:** GitHub Pages serves the `dev` branch directly; no build step is needed, the browser loads the modules as they are.
- **Locally:** serve the folder with any static server (for example `python -m http.server`) and open `index.html`. Opening the file directly does not work, because browsers block modules on `file://`.
- **Single file:** `npm install` once, then `npm run build` writes `dist/retina-city.html`, everything inlined in one file.

## Layout
| Path | What it holds |
| --- | --- |
| `index.html` | The page markup and the settings panel |
| `src/style.css` | Styles |
| `src/main.js` | WebGL setup, controls, view codes, the frame loop and the eye's processing passes |
| `src/core/` | Shared state and small helpers |
| `src/world/` | The seeded hash, the chunk stream that keeps the area around the player on the GPU, and the world evaluated in JavaScript (collision, focus ray) |
| `src/gen/` | The world generator: options, land and ocean, roads and buildings in 512 m chunks, and the 32 m render cells the shaders read |
| `src/sky/` | Sun and moon positions, light levels, the day/night cycle |
| `src/ui/` | Start screen, loading report, map, sky dials, compass |
| `src/shaders/` | GLSL: shared pieces, the raymarched scene, and the post-processing passes |
| `tools/build-single.mjs` | Bundles everything into one HTML file |
| `diag.html` | Times the compile of each scene pass, and of the old single shader (`index.html?single` runs the single shader) |

Branches: `main` holds tested versions, `dev` is work in progress, `baseline-v72` is the original single-file version.
