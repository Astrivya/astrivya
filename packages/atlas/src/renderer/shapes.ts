import * as PIXI from "pixi.js";
import type { NodeShape } from "./theme";

/**
 * Pre-baked white shape textures, one per NodeShape. Sprites tint + reuse these
 * so the renderer batches per-texture (6 textures = worst case ~6 draw calls).
 * Each shape fills its 64px box with a 1px inset so antialiasing doesn't clip.
 */

const SHAPE_SIZE = 64;
const PAD = 2;
const HALF = SHAPE_SIZE / 2;

export function bakeShapeTextures(renderer: PIXI.Application): Record<NodeShape, PIXI.Texture> {
  const textures = {} as Record<NodeShape, PIXI.Texture>;
  const shapes: NodeShape[] = ["circle", "rounded-square", "hexagon", "diamond", "page", "donut"];
  for (const shape of shapes) {
    const g = drawShape(shape);
    textures[shape] = renderer.renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
  }
  return textures;
}

function drawShape(shape: NodeShape): PIXI.Graphics {
  const g = new PIXI.Graphics();
  const fill = { color: 0xffffff, alpha: 1 };

  switch (shape) {
    case "circle":
      g.circle(HALF, HALF, HALF - PAD).fill(fill);
      break;
    case "rounded-square":
      g.roundRect(PAD, PAD, SHAPE_SIZE - PAD * 2, SHAPE_SIZE - PAD * 2, 12).fill(fill);
      break;
    case "hexagon": {
      const r = HALF - PAD;
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        pts.push(HALF + r * Math.cos(a), HALF + r * Math.sin(a));
      }
      g.poly(pts).fill(fill);
      break;
    }
    case "diamond":
      g.poly([HALF, PAD, SHAPE_SIZE - PAD, HALF, HALF, SHAPE_SIZE - PAD, PAD, HALF]).fill(fill);
      break;
    case "page":
      g.roundRect(HALF - 16, PAD, 32, SHAPE_SIZE - PAD * 2, 6).fill(fill);
      break;
    case "donut":
      // Ring = outer circle minus inner hole (v8 `cut()` punches the hole).
      g.circle(HALF, HALF, HALF - PAD).fill(fill);
      g.circle(HALF, HALF, HALF - 18).cut();
      break;
  }
  return g;
}
