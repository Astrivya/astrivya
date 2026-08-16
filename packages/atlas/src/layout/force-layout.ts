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
  /** top-level module/repo bucket (used for group clustering) */
  group?: string;
  /** precomputed degree for label priority + hub sizing */
  degree: number;
  fx?: number | null;
  fy?: number | null;
}

export interface LayoutEdge {
  source: string | LayoutNode;
  target: string | LayoutNode;
  relation: string;
  weight?: number;
}

type Phase = "unclump" | "refine";

export class ForceLayout {
  private simulation: d3.Simulation<LayoutNode, LayoutEdge>;
  private nodes: LayoutNode[] = [];
  private edges: LayoutEdge[] = [];
  private onTickCallback?: () => void;
  private settled = false;
  private phase: Phase = "unclump";

  constructor() {
    this.simulation = d3
      .forceSimulation<LayoutNode, LayoutEdge>()
      .force(
        "link",
        d3
          .forceLink<LayoutNode, LayoutEdge>()
          .id((d) => d.id)
          .distance((e) => this.linkDistance(e))
          .iterations(1),
      )
      // Phase A: link + charge only, capped radius for O(n log n)
      .force("charge", d3.forceManyBody().strength(-160).distanceMax(300).theta(1.2))
      .force("center", d3.forceCenter(0, 0))
      .alphaDecay(0.03);

    // Phase-based physics: run sim manually (chunked ticks) instead of the
    // built-in tick loop so physics clock is decoupled from render clock.
    this.simulation.stop();
  }

  /**
   * Relation-aware link distance: story edges (decided/affects/implements/
   * changed) get room to read as legible paths; structural contains edges stay
   * tight around the tree; references sit between.
   */
  private linkDistance(e: LayoutEdge): number {
    switch (e.relation) {
      case "contains":
        return 40;
      case "references":
      case "contributes_to":
        return 60;
      case "decided":
      case "affects":
      case "implements":
      case "generated":
      case "changed":
        return 100;
      default:
        return 70;
    }
  }

  isSettled(): boolean {
    return this.settled;
  }

  setGraph(nodes: AkgNode[], edges: AkgEdge[]): void {
    // Precompute degree for label priority / hub sizing
    const degreeMap = new Map<string, number>();
    for (const e of edges) {
      const srcId = typeof e.source === "string" ? e.source : (e.source as AkgNode).id;
      const tgtId = typeof e.target === "string" ? e.target : (e.target as AkgNode).id;
      degreeMap.set(srcId, (degreeMap.get(srcId) || 0) + 1);
      degreeMap.set(tgtId, (degreeMap.get(tgtId) || 0) + 1);
    }

    const coordMap = new Map<string, { x: number; y: number }>();
    for (const n of this.nodes) {
      if (n.x !== undefined && n.y !== undefined) coordMap.set(n.id, { x: n.x, y: n.y });
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
        group: n.group,
        degree: degreeMap.get(n.id) || 0,
        x: coords ? coords.x : Math.random() * 300 - 150,
        y: coords ? coords.y : Math.random() * 300 - 150,
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
    if (linkForce) linkForce.links(this.edges);

    this.phase = "unclump";
    this.settled = false;
    this.simulation.alpha(1).restart();
  }

  onTick(callback: () => void): void {
    this.onTickCallback = callback;
  }

  /**
   * Advance physics by `steps` ticks (chunked: called once per render frame).
   * Phase A runs link+charge only; when alpha drops below the threshold we
   * enable collide + cluster centroid (Phase B) for the final pass.
   */
  tick(steps = 1): void {
    for (let i = 0; i < steps; i++) {
      const alpha = this.simulation.alpha();
      if (this.phase === "unclump" && alpha < 0.25) {
        this.phase = "refine";
        this.simulation
          .force("collide", d3.forceCollide().radius(22).iterations(1))
          .force("cluster", this.forceCommunityCentroid())
          .force("group", this.forceGroupCentroid())
          .force("chain", this.forceChainStraighten())
          .force("orbit", this.forceRepoOrbit())
          .alpha(0.35)
          .restart();
      }
      this.simulation.tick();
    }
    if (this.simulation.alpha() < 0.005) {
      this.settled = true;
      this.simulation.stop();
    } else {
      this.settled = false;
    }
    if (this.onTickCallback) this.onTickCallback();
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
      this.settled = false;
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
    this.phase = "unclump";
    this.settled = false;
    this.simulation.alpha(0.8).restart();
  }

  applyDefaultLayout(): void {
    for (const n of this.nodes) {
      n.fx = null;
      n.fy = null;
    }
    this.simulation
      .force("charge", d3.forceManyBody().strength(-160).distanceMax(300))
      .force("center", d3.forceCenter(0, 0));
    const linkForce = this.simulation.force("link") as d3.ForceLink<LayoutNode, LayoutEdge>;
    if (linkForce) linkForce.distance((e) => this.linkDistance(e));
    this.phase = "unclump";
    this.simulation.alpha(0.8).restart();
    this.settled = false;
  }

  applyFocusLayout(seedId: string): void {
    const centerNode = this.nodes.find((n) => n.id === seedId);
    if (!centerNode) return;

    centerNode.fx = 0;
    centerNode.fy = 0;

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
      for (const n of adj.get(id) || []) {
        if (!dists.has(n)) {
          dists.set(n, d + 1);
          queue.push({ id: n, d: d + 1 });
        }
      }
    }

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
        node.fx = node.x;
        node.fy = node.y;
      }
    }

    this.simulation.alpha(0.5).restart();
    this.settled = false;
  }

  applyPathLayout(pathNodeIds: string[]): void {
    const pathSet = new Set(pathNodeIds);
    const count = pathNodeIds.length;
    const spacing = 180;
    const startX = -((count - 1) * spacing) / 2;

    for (let i = 0; i < count; i++) {
      const node = this.nodes.find((n) => n.id === pathNodeIds[i]);
      if (node) {
        node.fx = startX + i * spacing;
        node.fy = 0;
        node.x = node.fx;
        node.y = 0;
      }
    }

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

  /**
   * Pull nodes of the same top-level module/repo (`group`) toward each other
   * so the graph visually separates by repo — a gentle, weaker sibling of the
   * community centroid force. No-op when no node carries a `group`.
   */
  private forceGroupCentroid() {
    let nodes: LayoutNode[];
    function force(alpha: number) {
      const centroids = new Map<string, { x: number; y: number; count: number }>();
      for (const n of nodes) {
        if (!n.group) continue;
        const c = centroids.get(n.group) || { x: 0, y: 0, count: 0 };
        c.x += n.x || 0;
        c.y += n.y || 0;
        c.count++;
        centroids.set(n.group, c);
      }
      for (const c of centroids.values()) {
        c.x /= c.count;
        c.y /= c.count;
      }
      for (const n of nodes) {
        if (!n.group || n.fx !== null) continue;
        const c = centroids.get(n.group)!;
        n.vx! += (c.x - (n.x || 0)) * 0.025 * alpha;
        n.vy! += (c.y - (n.y || 0)) * 0.025 * alpha;
      }
    }
    force.initialize = (_: LayoutNode[]) => {
      nodes = _;
    };
    return force;
  }

  /**
   * Repo-shell orbital anchoring: repo nodes settle onto a ring around the
   * origin (workspace root) like planets — the overview reads as a solar
   * system of repositories instead of a random cloud. Angular slots are
   * alphabetical; repos that are pinned (focus/topo/path modes) are skipped.
   */
  private forceRepoOrbit() {
    let nodes: LayoutNode[];
    let targets: { node: LayoutNode; tx: number; ty: number }[] = [];
    const SHELL_RADIUS = 340;

    function force(alpha: number) {
      for (const { node, tx, ty } of targets) {
        if (node.fx !== null || node.fy !== null) continue;
        node.vx! += (tx - (node.x || 0)) * 0.02 * alpha;
        node.vy! += (ty - (node.y || 0)) * 0.02 * alpha;
      }
    }
    force.initialize = (_: LayoutNode[]) => {
      nodes = _;
      targets = [];
      const repos = nodes
        .filter((n) => n.type === "repo")
        .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      const count = Math.max(1, repos.length);
      repos.forEach((repo, i) => {
        const angle = (i / count) * Math.PI * 2;
        targets.push({
          node: repo,
          tx: SHELL_RADIUS * Math.cos(angle),
          ty: SHELL_RADIUS * Math.sin(angle),
        });
      });
      for (const ws of nodes.filter((n) => n.type === "workspace")) {
        targets.push({ node: ws, tx: 0, ty: 0 });
      }
    };
    return force;
  }

  /**
   * Chain straightening: pull 2-hop neighbors of a semantic chain toward the
   * segment between its endpoints so `person → decided → decision → affects →
   * file` reads as a deliberate path, not an accident of physics. Applies only
   * to story-relation paths (decided/affects/implements/changed) and is gentle
   * (0.02) so it never overpowers community/group clustering.
   */
  private forceChainStraighten() {
    let nodes: LayoutNode[];
    let chains: { a: LayoutNode; b: LayoutNode; mid: LayoutNode }[] = [];
    const STORY = new Set(["decided", "affects", "implements", "generated", "changed"]);

    function force(alpha: number) {
      if (chains.length === 0) return;
      for (const { a, b, mid } of chains) {
        if (mid.fx !== null) continue;
        const ax = a.x || 0;
        const ay = a.y || 0;
        const bx = b.x || 0;
        const by = b.y || 0;
        // Project mid onto segment a→b
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, (((mid.x || 0) - ax) * dx + ((mid.y || 0) - ay) * dy) / len2));
        const px = ax + dx * t;
        const py = ay + dy * t;
        mid.vx! += (px - (mid.x || 0)) * 0.02 * alpha;
        mid.vy! += (py - (mid.y || 0)) * 0.02 * alpha;
      }
    }
    force.initialize = (_: LayoutNode[]) => {
      nodes = _;
      chains = [];
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const adj = new Map<string, { to: string; rel: string }[]>();
      for (const e of this.edges) {
        const src = typeof e.source === "string" ? e.source : e.source.id;
        const tgt = typeof e.target === "string" ? e.target : e.target.id;
        if (!STORY.has(e.relation)) continue;
        if (!adj.has(src)) adj.set(src, []);
        if (!adj.has(tgt)) adj.set(tgt, []);
        adj.get(src)!.push({ to: tgt, rel: e.relation });
        adj.get(tgt)!.push({ to: src, rel: e.relation });
      }
      // For every 2-path a→m→b where a→m and m→b are both story edges, collect
      // the chain so the middle node gets pulled onto the a→b segment.
      for (const [midId, nbrs] of adj) {
        const mid = nodeById.get(midId);
        if (!mid || nbrs.length < 2) continue;
        for (let i = 0; i < nbrs.length; i++) {
          for (let j = i + 1; j < nbrs.length; j++) {
            const a = nodeById.get(nbrs[i].to);
            const b = nodeById.get(nbrs[j].to);
            if (a && b) chains.push({ a, b, mid });
          }
        }
      }
    };
    return force;
  }
}
