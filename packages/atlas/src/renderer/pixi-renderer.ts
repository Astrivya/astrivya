import * as PIXI from "pixi.js";
import type { CommunityInfo } from "../api/akg-client";
import type { LayoutEdge, LayoutNode } from "../layout/force-layout";
import { bakeShapeTextures } from "./shapes";
import { type NodeShape, PIXI_THEME, getEdgeSemantics, getLodMinZoom, getNodeTheme } from "./theme";

/**
 * Atlas PixiJS 8 renderer — "Obsidian" style.
 *
 * Efficiency design (10k-50k nodes):
 *  - Nodes are Sprite instances sharing ONE of six pre-baked white shape
 *    textures (circle/rounded-square/hexagon/diamond/page/donut), tinted per
 *    type/state → Pixi batches per texture (≤6 draw calls). No per-frame
 *    Graphics triangulation.
 *  - Halo is one pre-baked additive radial-gradient texture, reused via tint+alpha.
 *  - Labels are pre-rendered sprite textures (generateTexture), capped at
 *    PIXI_THEME.label.budget, ranked by priority; never one PIXI.Text per node.
 *  - Hover picking via a uniform-grid spatial hash rebuilt alongside positions;
 *    selection ring is a single overlay Graphics, not 50k event listeners.
 *  - Edges live in one Graphics; redrawn only while animating or on mode change.
 *  - Story edges (decided/affects/implements/...) are rare, so they get the
 *    visual budget: tapered quads + arrowhead on emphasis, semantic color.
 */

interface SpatialCell {
  nodes: number[];
}

export class PixiRenderer {
  app!: PIXI.Application;
  private container!: HTMLDivElement;
  private viewport!: PIXI.Container;

  private nodeSprites: Map<string, PIXI.Sprite> = new Map();
  private nodeData: Map<string, { x: number; y: number; radius: number }> = new Map();
  private nodesArray: LayoutNode[] = [];
  private edgesArray: LayoutEdge[] = [];

  private edgesGraphics!: PIXI.Graphics;
  private ringGraphics!: PIXI.Graphics;
  private haloSprite!: PIXI.Sprite;

  // Shared textures (white, tinted per node/state)
  private haloTexture!: PIXI.Texture;
  private shapeTextures!: Record<NodeShape, PIXI.Texture>;

  // Spawn-at-parent reveal: node id → spawn start timestamp (ms). Nodes added
  // after the initial load grow scale 0→1 from their new position.
  private spawnTimes: Map<string, number> = new Map();

  // Label layer
  private labelContainer!: PIXI.Container;
  private labelSprites: Map<string, PIXI.Sprite> = new Map();
  private labelTextureCache: Map<string, PIXI.Texture> = new Map();

  // Explore-mode importance set: top N nodes (by priority × degree) that stay
  // rendered at overview; everything else appears via LOD as you zoom in.
  private exploreSet: Set<string> = new Set();

  // Spatial hash for hover picking
  private cellSize = 48;
  private spatial: Map<string, SpatialCell> = new Map();

  // Camera / interaction state
  private zoom = 1.0;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private viewportStart = { x: 0, y: 0 };

  private selectedNodeId: string | null = null;
  private hoveredNodeId: string | null = null;
  private onNodeSelectCallback?: (id: string) => void;

  // Mode visual state
  private activeMode: "explore" | "focus" | "impact" | "path" | "topo" | "overview" = "explore";
  private highlightedNodeIds: Set<string> = new Set();
  private pathNodeIds: string[] = [];
  private directImpactIds: Set<string> = new Set();
  private transitiveImpactIds: Set<string> = new Set();
  private topoDepths = new Map<string, number>();
  private topoCycleIds = new Set<string>();

  // Overview (rung 0) supernode layer: community → { centroid, radius, label }
  private supernodeContainer!: PIXI.Container;
  private supernodeGraphics!: PIXI.Graphics;
  private supernodeLabels: Map<number, PIXI.Sprite> = new Map();
  private supernodes: Map<
    number,
    { community: number; label: string; count: number; dominantType: string; x: number; y: number; radius: number }
  > = new Map();
  private communityInfo: CommunityInfo[] = [];
  private onSupernodeSelectCallback?: (communityId: number) => void;
  private hoveredSupernode: number | null = null;
  private nodeCommunity: Map<string, number> = new Map();

  private needsEdgeRedraw = true;
  private lastSettled = false;
  private lastLabelBand = -1;

  private containerWidth = 0;
  private containerHeight = 0;

  constructor() {
    this.onPointerMove = this.onPointerMove.bind(this);
  }

  async init(container: HTMLDivElement): Promise<void> {
    this.container = container;
    this.containerWidth = container.clientWidth;
    this.containerHeight = container.clientHeight;

    this.app = new PIXI.Application();
    await this.app.init({
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundAlpha: 0,
      antialias: true,
      preference: "webgl",
      resizeTo: container,
    });

    container.appendChild(this.app.canvas);
    this.app.canvas.classList.add("grabbable");

    this.viewport = new PIXI.Container();
    this.viewport.position.set(container.clientWidth / 2, container.clientHeight / 2);
    this.app.stage.addChild(this.viewport);

    // Shared textures
    this.haloTexture = this.bakeHaloTexture();
    this.shapeTextures = bakeShapeTextures(this.app);

    // Layer order: edges → nodes → halos → ring → labels
    this.edgesGraphics = new PIXI.Graphics();
    this.viewport.addChild(this.edgesGraphics);

    this.haloSprite = new PIXI.Sprite(this.haloTexture);
    this.haloSprite.blendMode = "add";
    this.haloSprite.anchor.set(0.5);
    this.haloSprite.visible = false;
    this.haloSprite.zIndex = 1;
    this.viewport.addChild(this.haloSprite);

    this.ringGraphics = new PIXI.Graphics();
    this.ringGraphics.zIndex = 2;
    this.viewport.addChild(this.ringGraphics);

    this.labelContainer = new PIXI.Container();
    this.labelContainer.zIndex = 3;
    this.viewport.addChild(this.labelContainer);

    // Supernode layer sits above ring, below labels: disc graphics + labels.
    this.supernodeContainer = new PIXI.Container();
    this.supernodeContainer.zIndex = 2.5;
    this.viewport.addChild(this.supernodeContainer);
    this.supernodeGraphics = new PIXI.Graphics();
    this.supernodeContainer.addChild(this.supernodeGraphics);

    this.setupViewportEvents();
  }

  /** Bake a soft radial-gradient halo (white; tinted via sprite.tint). */
  private bakeHaloTexture(): PIXI.Texture {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.18)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(canvas);
  }

  private setupViewportEvents(): void {
    const canvas = this.app.canvas;

    canvas.addEventListener("pointerdown", (e) => {
      if (this.activeMode === "overview") {
        const rect = this.container.getBoundingClientRect();
        const wx = (e.clientX - rect.left - this.viewport.position.x) / this.zoom;
        const wy = (e.clientY - rect.top - this.viewport.position.y) / this.zoom;
        const hit = this.pickSupernode(wx, wy);
        if (hit !== null) {
          if (this.onSupernodeSelectCallback) this.onSupernodeSelectCallback(hit);
          return;
        }
      }
      if (this.hoveredNodeId) {
        if (this.onNodeSelectCallback) this.onNodeSelectCallback(this.hoveredNodeId);
        return;
      }
      this.isDragging = true;
      this.dragStart.x = e.clientX;
      this.dragStart.y = e.clientY;
      this.viewportStart.x = this.viewport.position.x;
      this.viewportStart.y = this.viewport.position.y;
      canvas.classList.remove("grabbable");
      canvas.classList.add("grabbing");
    });

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", () => {
      if (this.isDragging) {
        this.isDragging = false;
        canvas.classList.remove("grabbing");
        canvas.classList.add("grabbable");
      }
    });

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const zoomFactor = 1.1;
        const rect = this.container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const worldX = (mouseX - this.viewport.position.x) / this.zoom;
        const worldY = (mouseY - this.viewport.position.y) / this.zoom;

        if (e.deltaY < 0) {
          this.zoom = Math.min(PIXI_THEME.zoom.max, this.zoom * zoomFactor);
        } else {
          this.zoom = Math.max(PIXI_THEME.zoom.min, this.zoom / zoomFactor);
        }

        this.viewport.scale.set(this.zoom);
        this.viewport.position.set(mouseX - worldX * this.zoom, mouseY - worldY * this.zoom);
        this.onCameraChanged();
      },
      { passive: false },
    );
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.container.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (this.isDragging) {
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      this.viewport.position.set(this.viewportStart.x + dx, this.viewportStart.y + dy);
      this.onCameraChanged();
      return;
    }

    // Pick node under cursor via spatial hash
    const wx = (sx - this.viewport.position.x) / this.zoom;
    const wy = (sy - this.viewport.position.y) / this.zoom;

    if (this.activeMode === "overview") {
      const hitSuper = this.pickSupernode(wx, wy);
      if (hitSuper !== this.hoveredSupernode) {
        this.hoveredSupernode = hitSuper;
        this.app.canvas.style.cursor = hitSuper !== null ? "pointer" : "grab";
        this.redrawSupernodes();
      }
      return;
    }

    const hit = this.pickNode(wx, wy);
    if (hit !== this.hoveredNodeId) {
      this.hoveredNodeId = hit;
      this.app.canvas.style.cursor = hit ? "pointer" : this.isDragging ? "grabbing" : "grab";
      this.updateRing();
      this.requestLabelRefresh();
    }
  }

  /** Uniform-grid spatial hash lookup. */
  private pickNode(wx: number, wy: number): string | null {
    const cellX = Math.floor(wx / this.cellSize);
    const cellY = Math.floor(wy / this.cellSize);
    const best: { id: string; d2: number } | null = null;

    let closest: { id: string; d2: number } | null = best;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.spatial.get(`${cellX + dx},${cellY + dy}`);
        if (!cell) continue;
        for (const idx of cell.nodes) {
          const node = this.nodesArray[idx];
          if (!node) continue;
          const data = this.nodeData.get(node.id);
          if (!data) continue;
          const nx = data.x;
          const ny = data.y;
          const d2 = (nx - wx) * (nx - wx) + (ny - wy) * (ny - wy);
          const hitRadius = Math.max(data.radius, PIXI_THEME.hitRadius);
          if (d2 <= hitRadius * hitRadius && (!closest || d2 < closest.d2)) {
            closest = { id: node.id, d2 };
          }
        }
      }
    }
    return closest ? closest.id : null;
  }

  private rebuildSpatial(): void {
    this.spatial.clear();
    for (let i = 0; i < this.nodesArray.length; i++) {
      const n = this.nodesArray[i];
      const data = this.nodeData.get(n.id);
      if (!data) continue;
      const cx = Math.floor(data.x / this.cellSize);
      const cy = Math.floor(data.y / this.cellSize);
      const key = `${cx},${cy}`;
      let cell = this.spatial.get(key);
      if (!cell) {
        cell = { nodes: [] };
        this.spatial.set(key, cell);
      }
      cell.nodes.push(i);
    }
  }

  onNodeSelect(callback: (id: string) => void): void {
    this.onNodeSelectCallback = callback;
  }

  setSelection(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
    this.updateRing();
    this.computeExploreSet();
    this.requestLabelRefresh();
  }

  setVisualMode(
    mode: "explore" | "focus" | "impact" | "path" | "topo" | "overview",
    opts?: {
      highlightIds?: string[];
      pathIds?: string[];
      directImpactIds?: string[];
      transitiveImpactIds?: string[];
      topoDepths?: { nodeId: string; depth: number }[];
      topoCycleIds?: string[];
      communities?: CommunityInfo[];
    },
  ): void {
    if (mode === "overview") {
      this.buildSupernodes(opts?.communities || []);
      this.applyNodeState();
      this.needsEdgeRedraw = true;
      return;
    }
    this.clearSupernodes();
    this.activeMode = mode;
    this.highlightedNodeIds = new Set(opts?.highlightIds || []);
    this.pathNodeIds = opts?.pathIds || [];
    this.directImpactIds = new Set(opts?.directImpactIds || []);
    this.transitiveImpactIds = new Set(opts?.transitiveImpactIds || []);
    this.topoDepths = new Map((opts?.topoDepths || []).map((t) => [t.nodeId, t.depth]));
    this.topoCycleIds = new Set(opts?.topoCycleIds || []);

    this.needsEdgeRedraw = true;
    this.applyNodeState();
    this.computeExploreSet();
  }

  onSupernodeSelect(callback: (communityId: number) => void): void {
    this.onSupernodeSelectCallback = callback;
  }

  getMode(): "explore" | "focus" | "impact" | "path" | "topo" | "overview" {
    return this.activeMode;
  }

  updateGraph(nodes: LayoutNode[], edges: LayoutEdge[], visibleTypes: Set<string>): void {
    // Dispose old sprites
    for (const sprite of this.nodeSprites.values()) {
      sprite.destroy();
    }
    this.nodeSprites.clear();
    const prevIds = new Set(this.nodeData.keys());
    this.nodeData.clear();
    this.nodesArray = nodes;
    this.edgesArray = edges;
    this.labelSprites.forEach((s) => s.destroy());
    this.labelSprites.clear();
    this.labelTextureCache.forEach((t) => t.destroy());
    this.labelTextureCache.clear();
    const now = performance.now();

    // Create a sprite per node (shape texture, tinted by type)
    for (const n of nodes) {
      if (!visibleTypes.has(n.type)) continue;
      const theme = getNodeTheme(n.type);
      const texture = this.shapeTextures[theme.shape];
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.tint = theme.dim;
      sprite.alpha = PIXI_THEME.nodeAlpha.rest;
      sprite.position.set(n.x || 0, n.y || 0);
      sprite.scale.set((theme.radius * 2) / texture.width, (theme.radius * 2) / texture.height);
      this.viewport.addChild(sprite);
      this.nodeSprites.set(n.id, sprite);
      this.nodeData.set(n.id, { x: n.x || 0, y: n.y || 0, radius: theme.radius });

      // Newly merged nodes spawn at their position, scale 0→1 (grow-in reveal).
      if (!prevIds.has(n.id)) {
        this.spawnTimes.set(n.id, now);
        sprite.scale.set(0, 0);
      }
    }

    this.rebuildSpatial();
    this.needsEdgeRedraw = true;
    if (this.activeMode !== "overview") this.drawEdges(nodes, edges, visibleTypes);
    this.lastSettled = false;
    this.lastLabelBand = -1;
    this.applyNodeState();
    this.computeExploreSet();
    // Live graph updates while in overview → rebuild supernode layer.
    if (this.activeMode === "overview" && this.communityInfo.length > 0) {
      this.buildSupernodes(this.communityInfo);
    }
  }

  /** Rank nodes by importance (type priority × degree) and keep only the top
   *  `exploreSetCap` rendered in explore mode. Selection/hover always win. */
  private computeExploreSet(): void {
    const priority = PIXI_THEME.label.typePriority as Record<string, number>;
    const ranked = this.nodesArray
      .map((n) => {
        const typeWeight = priority[n.type] ?? 1;
        const degree = (n as { degree?: number }).degree || 0;
        const importance = typeWeight * (1 + degree / 10);
        return { id: n.id, importance };
      })
      .sort((a, b) => b.importance - a.importance);

    const set = new Set<string>();
    const cap = PIXI_THEME.exploreSetCap;
    for (let i = 0; i < Math.min(cap, ranked.length); i++) set.add(ranked[i].id);
    if (this.selectedNodeId) set.add(this.selectedNodeId);
    if (this.hoveredNodeId) set.add(this.hoveredNodeId);
    this.exploreSet = set;
  }

  /** Build the supernode layer for overview mode: one disc per community at
   *  the member centroid, sized by sqrt(count), tinted by dominant type. */
  private buildSupernodes(communities: CommunityInfo[]): void {
    this.clearSupernodes();
    this.activeMode = "overview";
    this.communityInfo = communities;
    const labelCache = this.labelTextureCache;

    this.nodeCommunity.clear();
    for (const n of this.nodesArray) {
      if (n.community !== undefined && n.community !== null) this.nodeCommunity.set(n.id, n.community);
    }

    // Only the largest communities get labels — a 1-node "community" is just a
    // dot, not a constellation.
    const labeled = new Set(
      [...communities]
        .sort((a, b) => b.nodeCount - a.nodeCount)
        .slice(0, PIXI_THEME.supernode.labelCap)
        .map((c) => c.id),
    );

    for (const info of communities) {
      const members = this.nodesArray.filter((n) => n.community === info.id);
      if (members.length === 0) continue;
      let sx = 0;
      let sy = 0;
      for (const m of members) {
        const d = this.nodeData.get(m.id);
        sx += d ? d.x : m.x || 0;
        sy += d ? d.y : m.y || 0;
      }
      const radius = Math.min(
        PIXI_THEME.supernode.maxR,
        PIXI_THEME.supernode.baseR * Math.sqrt(Math.max(info.nodeCount, members.length)),
      );
      this.supernodes.set(info.id, {
        community: info.id,
        label: info.label,
        count: info.nodeCount,
        dominantType: info.dominantType,
        x: sx / members.length,
        y: sy / members.length,
        radius,
      });

      const text = `${info.label} · ${info.nodeCount}`;
      let texture: PIXI.Texture | undefined = undefined;
      if (labeled.has(info.id)) {
        texture = labelCache.get(text);
        if (!texture) {
          const t = new PIXI.Text({
            text,
            style: {
              fontFamily: PIXI_THEME.label.font,
              fontSize: 11,
              fontWeight: "600",
              fill: 0xe6e6eb,
              dropShadow: { color: 0x000000, blur: 4, distance: 0, alpha: 0.9 },
            },
          });
          texture = this.app.renderer.generateTexture(t);
          labelCache.set(text, texture);
          t.destroy();
        }
      }
      if (texture) {
        const sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5, 0);
        this.supernodeContainer.addChild(sprite);
        this.supernodeLabels.set(info.id, sprite);
      }
    }
    this.redrawSupernodes();
  }

  private clearSupernodes(): void {
    for (const s of this.supernodeLabels.values()) s.destroy();
    this.supernodeLabels.clear();
    this.supernodes.clear();
    this.nodeCommunity.clear();
    this.hoveredSupernode = null;
    this.supernodeGraphics.clear();
  }

  /** Discs + bundle edges + label positions. Called on build and on camera/
   *  layout settle so supernodes track their member centroids. */
  private redrawSupernodes(): void {
    const g = this.supernodeGraphics;
    g.clear();

    // Cross-community edges collapse into thin bundles between centroids.
    const byPair = new Map<string, { count: number }>();
    for (const e of this.edgesArray) {
      const srcId = typeof e.source === "string" ? e.source : (e.source as LayoutNode).id;
      const tgtId = typeof e.target === "string" ? e.target : (e.target as LayoutNode).id;
      const s = this.supernodes.get(this.nodeCommunity.get(srcId) ?? -1);
      const t = this.supernodes.get(this.nodeCommunity.get(tgtId) ?? -1);
      if (!s || !t || s.community === t.community) continue;
      const key = s.community < t.community ? `${s.community}|${t.community}` : `${t.community}|${s.community}`;
      const pair = byPair.get(key) || { count: 0 };
      pair.count++;
      byPair.set(key, pair);
    }
    for (const [key, pair] of byPair.entries()) {
      const [a, b] = key.split("|").map(Number);
      const sa = this.supernodes.get(a);
      const sb = this.supernodes.get(b);
      if (!sa || !sb) continue;
      g.moveTo(sa.x, sa.y)
        .lineTo(sb.x, sb.y)
        .stroke({
          color: 0x3a3a44,
          width: PIXI_THEME.supernode.bundleWidth,
          alpha: Math.min(0.14, PIXI_THEME.supernode.bundleAlpha * (1 + Math.log10(pair.count + 1))),
        });
    }

    for (const [id, sn] of this.supernodes.entries()) {
      const theme = getNodeTheme(sn.dominantType);
      const isHover = this.hoveredSupernode === id;
      g.circle(sn.x, sn.y, sn.radius);
      g.fill({
        color: isHover ? theme.bright : theme.base,
        alpha: isHover ? PIXI_THEME.supernode.hoverAlpha : PIXI_THEME.supernode.alpha,
      });
      if (isHover) {
        g.circle(sn.x, sn.y, sn.radius);
        g.stroke({ color: theme.bright, width: 1.5, alpha: 0.8 });
      }
      const label = this.supernodeLabels.get(id);
      if (label) label.position.set(sn.x, sn.y + sn.radius + 5);
    }
  }

  private pickSupernode(wx: number, wy: number): number | null {
    let best: { id: number; d2: number; r: number } | null = null;
    for (const [id, sn] of this.supernodes.entries()) {
      const dx = sn.x - wx;
      const dy = sn.y - wy;
      const d2 = dx * dx + dy * dy;
      const hitR = Math.max(sn.radius, PIXI_THEME.hitRadius);
      if (d2 <= hitR * hitR && (!best || d2 < best.d2)) best = { id, d2, r: hitR };
    }
    return best ? best.id : null;
  }

  /** Draw a tapered story edge as a filled quad (1px → ~2px) toward the target. */
  private drawStoryEdge(x1: number, y1: number, x2: number, y2: number, colorVal: number, alphaVal: number): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    const w1 = 0.7;
    const w2 = 2.1;
    this.edgesGraphics
      .moveTo(x1 + px * w1, y1 + py * w1)
      .lineTo(x2 + px * w2, y2 + py * w2)
      .lineTo(x2 - px * w2, y2 - py * w2)
      .lineTo(x1 - px * w1, y1 - py * w1)
      .closePath()
      .fill({ color: colorVal, alpha: alphaVal });
  }

  drawEdges(nodes: LayoutNode[], edges: LayoutEdge[], visibleTypes: Set<string>): void {
    this.edgesGraphics.clear();
    const nodeMap = new Map<string, LayoutNode>();
    for (const n of nodes) nodeMap.set(n.id, n);

    const theme = PIXI_THEME.edge;

    // Selection emphasis (explore mode): compute 1-hop and 2-hop neighbor sets
    // of the selected node so edges get semantic emphasis by proximity.
    let selHop1: Set<string> | null = null;
    let selHop2: Set<string> | null = null;
    if (this.selectedNodeId && this.activeMode === "explore") {
      const adj = new Map<string, Set<string>>();
      for (const e of edges) {
        const srcId = typeof e.source === "string" ? e.source : (e.source as LayoutNode).id;
        const tgtId = typeof e.target === "string" ? e.target : (e.target as LayoutNode).id;
        if (!adj.has(srcId)) adj.set(srcId, new Set());
        if (!adj.has(tgtId)) adj.set(tgtId, new Set());
        adj.get(srcId)!.add(tgtId);
        adj.get(tgtId)!.add(srcId);
      }
      selHop1 = adj.get(this.selectedNodeId) || new Set();
      selHop2 = new Set();
      for (const nid of selHop1) {
        for (const n2 of adj.get(nid) || []) {
          if (n2 !== this.selectedNodeId && !selHop1.has(n2)) selHop2.add(n2);
        }
      }
    }

    for (const e of edges) {
      const srcId = typeof e.source === "string" ? e.source : (e.source as LayoutNode).id;
      const tgtId = typeof e.target === "string" ? e.target : (e.target as LayoutNode).id;
      const srcNode = nodeMap.get(srcId);
      const tgtNode = nodeMap.get(tgtId);
      if (!srcNode || !tgtNode) continue;
      if (!visibleTypes.has(srcNode.type) || !visibleTypes.has(tgtNode.type)) continue;

      const x1 = srcNode.x || 0;
      const y1 = srcNode.y || 0;
      const x2 = tgtNode.x || 0;
      const y2 = tgtNode.y || 0;

      const semantics = getEdgeSemantics(e.relation);
      let colorVal: number = semantics.color;
      let alphaVal: number = semantics.restAlpha;
      let widthVal: number = semantics.width;

      // Selection proximity emphasis (explore mode): the selected node's 1-hop
      // story edges pop to full semantic color; 2-hop at half; rest ghost.
      if (selHop1 && this.activeMode === "explore") {
        const sIn = srcId === this.selectedNodeId || selHop1.has(srcId);
        const tIn = tgtId === this.selectedNodeId || selHop1.has(tgtId);
        const s2 = selHop2!.has(srcId);
        const t2 = selHop2!.has(tgtId);
        if (sIn && tIn) {
          alphaVal = semantics.family === "story" ? 0.75 : 0.45;
          widthVal = Math.max(widthVal, semantics.family === "story" ? 2 : 1.5);
        } else if ((sIn && t2) || (tIn && s2)) {
          alphaVal = semantics.family === "story" ? 0.4 : 0.2;
        } else {
          alphaVal = 0.05;
        }
      }

      const inPath = this.activeMode === "path";
      const isPathEdge = inPath && this.pathNodeIds.includes(srcId) && this.pathNodeIds.includes(tgtId);

      if (this.activeMode === "focus") {
        const isPath = this.highlightedNodeIds.has(srcId) && this.highlightedNodeIds.has(tgtId);
        alphaVal = isPath ? theme.focus[1] : theme.restAlpha * 0.4;
        if (isPath) {
          colorVal = theme.focus[0];
          widthVal = theme.focus[2];
        }
      } else if (this.activeMode === "impact") {
        const isAffect =
          (this.directImpactIds.has(srcId) || this.transitiveImpactIds.has(srcId) || srcId === this.selectedNodeId) &&
          (this.directImpactIds.has(tgtId) || this.transitiveImpactIds.has(tgtId) || tgtId === this.selectedNodeId);
        alphaVal = isAffect ? theme.impact[1] : theme.restAlpha * 0.4;
        if (isAffect) {
          colorVal = theme.impact[0];
          widthVal = theme.impact[2];
        }
      } else if (this.activeMode === "path") {
        const srcIdx = this.pathNodeIds.indexOf(srcId);
        const tgtIdx = this.pathNodeIds.indexOf(tgtId);
        const pathEdge = srcIdx !== -1 && tgtIdx !== -1 && Math.abs(srcIdx - tgtIdx) === 1;
        alphaVal = pathEdge ? theme.path[1] : theme.restAlpha * 0.4;
        if (pathEdge) {
          colorVal = theme.path[0];
          widthVal = theme.path[2];
        }
      } else if (this.activeMode === "topo") {
        const srcDepth = this.topoDepths.get(srcId);
        const tgtDepth = this.topoDepths.get(tgtId);
        const isTopoEdge = srcDepth !== undefined && tgtDepth !== undefined;
        const isCycleEdge = this.topoCycleIds.has(srcId) && this.topoCycleIds.has(tgtId);
        alphaVal = isTopoEdge ? theme.topo[1] : isCycleEdge ? theme.cycle[1] : theme.restAlpha * 0.4;
        if (isTopoEdge) {
          colorVal = theme.topo[0];
          widthVal = theme.topo[2];
        } else if (isCycleEdge) {
          colorVal = theme.cycle[0];
          widthVal = theme.cycle[2];
        }
      }

      // Weight scales resting alpha (explore only, no selection)
      if (this.activeMode === "explore" && !selHop1 && e.weight) {
        alphaVal = Math.min(theme.weightMaxAlpha, semantics.restAlpha + e.weight * 0.2);
      }

      // Story edges render as tapered quads (direction = flow). Path mode keeps
      // its curved highlight.
      const isStory = semantics.family === "story";
      const emphasized = alphaVal > semantics.restAlpha + 0.05;

      if (isStory && !isPathEdge && (this.activeMode !== "topo" || !this.topoCycleIds.has(srcId))) {
        this.drawStoryEdge(x1, y1, x2, y2, colorVal, alphaVal);
        if (emphasized) {
          // small arrowhead at the target for emphasized story edges
          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const tipLen = 6;
          const wing = 3.5;
          this.edgesGraphics
            .moveTo(x2, y2)
            .lineTo(x2 - ux * tipLen + -uy * wing, y2 - uy * tipLen + ux * wing)
            .lineTo(x2 - ux * tipLen + uy * wing, y2 - uy * tipLen - ux * wing)
            .closePath()
            .fill({ color: colorVal, alpha: alphaVal });
        }
      } else if (isPathEdge && this.activeMode === "path") {
        // slight curve for the highlighted path edge
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2 - Math.abs(x2 - x1) * 0.15;
        this.edgesGraphics.moveTo(x1, y1);
        this.edgesGraphics.quadraticCurveTo(midX, midY, x2, y2);
        this.edgesGraphics.stroke({ color: colorVal, width: widthVal, alpha: alphaVal });
      } else {
        this.edgesGraphics.moveTo(x1, y1);
        this.edgesGraphics.lineTo(x2, y2);
        this.edgesGraphics.stroke({ color: colorVal, width: widthVal, alpha: alphaVal });
      }
    }
  }

  /** Per-frame: move sprites only (no geometry rebuild). Rebuild spatial hash lazily. */
  updateNodesPositions(nodes: LayoutNode[], edges: LayoutEdge[], visibleTypes: Set<string>, settled = false): void {
    const inOverview = this.activeMode === "overview";

    // During animation, positions move every tick → redraw edges + rebuild spatial.
    if (!settled || this.needsEdgeRedraw) {
      if (!inOverview) this.drawEdges(nodes, edges, visibleTypes);
      if (settled) this.needsEdgeRedraw = false;
    }

    const vpX = this.viewport.position.x;
    const vpY = this.viewport.position.y;
    const zoom = this.zoom;
    const margin = PIXI_THEME.cullMargin;
    const minWx = (-vpX - margin) / zoom;
    const maxWx = (this.containerWidth - vpX + margin) / zoom;
    const minWy = (-vpY - margin) / zoom;
    const maxWy = (this.containerHeight - vpY + margin) / zoom;
    const now = performance.now();

    for (const n of nodes) {
      const sprite = this.nodeSprites.get(n.id);
      const data = this.nodeData.get(n.id);
      if (!sprite || !data) continue;

      const nx = n.x || 0;
      const ny = n.y || 0;
      data.x = nx;
      data.y = ny;
      sprite.position.set(nx, ny);

      // LOD tier: hide detail types (functions, agent messages) when zoomed out.
      // Explore mode additionally caps to the importance set so the overview
      // stays clean at thousands of nodes. Overview mode replaces all node
      // sprites with the supernode layer.
      const onScreen = nx >= minWx && nx <= maxWx && ny >= minWy && ny <= maxWy;
      const inExploreSet =
        this.activeMode === "explore"
          ? this.exploreSet.has(n.id) || n.id === this.hoveredNodeId || n.id === this.selectedNodeId
          : true;
      sprite.visible = !inOverview && onScreen && zoom >= getLodMinZoom(n.type) && inExploreSet;

      // Spawn-at-parent reveal: scale 0→1 with ease-out-back over dur.expand
      const spawnStart = this.spawnTimes.get(n.id);
      if (spawnStart !== undefined) {
        const t = (now - spawnStart) / PIXI_THEME.dur.expand;
        if (t >= 1) {
          this.spawnTimes.delete(n.id);
        } else {
          const e = 1 - (1 - t) ** 3;
          const theme = getNodeTheme(n.type);
          const base = (theme.radius * 2) / sprite.texture.width;
          const s = base * e;
          sprite.scale.set(s, s);
        }
      }
    }

    if (!settled || this.lastSettled !== settled) {
      this.rebuildSpatial();
    }
    this.lastSettled = settled;

    if (inOverview) {
      // Keep supernode discs tracking member centroids while layout animates
      // (skipped once settled — discs are static between graph changes).
      if (!settled || this.lastSettled !== settled) {
        const sums = new Map<number, { x: number; y: number; count: number }>();
        for (const n of this.nodesArray) {
          if (n.community === undefined || n.community === null) continue;
          const d = this.nodeData.get(n.id);
          const acc = sums.get(n.community) || { x: 0, y: 0, count: 0 };
          acc.x += d ? d.x : n.x || 0;
          acc.y += d ? d.y : n.y || 0;
          acc.count++;
          sums.set(n.community, acc);
        }
        for (const [id, sn] of this.supernodes.entries()) {
          const acc = sums.get(id);
          if (acc && acc.count > 0) {
            sn.x = acc.x / acc.count;
            sn.y = acc.y / acc.count;
          }
        }
        this.redrawSupernodes();
      }
    } else if (!settled) {
      this.applyNodeState();
    }

    // Labels + ring only refresh on discrete changes, handled in tick hooks via
    // requestLabelRefresh() / updateRing() to avoid per-frame cost.
  }

  /** Apply hover/selection/mode styling to all sprites (cheap: tint + alpha only). */
  private applyNodeState(): void {
    const theme = PIXI_THEME;
    for (const [id, sprite] of this.nodeSprites.entries()) {
      const n = this.nodesArray.find((x) => x.id === id);
      if (!n) continue;
      const t = getNodeTheme(n.type);

      let tint: number = t.dim;
      let alpha: number = theme.nodeAlpha.rest;

      if (id === this.hoveredNodeId || id === this.selectedNodeId) {
        tint = t.bright;
        alpha = 1;
      } else if (this.activeMode === "focus" && !this.highlightedNodeIds.has(id)) {
        alpha = theme.nodeAlpha.ghost;
      } else if (this.activeMode === "impact" && id !== this.selectedNodeId) {
        alpha = this.directImpactIds.has(id) || this.transitiveImpactIds.has(id) ? alpha : theme.nodeAlpha.ghost;
      } else if (this.activeMode === "path" && !this.pathNodeIds.includes(id)) {
        alpha = theme.nodeAlpha.ghost;
      } else if (this.activeMode === "topo" && !this.topoDepths.has(id) && !this.topoCycleIds.has(id)) {
        alpha = theme.nodeAlpha.ghost;
      }

      sprite.tint = tint;
      sprite.alpha = alpha;
    }
  }

  /** Position the single halo + ring sprite at the hovered/selected node. */
  private updateRing(): void {
    if (this.activeMode === "overview") {
      this.haloSprite.visible = false;
      this.ringGraphics.clear();
      return;
    }
    const id = this.hoveredNodeId || this.selectedNodeId;
    const sprite = id ? this.nodeSprites.get(id) : null;
    if (!id || !sprite) {
      this.haloSprite.visible = false;
      this.ringGraphics.clear();
      return;
    }

    const theme = getNodeTheme(
      id.startsWith("cluster:") ? "cluster" : this.nodesArray.find((n) => n.id === id)?.type || "default",
    );
    const isHover = id === this.hoveredNodeId;
    const isSelected = id === this.selectedNodeId;
    const useAccent = isSelected;
    const colorVal = isSelected ? theme.bright : theme.base;

    this.haloSprite.visible = true;
    this.haloSprite.tint = useAccent ? theme.bright : theme.base;
    this.haloSprite.alpha = isSelected ? PIXI_THEME.halo.selAlpha : PIXI_THEME.halo.hoverAlpha;
    const haloScale = (theme.radius * 5) / this.haloTexture.width;
    this.haloSprite.position.set(sprite.x, sprite.y);
    this.haloSprite.scale.set(haloScale);

    this.ringGraphics.clear();
    const w = isSelected ? PIXI_THEME.ring.selW : PIXI_THEME.ring.hoverW;
    const a = isSelected ? PIXI_THEME.ring.selA : PIXI_THEME.ring.hoverA;
    this.ringGraphics.circle(0, 0, theme.radius + 3);
    this.ringGraphics.stroke({ color: colorVal, width: w, alpha: a });
    this.ringGraphics.position.set(sprite.x, sprite.y);
    void isHover;
  }

  /**
   * Labels: capped, priority-ranked, pre-rendered textures. Refreshed only on
   * settle transitions, zoom-band crossings, and selection/hover changes.
   */
  requestLabelRefresh(): void {
    const zoomBand = this.computeLabelBand();
    if (zoomBand !== this.lastLabelBand) {
      this.lastLabelBand = zoomBand;
      this.refreshLabels();
    }
  }

  private computeLabelBand(): number {
    if (this.zoom < PIXI_THEME.label.lodZooms[0]) return 0;
    if (this.zoom < PIXI_THEME.label.lodZooms[1]) return 1;
    return 2;
  }

  private refreshLabels(): void {
    if (this.activeMode === "overview") return;
    for (const s of this.labelSprites.values()) s.destroy();
    this.labelSprites.clear();

    const band = this.lastLabelBand;
    if (band === 0 || !this.lastSettled) return;

    // Score visible nodes; always include hovered/selected
    const candidates: { node: LayoutNode; score: number }[] = [];
    const priority = PIXI_THEME.label.typePriority as Record<string, number>;
    for (const n of this.nodesArray) {
      const sprite = this.nodeSprites.get(n.id);
      if (!sprite || !sprite.visible) continue;
      if (n.id === this.hoveredNodeId || n.id === this.selectedNodeId) {
        candidates.push({ node: n, score: Number.POSITIVE_INFINITY });
        continue;
      }
      const typeWeight = priority[n.type] ?? 1;
      if (band === 1 && typeWeight < 3) continue;
      const degree = (n as any).degree || 0;
      const data = this.nodeData.get(n.id);
      const screenRadius = data ? data.radius * this.zoom : 0;
      if (screenRadius < 6) continue;
      candidates.push({ node: n, score: typeWeight * (1 + degree / 10) * (0.5 + this.zoom) });
    }

    candidates.sort((a, b) => b.score - a.score);
    const budget = Math.min(PIXI_THEME.label.budgetMax, Math.round(PIXI_THEME.label.budgetPerZoom * this.zoom));
    for (let i = 0; i < Math.min(budget, candidates.length); i++) {
      const { node } = candidates[i];
      this.addLabelSprite(node);
    }
  }

  private addLabelSprite(node: LayoutNode): void {
    let texture = this.labelTextureCache.get(node.label);
    if (!texture) {
      const t = new PIXI.Text({
        text: node.label,
        style: {
          fontFamily: PIXI_THEME.label.font,
          fontSize: PIXI_THEME.label.size,
          fill: PIXI_THEME.label.fill,
          dropShadow: { color: 0x000000, blur: 4, distance: 0, alpha: 0.9 },
        },
      });
      texture = this.app.renderer.generateTexture(t);
      this.labelTextureCache.set(node.label, texture);
      t.destroy();
    }
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0);
    const data = this.nodeData.get(node.id);
    sprite.position.set(data?.x || 0, (data?.y || 0) + 12);
    this.labelContainer.addChild(sprite);
    this.labelSprites.set(node.id, sprite);
  }

  /** Rebuild label sprites after positions settle or camera moves. */
  private onCameraChanged(): void {
    this.requestLabelRefresh();
  }

  /** Frame the whole graph. */
  fitToBounds(nodes: LayoutNode[]): void {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const n of nodes) {
      const nx = n.x || 0;
      const ny = n.y || 0;
      if (nx < minX) minX = nx;
      if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny;
      if (ny > maxY) maxY = ny;
    }
    if (minX === Number.POSITIVE_INFINITY) return;

    const pad = PIXI_THEME.zoom.fitPad;
    const graphW = maxX - minX || 1;
    const graphH = maxY - minY || 1;
    const zoom = Math.min((this.containerWidth - pad * 2) / graphW, (this.containerHeight - pad * 2) / graphH, 1.5);

    this.zoom = Math.max(PIXI_THEME.zoom.min, zoom);
    this.viewport.scale.set(this.zoom);
    this.viewport.position.set(
      this.containerWidth / 2 - ((minX + maxX) / 2) * this.zoom,
      this.containerHeight / 2 - ((minY + maxY) / 2) * this.zoom,
    );
    this.onCameraChanged();
  }

  flyToNode(nodeId: string, nodes: LayoutNode[]): void {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const targetX = node.x || 0;
    const targetY = node.y || 0;
    const startX = this.viewport.position.x;
    const startY = this.viewport.position.y;
    const startZoom = this.zoom;
    const destX = this.container.clientWidth / 2 - targetX * 1.5;
    const destY = this.container.clientHeight / 2 - targetY * 1.5;
    const destZoom = 1.5;

    let progress = 0;
    const animTicker = (ticker: PIXI.Ticker) => {
      progress += 0.05 * ticker.deltaTime * (1000 / PIXI_THEME.dur.fly);
      if (progress >= 1.0) {
        this.viewport.position.set(destX, destY);
        this.zoom = destZoom;
        this.viewport.scale.set(this.zoom);
        this.app.ticker.remove(animTicker);
        this.onCameraChanged();
      } else {
        const ease = 1 - (1 - progress) ** 3;
        this.viewport.position.set(startX + (destX - startX) * ease, startY + (destY - startY) * ease);
        this.zoom = startZoom + (destZoom - startZoom) * ease;
        this.viewport.scale.set(this.zoom);
      }
      this.requestRender();
    };
    this.app.ticker.add(animTicker);
  }

  /** Zoom the camera toward the canvas center by `factor` (>1 in, <1 out). */
  zoomAt(factor: number): void {
    const rect = this.container.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const wx = (mx - this.viewport.position.x) / this.zoom;
    const wy = (my - this.viewport.position.y) / this.zoom;
    this.zoom = Math.max(PIXI_THEME.zoom.min, Math.min(PIXI_THEME.zoom.max, this.zoom * factor));
    this.viewport.scale.set(this.zoom);
    this.viewport.position.set(mx - wx * this.zoom, my - wy * this.zoom);
    this.onCameraChanged();
  }

  /** Current camera transform, for overlays (minimap). */
  getCamera(): { x: number; y: number; zoom: number; width: number; height: number } {
    return {
      x: this.viewport.position.x,
      y: this.viewport.position.y,
      zoom: this.zoom,
      width: this.containerWidth,
      height: this.containerHeight,
    };
  }

  /** Reset the camera to frame the whole graph. */
  resetFit(): void {
    this.fitToBounds(this.nodesArray);
  }

  requestRender(): void {
    if (this.app) this.app.render();
  }

  resize(): void {
    if (this.app) {
      this.containerWidth = this.container.clientWidth;
      this.containerHeight = this.container.clientHeight;
      this.app.resize();
      this.requestRender();
    }
  }

  dispose(): void {
    if (this.app) {
      window.removeEventListener("pointermove", this.onPointerMove);
      this.clearSupernodes();
      this.app.destroy(true, { children: true, texture: true });
    }
  }
}
