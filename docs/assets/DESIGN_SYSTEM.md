# Astrivya Brand Assets — Design System

> Production spec for all visuals in `docs/assets/`. Source of truth for color,
> type, grid, graph geometry, and dark/light parity rules. Assets are hand-crafted
> SVG (no exports from design tools), so they are versionable, diffable, and
> render everywhere.

## 1. Canvas grid

| Asset | Canvas | Aspect | Notes |
|-------|--------|--------|-------|
| `og-image.svg` | 1280 × 640 | 2 : 1 | GitHub social preview, dark |
| `logo-mark.svg` | 48 × 48 | 1 : 1 | Badge mark, scales to any size |
| `logo-lockup-{dark,light}.svg` | 210 × 48 | ~4.4 : 1 | Mark + wordmark |

- **Base unit: 4 px.** All coordinates are multiples of 4 unless geometry (node
  orbits) demands a half-pixel.
- **OG margins:** 96 px left/right. Content never touches the canvas edge.

## 2. Type scale

Font stacks (web-safe fallbacks — no embedded font files in SVG):

- Display/sans: `Outfit, 'Segoe UI', Arial, sans-serif`
- Mono: `'JetBrains Mono', Consolas, monospace`

| Role | Family | Size | Weight | Tracking |
|------|--------|------|--------|----------|
| Lockup wordmark | sans | 30 | 700 | +0.5 |
| OG headline | sans | 46 | 600 | 0 |
| OG tagline / subline | sans | 25 / 19 | 500 / 400 | 0 |
| Mono meta lines | mono | 12–13 | 400–700 | up to +2 (uppercase labels) |

All text is real `<text>` elements (selectable, accessible). Separators are
literal UTF-8 (`·`, `—`, `→`). No emoji, no HTML entities (only the XML-required
`&amp;` when an ampersand appears in copy).

## 3. Color tokens

Dark canvases:

| Token | Value |
|-------|-------|
| bg base / radial | `#07050f` · `#161233 → #06040b` |
| text primary / secondary / dim | `#f8fafc` / `#94a3b8` / `#64748b` |
| brand gradient (wordmark) | `#f8fafc → #a5b4fc` |
| accent indigo / violet / cyan | `#6366f1` / `#8b5cf6` / `#06b6d4` |
| accent emerald / amber / rose | `#10b981` / `#f59e0b` / `#e11d48` |
| node rim / edge opacities | `rgba(255,255,255,.30)` · 0.30–0.55 |

Light canvases (same hue, darkened for contrast on white):

| Token | Value |
|-------|-------|
| bg base / radial | `#ffffff` · `#ffffff → #eef2ff` |
| text primary / secondary / dim | `#111827` / `#475569` / `#64748b` |
| brand gradient (wordmark) | `#111827 → #4f46e5` |
| accent indigo / violet / cyan | `#4f46e5` / `#7c3aed` / `#0891b2` |
| accent emerald / amber | `#059669` / `#d97706` |
| node rim (light) | `#ffffff`, 2 px |

## 4. Graph motif (the "Astrivya graph")

A precise hub-and-spoke force layout — **no jitter, all coordinates computed**:

- Hub node r 13; orbit ring r 140 (hero) with 6 nodes at 60° steps; leaf nodes
  on r ≈ 185 in open quadrants; node radii 9–10 (orbit) and 6–7 (leaves).
- Edges: 1.25 px, round caps; a subset re-stroked at 3.5 px + `feGaussianBlur` 6
  for glow. Ambient glow is a radial-gradient circle (indigo 0.28 → 0).
- Nodes are 3 layers: accent fill → shared `node-shine` radial (top-left gloss,
  `objectBoundingBox`) → rim stroke. One shared shine gradient serves all nodes.
- 2 concentric guide rings behind the graph (≤ 6% opacity, one dashed) for depth.
- Depth particles: 5–6 tiny r 1.5–2 dots at fixed positions.
- Hub pulse: `<animate>` on r/opacity (ignored by static renderers, harmless).

## 5. Dark/light parity

- Identical layout, coordinates, radii, and edge topology — only fills, strokes,
  gradients, and opacities change.
- Dark: rim `rgba(255,255,255,.30)`, glow opacities 0.28–0.50.
- Light: white 2 px rims, glow opacities ~0.14, edges use darkened hue set.

## 6. Architecture diagram

- Canvas 900 × 660. Container rx 14, chip rx 8, pill rx 999.
- 4 layers (INTERFACES · AKG INDEXER · AKG CORE · STORAGE) with a 32 px arrow
  gutter between them; single chevron flow on the 450 px axis.
- Per-layer accent stroke + ghost number (01–04) bottom-right.
- Chip fills `rgba(accent, .12)`, strokes `rgba(accent, .5)`, mono labels.

## 7. Raster rendering

SVG is the source of truth. For PNG (OG preview, README fallbacks) use
`@resvg/resvg-js` (self-contained, uses system fonts — Segoe UI/Consolas on
Windows):

```sh
npm install --no-save --no-package-lock @resvg/resvg-js
node scripts/render-assets.mjs
```

Renders: hero/OG at 1× and 2×, lockups at 2×, mark at 4×.
