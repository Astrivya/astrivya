import * as d3 from "d3-force";
import type { AkgEdge, AkgNode } from "../api/akg-client";

export interface LayoutNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  community?: number;
  churnRate?: number;
  lastModified?: number;
  contributorCount?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface LayoutEdge {
  source: string | LayoutNode;
  target: string | LayoutNode;
  relation: string;
  weight?: number;
}

export class ForceLayout {
  private simulation: d3.Simulation<LayoutNode, LayoutEdge>;
  private nodes: LayoutNode[] = [];
  private edges: LayoutEdge[] = [];
  private onTickCallback?: () => void;
  private settled = false;

  constructor() {
    this.simulation = d3
      .forceSimulation<LayoutNode, LayoutEdge>()
      .force(
        "link",
        d3
          .forceLink<LayoutNode, LayoutEdge>()
          .id((d) => d.id)
          .distance(80),
      )
      .force("charge", d3.forceManyBody().strength(-200).distanceMax(400))
      .force("collide", d3.forceCollide().radius(35))
      .force("center", d3.forceCenter(0, 0))
      .force("cluster", this.forceCommunityCentroid())
      .alphaDecay(0.05);

    this.simulation.on("tick", () => {
      if (this.onTickCallback) this.onTickCallback();
      if (this.simulation.alpha() < 0.001) {
        this.settled = true;
        this.simulation.stop();
      } else {
        this.settled = false;
      }
    });
  }

  isSettled(): boolean {
    return this.settled;
  }

  setGraph(nodes: AkgNode[], edges: AkgEdge[]): void {
    // Map to LayoutNodes preserving existing coordinates if layout is already running
    const coordMap = new Map<string, { x: number; y: number }>();
    for (const n of this.nodes) {
      if (n.x !== undefined && n.y !== undefined) {
        coordMap.set(n.id, { x: n.x, y: n.y });
      }
    }

    this.nodes = nodes.map((n) => {
      const coords = coordMap.get(n.id);
      return {
        id: n.id,
        label: n.label,
        type: n.type,
        community: n.community,
        churnRate: n.churnRate,
        lastModified: n.lastModified,
        contributorCount: n.contributorCount,
        x: coords ? coords.x : Math.random() * 400 - 200,
        y: coords ? coords.y : Math.random() * 400 - 200,
        vx: 0,
        vy: 0,
      };
    });

    this.edges = edges.map((e) => ({
      source: e.source,
      target: e.target,
      relation: e.relation,
      weight: e.weight,
    }));

    this.simulation.nodes(this.nodes);
    const linkForce = this.simulation.force("link") as d3.ForceLink<LayoutNode, LayoutEdge>;
    if (linkForce) {
      linkForce.links(this.edges);
    }

    this.simulation.alpha(1).restart();
  }

  onTick(callback: () => void): void {
    this.onTickCallback = callback;
  }

  getNodes(): LayoutNode[] {
    return this.nodes;
  }

  getEdges(): LayoutEdge[] {
    return this.edges;
  }

  dragNode(id: string, x: number, y: number): void {
    const node = this.nodes.find((n) => n.id === id);
    if (node) {
      node.fx = x;
      node.fy = y;
      this.simulation.alphaTarget(0.3).restart();
    }
  }

  dragEnd(id: string): void {
    const node = this.nodes.find((n) => n.id === id);
    if (node) {
      node.fx = null;
      node.fy = null;
      this.simulation.alphaTarget(0);
    }
  }

  stop(): void {
    this.simulation.stop();
  }

  restart(): void {
    this.settled = false;
    this.simulation.alpha(1).restart();
  }

  // 1. DEFAULT (EXPLORE) MODE
  applyDefaultLayout(): void {
    for (const n of this.nodes) {
      n.fx = null;
      n.fy = null;
    }

    this.simulation
      .force("charge", d3.forceManyBody().strength(-200))
      .force("collide", d3.forceCollide().radius(35))
      .force("center", d3.forceCenter(0, 0))
      .force("cluster", this.forceCommunityCentroid());

    const linkForce = this.simulation.force("link") as d3.ForceLink<LayoutNode, LayoutEdge>;
    if (linkForce) {
      linkForce.distance(80);
    }

    this.simulation.alpha(0.8).restart();
    this.settled = false;
  }

  // 2. FOCUS MODE (Radial constraint around central seed)
  applyFocusLayout(seedId: string): void {
    const centerNode = this.nodes.find((n) => n.id === seedId);
    if (!centerNode) return;

    // Pin focused node at center (0,0)
    centerNode.fx = 0;
    centerNode.fy = 0;

    // Identify distances from seed node in the current subgraph
    const adj = new Map<string, string[]>();
    for (const e of this.edges) {
      const srcId = typeof e.source === "string" ? e.source : (e.source as LayoutNode).id;
      const tgtId = typeof e.target === "string" ? e.target : (e.target as LayoutNode).id;
      if (!adj.has(srcId)) adj.set(srcId, []);
      if (!adj.has(tgtId)) adj.set(tgtId, []);
      adj.get(srcId)!.push(tgtId);
      adj.get(tgtId)!.push(srcId);
    }

    const dists = new Map<string, number>();
    const queue: { id: string; d: number }[] = [{ id: seedId, d: 0 }];
    dists.set(seedId, 0);

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      const neighbors = adj.get(id) || [];
      for (const n of neighbors) {
        if (!dists.has(n)) {
          dists.set(n, d + 1);
          queue.push({ id: n, d: d + 1 });
        }
      }
    }

    // Set target positions along concentric rings
    // For each distance, evenly space the nodes
    const nodesByDist = new Map<number, LayoutNode[]>();
    for (const n of this.nodes) {
      if (n.id === seedId) continue;
      const d = dists.get(n.id) || 3;
      const list = nodesByDist.get(d) || [];
      list.push(n);
      nodesByDist.set(d, list);
    }

    for (const [d, nodeList] of nodesByDist.entries()) {
      const radius = d * 180;
      const count = nodeList.length;
      for (let i = 0; i < count; i++) {
        const node = nodeList[i];
        const angle = (i / count) * Math.PI * 2;
        node.x = radius * Math.cos(angle);
        node.y = radius * Math.sin(angle);
        node.vx = 0;
        node.vy = 0;
        // Damp physics so they settle immediately on their concentric nodes
        node.fx = node.x;
        node.fy = node.y;
      }
    }

    this.simulation.alpha(0.5).restart();
    this.settled = false;
  }

  // 3. PATH MODE (Horizontal chain constraint)
  applyPathLayout(pathNodeIds: string[]): void {
    const pathSet = new Set(pathNodeIds);

    // Linear chain layout: source on left, target on right
    const count = pathNodeIds.length;
    const spacing = 180;
    const startX = -((count - 1) * spacing) / 2;

    for (let i = 0; i < count; i++) {
      const id = pathNodeIds[i];
      const node = this.nodes.find((n) => n.id === id);
      if (node) {
        node.fx = startX + i * spacing;
        node.fy = 0;
        node.x = node.fx;
        node.y = 0;
      }
    }

    // Unrelated nodes pushed up/down or faded out
    let index = 0;
    for (const n of this.nodes) {
      if (pathSet.has(n.id)) continue;
      n.fx = (index % 2 === 0 ? 1 : -1) * (150 + Math.random() * 200);
      n.fy = (index % 2 === 0 ? 1 : -1) * (180 + Math.random() * 100);
      n.x = n.fx;
      n.y = n.fy;
      index++;
    }

    this.simulation.alpha(0.5).restart();
    this.settled = false;
  }

  // 4. TOPO MODE (Dependency layers)
  applyTopoLayout(entries: { node: { id: string }; depth: number }[], cycleNodeIds: string[]): void {
    const layerHeight = 130;
    const nodeSpacing = 180;
    const topoIds = new Set(entries.map((e) => e.node.id));
    const cycleSet = new Set(cycleNodeIds);

    const byDepth = new Map<number, string[]>();
    for (const e of entries) {
      const list = byDepth.get(e.depth) || [];
      list.push(e.node.id);
      byDepth.set(e.depth, list);
    }
    const maxDepth = byDepth.size > 0 ? Math.max(...byDepth.keys()) : 0;

    // Position topo nodes in layered rows
    for (const [depth, ids] of byDepth.entries()) {
      const totalWidth = (ids.length - 1) * nodeSpacing;
      const startX = -totalWidth / 2;
      for (let i = 0; i < ids.length; i++) {
        const node = this.nodes.find((n) => n.id === ids[i]);
        if (node) {
          const yOff = depth * layerHeight - (maxDepth * layerHeight) / 2;
          node.fx = startX + i * nodeSpacing;
          node.fy = yOff;
          node.x = node.fx;
          node.y = node.fy;
        }
      }
    }

    // Cycle nodes at bottom
    let cycIdx = 0;
    for (const n of this.nodes) {
      if (cycleSet.has(n.id)) {
        n.fx = cycIdx * nodeSpacing - ((cycleSet.size - 1) * nodeSpacing) / 2;
        n.fy = (maxDepth + 1) * layerHeight - (maxDepth * layerHeight) / 2;
        n.x = n.fx;
        n.y = n.fy;
        cycIdx++;
      }
    }

    // Non-topo non-cycle nodes scattered to sides
    let sideIdx = 0;
    for (const n of this.nodes) {
      if (!topoIds.has(n.id) && !cycleSet.has(n.id)) {
        n.fx = (sideIdx % 2 === 0 ? 1 : -1) * (250 + Math.random() * 150);
        n.fy = (sideIdx % 2 === 0 ? 1 : -1) * (180 + Math.random() * 100);
        n.x = n.fx;
        n.y = n.fy;
        sideIdx++;
      }
    }

    this.simulation.alpha(0.5).restart();
    this.settled = false;
  }

  // Helper clustering force
  private forceCommunityCentroid() {
    let nodes: LayoutNode[];
    function force(alpha: number) {
      const centroids = new Map<number, { x: number; y: number; count: number }>();
      for (const n of nodes) {
        if (n.community === undefined || n.community === null) continue;
        const c = centroids.get(n.community) || { x: 0, y: 0, count: 0 };
        c.x += n.x || 0;
        c.y += n.y || 0;
        c.count++;
        centroids.set(n.community, c);
      }
      for (const c of centroids.values()) {
        c.x /= c.count;
        c.y /= c.count;
      }
      for (const n of nodes) {
        if (n.community === undefined || n.community === null || n.fx !== null) continue;
        const c = centroids.get(n.community)!;
        n.vx! += (c.x - (n.x || 0)) * 0.04 * alpha;
        n.vy! += (c.y - (n.y || 0)) * 0.04 * alpha;
      }
    }
    force.initialize = (_: LayoutNode[]) => {
      nodes = _;
    };
    return force;
  }
}
