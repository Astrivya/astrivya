import * as PIXI from "pixi.js";
import type { LayoutEdge, LayoutNode } from "../layout/force-layout";

// Curated aesthetic theme hex colors
const NODE_COLORS: Record<string, number> = {
  workspace: 0x6366f1, // Indigo
  folder: 0x8b5cf6, // Violet
  file: 0x3b82f6, // Blue
  function: 0x10b981, // Emerald
  class: 0xf59e0b, // Amber
  interface: 0x06b6d4, // Cyan
  document: 0xec4899, // Pink
  dependency: 0x6b7280, // Gray
  adr: 0xef4444, // Red
  task: 0xf97316, // Orange
  goal: 0xa855f7, // Purple
  person: 0xe11d48, // Rose
  api: 0x2563eb, // Blue-600
  default: 0x64748b, // Slate
};

interface Particle {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  progress: number; // 0 to 1
  speed: number;
}

export class PixiRenderer {
  app!: PIXI.Application;
  private container!: HTMLDivElement;
  private viewport!: PIXI.Container;
  private edgesGraphics!: PIXI.Graphics;

  private nodeContainers: Map<string, PIXI.Container> = new Map();
  private particles: Particle[] = [];
  private particlesGraphics!: PIXI.Graphics;
  private particleTickerActive = false;

  // Interactions State
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private viewportStart = { x: 0, y: 0 };
  private zoom = 1.0;

  // Selected & Hovered IDs
  private selectedNodeId: string | null = null;
  private hoveredNodeId: string | null = null;

  // Active Modes visual configurations
  private activeMode: "explore" | "focus" | "impact" | "path" | "topo" = "explore";
  private highlightedNodeIds: Set<string> = new Set();
  private pathNodeIds: string[] = [];

  // Impact mapping
  private directImpactIds: Set<string> = new Set();
  private transitiveImpactIds: Set<string> = new Set();

  // Topo mapping
  private topoDepths = new Map<string, number>();
  private topoCycleIds = new Set<string>();
  private maxTopoDepth = 0;

  // Performance
  private needsEdgeRedraw = true;
  private textsDestroyed = false;
  private containerWidth = 0;
  private containerHeight = 0;

  // Callbacks
  private onNodeSelectCallback?: (id: string) => void;

  private animateParticlesBound = () => {
    this.animateParticles(this.app.ticker.deltaTime);
  };

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
      resizeTo: container,
    });

    container.appendChild(this.app.canvas);
    this.app.canvas.classList.add("grabbable");

    // Add viewport container
    this.viewport = new PIXI.Container();
    this.viewport.position.set(container.clientWidth / 2, container.clientHeight / 2);
    this.app.stage.addChild(this.viewport);

    // Setup layers
    this.edgesGraphics = new PIXI.Graphics();
    this.viewport.addChild(this.edgesGraphics);

    this.particlesGraphics = new PIXI.Graphics();
    this.viewport.addChild(this.particlesGraphics);

    this.setupViewportEvents();

    // Setup animation ticker — lightweight per-frame culling + LOD
    this.app.ticker.add(() => {
      this.updateLOD();
      this.cullNodes();
    });
  }

  private setupViewportEvents(): void {
    const canvas = this.app.canvas;

    canvas.addEventListener("mousedown", (e) => {
      // Don't drag if clicking directly on a node
      if (this.hoveredNodeId) return;
      this.isDragging = true;
      this.dragStart.x = e.clientX;
      this.dragStart.y = e.clientY;
      this.viewportStart.x = this.viewport.position.x;
      this.viewportStart.y = this.viewport.position.y;
      canvas.classList.remove("grabbable");
      canvas.classList.add("grabbing");
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      this.viewport.position.set(this.viewportStart.x + dx, this.viewportStart.y + dy);
    });

    window.addEventListener("mouseup", () => {
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
        const mouseX = e.clientX - this.container.getBoundingClientRect().left;
        const mouseY = e.clientY - this.container.getBoundingClientRect().top;

        // Calculate world coordinates of cursor before zoom
        const worldX = (mouseX - this.viewport.position.x) / this.zoom;
        const worldY = (mouseY - this.viewport.position.y) / this.zoom;

        if (e.deltaY < 0) {
          this.zoom = Math.min(4.0, this.zoom * zoomFactor);
        } else {
          this.zoom = Math.max(0.08, this.zoom / zoomFactor);
        }

        this.viewport.scale.set(this.zoom);

        // Adjust viewport position so cursor point remains static in screen space
        this.viewport.position.set(mouseX - worldX * this.zoom, mouseY - worldY * this.zoom);
      },
      { passive: false },
    );
  }

  onNodeSelect(callback: (id: string) => void): void {
    this.onNodeSelectCallback = callback;
  }

  setSelection(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
    this.requestRender();
  }

  setVisualMode(
    mode: "explore" | "focus" | "impact" | "path" | "topo",
    opts?: {
      highlightIds?: string[];
      pathIds?: string[];
      directImpactIds?: string[];
      transitiveImpactIds?: string[];
      topoDepths?: { nodeId: string; depth: number }[];
      topoCycleIds?: string[];
      maxTopoDepth?: number;
    },
  ): void {
    this.activeMode = mode;
    this.highlightedNodeIds = new Set(opts?.highlightIds || []);
    this.pathNodeIds = opts?.pathIds || [];
    this.directImpactIds = new Set(opts?.directImpactIds || []);
    this.transitiveImpactIds = new Set(opts?.transitiveImpactIds || []);

    if (mode === "topo") {
      this.topoDepths = new Map((opts?.topoDepths || []).map((t) => [t.nodeId, t.depth]));
      this.topoCycleIds = new Set(opts?.topoCycleIds || []);
      this.maxTopoDepth = opts?.maxTopoDepth ?? 0;
    } else {
      this.topoDepths = new Map();
      this.topoCycleIds = new Set();
      this.maxTopoDepth = 0;
    }

    if (mode === "path" && this.pathNodeIds.length > 1) {
      this.initParticles();
      if (!this.particleTickerActive) {
        this.particleTickerActive = true;
        this.app.ticker.add(this.animateParticlesBound);
      }
    } else {
      this.particles = [];
      if (this.particleTickerActive) {
        this.particleTickerActive = false;
        this.app.ticker.remove(this.animateParticlesBound);
      }
    }

    this.needsEdgeRedraw = true;
    this.requestRender();
  }

  updateGraph(nodes: LayoutNode[], edges: LayoutEdge[], visibleTypes: Set<string>): void {
    this.textsDestroyed = false;
    this.needsEdgeRedraw = true;
    // Remove existing nodes
    for (const container of this.nodeContainers.values()) {
      this.viewport.removeChild(container);
      container.destroy({ children: true });
    }
    this.nodeContainers.clear();

    // Render nodes
    for (const n of nodes) {
      if (!visibleTypes.has(n.type)) continue;

      const nodeContainer = new PIXI.Container();
      nodeContainer.position.set(n.x || 0, n.y || 0);

      // Node base size
      const radius = n.type === "file" ? 14 : n.type === "function" ? 8 : 11;
      const colorHex = NODE_COLORS[n.type] || NODE_COLORS.default;

      // Shape Graphics based on node type
      const graphics = new PIXI.Graphics();
      if (n.type === "task") {
        graphics.moveTo(0, -radius);
        graphics.lineTo(radius, radius * 0.8);
        graphics.lineTo(-radius, radius * 0.8);
        graphics.closePath();
      } else if (n.type === "agent" || n.type === "agent_action") {
        const sides = 6;
        for (let i = 0; i < sides; i++) {
          const angle = (i / sides) * Math.PI * 2;
          const hx = radius * Math.cos(angle);
          const hy = radius * Math.sin(angle);
          if (i === 0) graphics.moveTo(hx, hy);
          else graphics.lineTo(hx, hy);
        }
        graphics.closePath();
      } else {
        graphics.circle(0, 0, radius);
      }
      graphics.fill({ color: colorHex });

      // Border outline
      graphics.stroke({ color: 0xffffff, width: 1.5, alpha: 0.5 });

      nodeContainer.addChild(graphics);

      // Text label description
      const labelText = new PIXI.Text({
        text: n.label,
        style: {
          fontFamily: "Outfit",
          fontSize: n.type === "file" ? 11 : 9,
          fill: 0xf8fafc,
          stroke: { color: 0x07050f, width: 3 },
        },
      });
      labelText.anchor.set(0.5, -1.5);
      nodeContainer.addChild(labelText);

      // Node interaction behaviors
      nodeContainer.eventMode = "static";
      nodeContainer.cursor = "pointer";

      nodeContainer.on("pointerover", () => {
        this.hoveredNodeId = n.id;
        this.app.canvas.style.cursor = "pointer";
        this.requestRender();
      });

      nodeContainer.on("pointerout", () => {
        this.hoveredNodeId = null;
        this.app.canvas.style.cursor = this.isDragging ? "grabbing" : "grab";
        this.requestRender();
      });

      nodeContainer.on("pointerdown", () => {
        if (this.onNodeSelectCallback) {
          this.onNodeSelectCallback(n.id);
        }
      });

      this.viewport.addChild(nodeContainer);
      this.nodeContainers.set(n.id, nodeContainer);
    }

    this.needsEdgeRedraw = true;
    this.drawEdges(nodes, edges, visibleTypes);
  }

  // Draw edges between active coordinate locations
  drawEdges(nodes: LayoutNode[], edges: LayoutEdge[], visibleTypes: Set<string>): void {
    this.edgesGraphics.clear();

    const nodeMap = new Map<string, LayoutNode>();
    for (const n of nodes) {
      nodeMap.set(n.id, n);
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

      // Edge style configurations based on visual modes
      let colorVal = 0x475569; // default gray
      let alphaVal = 0.25;
      let widthVal = 1;

      if (this.activeMode === "focus") {
        const isPath = this.highlightedNodeIds.has(srcId) && this.highlightedNodeIds.has(tgtId);
        alphaVal = isPath ? 0.6 : 0.05;
        if (isPath) {
          colorVal = 0x8b5cf6; // focused Violet links
          widthVal = 1.5;
        }
      } else if (this.activeMode === "impact") {
        const isAffect =
          (this.directImpactIds.has(srcId) || this.transitiveImpactIds.has(srcId) || srcId === this.selectedNodeId) &&
          (this.directImpactIds.has(tgtId) || this.transitiveImpactIds.has(tgtId) || tgtId === this.selectedNodeId);
        alphaVal = isAffect ? 0.7 : 0.05;
        if (isAffect) {
          colorVal = 0xef4444; // impacted links show Red
          widthVal = 2.0;
        }
      } else if (this.activeMode === "path") {
        const srcIdx = this.pathNodeIds.indexOf(srcId);
        const tgtIdx = this.pathNodeIds.indexOf(tgtId);
        const isPathEdge = srcIdx !== -1 && tgtIdx !== -1 && Math.abs(srcIdx - tgtIdx) === 1;

        alphaVal = isPathEdge ? 0.8 : 0.05;
        if (isPathEdge) {
          colorVal = 0xf59e0b; // path trace links show Amber
          widthVal = 2.5;
        }
      } else if (this.activeMode === "topo") {
        const srcDepth = this.topoDepths.get(srcId);
        const tgtDepth = this.topoDepths.get(tgtId);
        const isTopoEdge = srcDepth !== undefined && tgtDepth !== undefined;
        const isCycleEdge = this.topoCycleIds.has(srcId) && this.topoCycleIds.has(tgtId);
        alphaVal = isTopoEdge ? 0.5 : isCycleEdge ? 0.5 : 0.05;
        if (isTopoEdge) {
          colorVal = 0x6366f1;
          widthVal = 1.5;
        } else if (isCycleEdge) {
          colorVal = 0xef4444;
          widthVal = 1.5;
        }
      }

      this.edgesGraphics.moveTo(x1, y1);
      this.edgesGraphics.lineTo(x2, y2);
      this.edgesGraphics.stroke({ color: colorVal, width: widthVal, alpha: alphaVal });
    }
  }

  // Update dynamic Node coordinates positions calculated by physics engine
  updateNodesPositions(nodes: LayoutNode[], edges: LayoutEdge[], visibleTypes: Set<string>, settled = false): void {
    // Compute viewport bounds for culling
    const vpX = this.viewport.position.x;
    const vpY = this.viewport.position.y;
    const zoom = this.zoom;
    const cullMargin = 100;
    const minWx = (-vpX - cullMargin) / zoom;
    const maxWx = (this.containerWidth - vpX + cullMargin) / zoom;
    const minWy = (-vpY - cullMargin) / zoom;
    const maxWy = (this.containerHeight - vpY + cullMargin) / zoom;

    for (const n of nodes) {
      const container = this.nodeContainers.get(n.id);
      if (!container) continue;

      container.position.set(n.x || 0, n.y || 0);

      // Cull: skip full render for off-screen nodes
      const nx = n.x || 0;
      const ny = n.y || 0;
      const isOnScreen = nx >= minWx && nx <= maxWx && ny >= minWy && ny <= maxWy;
      container.visible = isOnScreen;
      if (!isOnScreen) continue;

      // When settled, skip graphics redraw — just update position and opacity
      if (settled) {
        // Only update opacity for dimmed nodes
        let opacityVal = 1.0;
        if (this.activeMode === "focus" && !this.highlightedNodeIds.has(n.id)) {
          opacityVal = 0.08;
        } else if (
          this.activeMode === "impact" &&
          n.id !== this.selectedNodeId &&
          !this.directImpactIds.has(n.id) &&
          !this.transitiveImpactIds.has(n.id)
        ) {
          opacityVal = 0.08;
        } else if (this.activeMode === "path" && !this.pathNodeIds.includes(n.id)) {
          opacityVal = 0.08;
        } else if (this.activeMode === "topo" && !this.topoDepths.has(n.id) && !this.topoCycleIds.has(n.id)) {
          opacityVal = 0.08;
        }
        container.alpha = opacityVal;
        continue;
      }

      // Full redraw — the node is on screen and layout is still animating
      const ring = container.children[0] as PIXI.Graphics;
      ring.clear();
      const radius = n.type === "file" ? 14 : n.type === "function" ? 8 : 11;
      const colorHex = NODE_COLORS[n.type] || NODE_COLORS.default;

      // Topo mode: override fill color by depth
      let topoColorOverride: number | null = null;
      if (this.activeMode === "topo") {
        if (this.topoCycleIds.has(n.id)) {
          topoColorOverride = 0xef4444;
        } else {
          const depth = this.topoDepths.get(n.id);
          if (depth !== undefined && this.maxTopoDepth > 0) {
            const ratio = depth / this.maxTopoDepth;
            if (ratio < 0.25) topoColorOverride = 0x10b981;
            else if (ratio < 0.5) topoColorOverride = 0x84cc16;
            else if (ratio < 0.75) topoColorOverride = 0xeab308;
            else topoColorOverride = 0xf97316;
          }
        }
      }

      if (n.type === "task") {
        ring.moveTo(0, -radius);
        ring.lineTo(radius, radius * 0.8);
        ring.lineTo(-radius, radius * 0.8);
        ring.closePath();
      } else if (n.type === "agent" || n.type === "agent_action") {
        const sides = 6;
        for (let i = 0; i < sides; i++) {
          const angle = (i / sides) * Math.PI * 2;
          const hx = radius * Math.cos(angle);
          const hy = radius * Math.sin(angle);
          if (i === 0) ring.moveTo(hx, hy);
          else ring.lineTo(hx, hy);
        }
        ring.closePath();
      } else {
        ring.circle(0, 0, radius);
      }
      ring.fill({ color: topoColorOverride !== null ? topoColorOverride : colorHex });

      // Highlight nodes depending on active visual filters
      let glowColor: number | null = null;
      let strokeWidth = 1.5;
      let strokeAlpha = 0.5;

      if (n.id === this.selectedNodeId) {
        glowColor = 0xffffff;
        strokeWidth = 3.5;
        strokeAlpha = 1.0;
      } else if (n.id === this.hoveredNodeId) {
        glowColor = 0xa5b4fc;
        strokeWidth = 2.5;
        strokeAlpha = 0.8;
      } else if (this.activeMode === "focus" && this.highlightedNodeIds.has(n.id)) {
        glowColor = 0x8b5cf6;
        strokeWidth = 2.0;
        strokeAlpha = 0.7;
      } else if (this.activeMode === "impact") {
        if (n.id === this.selectedNodeId) {
          glowColor = 0xef4444;
        } else if (this.directImpactIds.has(n.id)) {
          glowColor = 0xf97316;
        } else if (this.transitiveImpactIds.has(n.id)) {
          glowColor = 0xf59e0b;
        }
        if (glowColor) {
          strokeWidth = 2.5;
          strokeAlpha = 0.8;
        }
      } else if (this.activeMode === "path" && this.pathNodeIds.includes(n.id)) {
        glowColor = 0xf59e0b;
        strokeWidth = 2.5;
        strokeAlpha = 0.9;
      } else if (this.activeMode === "topo") {
        if (this.topoCycleIds.has(n.id)) {
          glowColor = 0xef4444;
          strokeWidth = 3.0;
          strokeAlpha = 0.9;
        } else if (this.topoDepths.has(n.id)) {
          glowColor = 0x6366f1;
          strokeWidth = 2.0;
          strokeAlpha = 0.7;
        }
      }

      ring.stroke({
        color: glowColor !== null ? glowColor : 0xffffff,
        width: strokeWidth,
        alpha: strokeAlpha,
      });

      // Dim unrelated nodes opacity
      let opacityVal = 1.0;
      if (this.activeMode === "focus" && !this.highlightedNodeIds.has(n.id)) {
        opacityVal = 0.08;
      } else if (
        this.activeMode === "impact" &&
        n.id !== this.selectedNodeId &&
        !this.directImpactIds.has(n.id) &&
        !this.transitiveImpactIds.has(n.id)
      ) {
        opacityVal = 0.08;
      } else if (this.activeMode === "path" && !this.pathNodeIds.includes(n.id)) {
        opacityVal = 0.08;
      } else if (this.activeMode === "topo" && !this.topoDepths.has(n.id) && !this.topoCycleIds.has(n.id)) {
        opacityVal = 0.08;
      }
      container.alpha = opacityVal;
    }

    // Only redraw edges when layout is animating or mode just changed
    if (this.needsEdgeRedraw || !settled) {
      this.drawEdges(nodes, edges, visibleTypes);
      if (settled) this.needsEdgeRedraw = false;
    }
  }

  // Shortest path active particle flows
  private initParticles(): void {
    this.particles = [];
    for (let i = 0; i < this.pathNodeIds.length - 1; i++) {
      this.particles.push({
        sourceX: 0,
        sourceY: 0,
        targetX: 0,
        targetY: 0,
        progress: Math.random(), // Stagger start offsets
        speed: 0.015 + Math.random() * 0.01,
      });
    }
  }

  private animateParticles(deltaTime: number): void {
    this.particlesGraphics.clear();
    if (this.activeMode !== "path" || this.pathNodeIds.length < 2) return;

    for (let i = 0; i < this.pathNodeIds.length - 1; i++) {
      const srcId = this.pathNodeIds[i];
      const tgtId = this.pathNodeIds[i + 1];

      const srcContainer = this.nodeContainers.get(srcId);
      const tgtContainer = this.nodeContainers.get(tgtId);

      if (!srcContainer || !tgtContainer) continue;

      const p = this.particles[i] || {
        sourceX: 0,
        sourceY: 0,
        targetX: 0,
        targetY: 0,
        progress: 0,
        speed: 0.02,
      };

      p.sourceX = srcContainer.position.x;
      p.sourceY = srcContainer.position.y;
      p.targetX = tgtContainer.position.x;
      p.targetY = tgtContainer.position.y;

      p.progress += p.speed * deltaTime;
      if (p.progress >= 1.0) {
        p.progress = 0.0;
      }

      this.particles[i] = p;

      // Calculate current location
      const curX = p.sourceX + (p.targetX - p.sourceX) * p.progress;
      const curY = p.sourceY + (p.targetY - p.sourceY) * p.progress;

      // Draw particle dot
      this.particlesGraphics.circle(curX, curY, 4);
      this.particlesGraphics.fill({ color: 0xffffff });
      this.particlesGraphics.stroke({ color: 0xf59e0b, width: 2 });
    }
  }

  // Level of Detail: Fade text labels depending on viewport scale zoom levels
  private updateLOD(): void {
    if (this.zoom < 0.2) {
      // Destroy text objects entirely to free Canvas2D memory
      if (!this.textsDestroyed) {
        this.textsDestroyed = true;
        for (const container of this.nodeContainers.values()) {
          if (container.children.length > 1) {
            const label = container.children[1] as PIXI.Text;
            container.removeChild(label);
            label.destroy();
          }
        }
      }
      return;
    }
    this.textsDestroyed = false;

    for (const [id, container] of this.nodeContainers.entries()) {
      const label = container.children[1] as PIXI.Text;
      if (!label) continue;

      // LOD zoom thresholds:
      if (this.zoom < 0.35) {
        label.visible = false;
      } else if (this.zoom < 0.65) {
        // Only show files/classes labels at mid range zoom
        const type = id.split("::")[0];
        label.visible = type === "file" || type === "workspace" || type === "class";
      } else {
        label.visible = true;
      }
    }
  }

  // Lightweight per-frame visibility culling for settled layout
  private cullNodes(): void {
    const vpX = this.viewport.position.x;
    const vpY = this.viewport.position.y;
    const zoom = this.zoom;
    const cullMargin = 100;
    const minWx = (-vpX - cullMargin) / zoom;
    const maxWx = (this.containerWidth - vpX + cullMargin) / zoom;
    const minWy = (-vpY - cullMargin) / zoom;
    const maxWy = (this.containerHeight - vpY + cullMargin) / zoom;

    for (const container of this.nodeContainers.values()) {
      const nx = container.position.x;
      const ny = container.position.y;
      container.visible = nx >= minWx && nx <= maxWx && ny >= minWy && ny <= maxWy;
    }
  }

  flyToNode(nodeId: string, nodes: LayoutNode[]): void {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const targetX = node.x || 0;
    const targetY = node.y || 0;

    const startX = this.viewport.position.x;
    const startY = this.viewport.position.y;
    const startZoom = this.zoom;

    // Fly camera view target details
    const destX = this.container.clientWidth / 2 - targetX * 1.5;
    const destY = this.container.clientHeight / 2 - targetY * 1.5;
    const destZoom = 1.5;

    let progress = 0;
    const animTicker = (ticker: PIXI.Ticker) => {
      progress += 0.05 * ticker.deltaTime;
      if (progress >= 1.0) {
        this.viewport.position.set(destX, destY);
        this.zoom = destZoom;
        this.viewport.scale.set(this.zoom);
        this.app.ticker.remove(animTicker);
      } else {
        // Smooth cubic easing
        const ease = 1 - (1 - progress) ** 3;
        const x = startX + (destX - startX) * ease;
        const y = startY + (destY - startY) * ease;
        const z = startZoom + (destZoom - startZoom) * ease;

        this.viewport.position.set(x, y);
        this.zoom = z;
        this.viewport.scale.set(this.zoom);
      }
      this.requestRender();
    };

    this.app.ticker.add(animTicker);
  }

  requestRender(): void {
    if (this.app) {
      this.app.render();
    }
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
      this.app.destroy(true, { children: true, texture: true });
    }
  }
}
