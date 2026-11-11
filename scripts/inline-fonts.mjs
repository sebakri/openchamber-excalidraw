// Inlines Excalidraw's Latin fonts into editor/main.js as data: URLs.
//
// The editor runs in a sandboxed frame without a usable base URL, and the CDN
// the fonts would otherwise come from is blocked on some networks, in which
// case every drawing falls back to a system serif font. Excalidraw accepts a
// `data:` URL wherever it expects a font file, so the bundle carries them.
// Xiaolai (CJK, about 13 MB) stays on the CDN.
//
// Usage: node scripts/inline-fonts.mjs [fontsDir] [bundle]
// fontsDir defaults to node_modules/@excalidraw/excalidraw/dist/prod/fonts.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const fontsDir = process.argv[2] ?? 'node_modules/@excalidraw/excalidraw/dist/prod/fonts';
const bundlePath = process.argv[3] ?? 'editor/main.js';
const SKIP = new Set(['Xiaolai']);

let js = readFileSync(bundlePath, 'utf8');
let count = 0;
let bytes = 0;
js = js.replace(/"\.\/fonts\/([A-Za-z]+)\/([A-Za-z0-9_.-]+\.woff2)"/g, (match, family, file) => {
  if (SKIP.has(family)) return match;
  const path = `${fontsDir}/${family}/${file}`;
  if (!existsSync(path)) return match;
  const data = readFileSync(path);
  count += 1;
  bytes += data.length;
  return `"data:font/woff2;base64,${data.toString('base64')}"`;
});
writeFileSync(bundlePath, js);
console.log(`inline-fonts: ${count} fonts inlined (${(bytes / 1024).toFixed(0)} KB raw)`);
