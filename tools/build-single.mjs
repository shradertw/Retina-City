// Bundles the modules back into one self-contained HTML file (dist/retina-city.html):
// the stylesheet and the script are inlined, everything else stays as in index.html.
// Usage: npm run build   (needs esbuild: npm install)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require('esbuild'); }
catch { esbuild = createRequire('/opt/npm-tools/')('esbuild'); }   // fallback for the build workspace

const js = esbuild.buildSync({
  entryPoints: [join(root, 'src/main.js')], bundle: true, format: 'iife', target: 'es2020',
  write: false, legalComments: 'none',
}).outputFiles[0].text;
const css = readFileSync(join(root, 'src/style.css'), 'utf8');
let html = readFileSync(join(root, 'index.html'), 'utf8');
const swap = (from, to) => { if (!html.includes(from)) throw new Error('build: missing ' + from); html = html.replace(from, () => to); };
swap('<link rel="stylesheet" href="src/style.css">', '<style>\n' + css + '</style>');
swap('<script type="module" src="src/main.js"></script>', '<script>\n' + js.replace(/<\/script/gi, '<\\/script') + '</script>');
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/retina-city.html'), html);
console.log('built dist/retina-city.html', (html.length / 1024).toFixed(0) + ' KB');
