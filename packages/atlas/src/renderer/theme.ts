/**
 * Atlas render theme — "Obsidian". Single source of truth for every visual
 * constant in the Pixi canvas so the graph stays calm and consistent.
 *
 * Design rules:
 *  - Neutral-dominant canvas; color ONLY encodes meaning.
 *  - One accent (indigo) for interaction. 6 quiet type hues.
 *  - Brightness = importance: containers dimmest, ADRs brightest.
 *  - Alarm red reserved exclusively for cycles/errors.
 */

export interface NodeTheme {
  dim: number;
  base: number;
  bright: number;
  radius: number;
}

export const PIXI_THEME = {
  /** Background behind the transparent canvas (CSS radial-gradient does the work). */
  bg: 0x0a0a0f,

  /** Node fill + hover + selection colors per type (dim = rest, base = hover, bright = ring/glow). */
  node: {
    file: { dim: 0x3b63b8, base: 0x5b8cff, bright: 0x8ab0ff, radius: 8 } as NodeTheme,
    workspace: { dim: 0x565f99, base: 0x7986d6, bright: 0xa5aff0, radius: 6 } as NodeTheme,
    folder: { dim: 0x4a4f6d, base: 0x6a7196, bright: 0x99a0c8, radius: 5.5 } as NodeTheme,
    class: { dim: 0x6455b8, base: 0x8f7ef0, bright: 0xbcb0ff, radius: 6.5 } as NodeTheme,
    interface: { dim: 0x2f82ab, base: 0x45b8e8, bright: 0x83d6f8, radius: 6 } as NodeTheme,
    function: { dim: 0x2a9265, base: 0x3ecf8e, bright: 0x7be3b4, radius: 4.5 } as NodeTheme,
    document: { dim: 0x8f7041, base: 0xc8a15e, bright: 0xe2c084, radius: 6 } as NodeTheme,
    adr: { dim: 0xa37f35, base: 0xdcae53, bright: 0xf0cb7d, radius: 5.5 } as NodeTheme,
    person: { dim: 0x9a5465, base: 0xd4798f, bright: 0xeaa6b5, radius: 4.5 } as NodeTheme,
    dependency: { dim: 0x4a4a52, base: 0x6b6b76, bright: 0x9a9aa6, radius: 4 } as NodeTheme,
    cluster: { dim: 0x565f99, base: 0x7986d6, bright: 0xa5aff0, radius: 10 } as NodeTheme,
    default: { dim: 0x3e3e46, base: 0x5a5a64, bright: 0x8a8a96, radius: 5 } as NodeTheme,
  },

  nodeAlpha: { rest: 0.85, hover: 1, dimmed: 0.22, ghost: 0.15 },

  ring: { hoverW: 1, selW: 1.5, hoverA: 0.8, selA: 1 },

  /** Invisible pointer hit radius (min) — nodes are easier to grab than they look. */
  hitRadius: 9,

  edge: {
    rest: 0x3a3a44,
    restAlpha: 0.12,
    width: 1,
    /** alpha scales with edge weight: clamp(.05 + w*.2, .05, .3) */
    weightMaxAlpha: 0.3,
    targetDotAlpha: 0.06,
    /** mode emphasis: [color, alpha, width] */
    focus: [0x8f7ef0, 0.5, 1.5],
    impact: [0xe2a14f, 0.6, 1.75],
    path: [0x8ab0ff, 0.8, 2],
    topo: [0x5b8cff, 0.45, 1.25],
    cycle: [0xe2574c, 0.7, 1.5],
  },

  label: {
    font: "Inter",
    size: 10,
    fill: 0xe6e6eb,
    /** zoom bands: below first = none; between = files/workspace/class only; above = all */
    lodZooms: [0.55, 0.85],
    /** max labels rendered at once (top by priority), rest hidden */
    budget: 40,
  },

  halo: {
    selAlpha: 0.5,
    hoverAlpha: 0.18,
    /** additive radial-gradient sprite, pre-baked once and reused */
    additive: true,
  },

  dotGrid: { minZoom: 1.2, maxZoom: 1.5, spacing: 28, color: 0x1f1f24, alpha: 0.5 },

  zoom: { min: 0.1, max: 3.5, fitPad: 140 },

  cullMargin: 120,

  dur: { hover: 90, fly: 550, select: 220, dim: 300, modeFade: 260 },
} as const;

export type NodeType = keyof typeof PIXI_THEME.node;

export function getNodeTheme(type: string): NodeTheme {
  return (PIXI_THEME.node as Record<string, NodeTheme>)[type] || PIXI_THEME.node.default;
}
