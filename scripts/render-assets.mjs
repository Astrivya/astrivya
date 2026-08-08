/**
 * Render Astrivya brand assets (SVG) to PNG.
 *
 * SVG is the source of truth; this script is a convenience for producing
 * raster versions (OG social preview, README fallbacks, favicon).
 *
 * Usage:
 *   npm install --no-save --no-package-lock @resvg/resvg-js
 *   node scripts/render-assets.mjs
 *
 * Outputs PNG into docs/assets/ next to the source SVGs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "docs", "assets");

const jobs = [
  { src: "og-image.svg",    out: "og-image.png",         scale: 1 },
  { src: "og-image.svg",    out: "og-image@2x.png",      scale: 2 },
  { src: "logo-lockup-dark.svg",  out: "logo-lockup-dark@2x.png",  scale: 2 },
  { src: "logo-lockup-light.svg", out: "logo-lockup-light@2x.png", scale: 2 },
  { src: "logo-mark.svg",   out: "logo-mark@4x.png",     scale: 4 },
];

let failed = 0;
for (const { src, out, scale } of jobs) {
  try {
    const svg = readFileSync(join(assets, src), "utf8");
    const width = Number((svg.match(/<svg[^>]*width="(\d+)"/) || [])[1] || 0);
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: Math.round(width * scale) },
      font: { loadSystemFonts: true },
    });
    const png = resvg.render().asPng();
    writeFileSync(join(assets, out), png);
    console.log(`ok  ${out}  (${width * scale}px wide, ${png.length} bytes)`);
  } catch (err) {
    failed += 1;
    console.error(`ERR ${src} -> ${out}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
