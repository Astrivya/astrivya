/**
 * Community detection for the knowledge graph.
 *
 * A cheap connected-components pass over the edge set (union-find). Every
 * node is assigned a community id = the index of its component root; the
 * caller decides whether to persist a `communities` row per component.
 */

export interface CommunityComponent {
  /** Node ids in this component. */
  nodeIds: string[];
  /** Number of edges whose endpoints are both inside the component. */
  internalEdges: number;
}

/**
 * Compute a community assignment for every node. Nodes connected through
 * the edge set share a component; nodes absent from all edges map to their
 * own singleton component (each gets a distinct community id).
 *
 * @param edges   Directed edges; both endpoints are treated as connected.
 * @param nodeIds Complete list of node ids that should receive an assignment.
 * @returns Map nodeId -> community id (an integer component index).
 */
export function computeCommunities(
  edges: Array<{ source: string; target: string }>,
  nodeIds: string[],
): Map<string, number> {
  const parent = new Map<string, string>();

  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    if (!parent.has(x)) parent.set(x, root);
    while (parent.get(root) !== root) {
      parent.set(root, parent.get(root)!);
      root = parent.get(root)!;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const edge of edges) {
    union(edge.source, edge.target);
  }

  const componentIds = new Map<string, number>();
  const assignment = new Map<string, number>();

  const assign = (nodeId: string): void => {
    const root = find(nodeId);
    if (!componentIds.has(root)) componentIds.set(root, componentIds.size);
    assignment.set(nodeId, componentIds.get(root)!);
  };

  for (const nodeId of nodeIds) assign(nodeId);
  return assignment;
}

/**
 * Enumerate components with membership and internal-edge counts, useful
 * for persisting `communities` rows (id, label, node_count, cohesion).
 */
export function enumerateCommunities(
  edges: Array<{ source: string; target: string }>,
  nodeIds: string[],
): { nodeIds: string[]; internalEdges: number }[] {
  const assignment = computeCommunities(edges, nodeIds);
  const byComponent = new Map<number, { nodeIds: string[]; internalEdges: number }>();
  for (const [nodeId, compId] of assignment) {
    if (!byComponent.has(compId)) byComponent.set(compId, { nodeIds: [], internalEdges: 0 });
    byComponent.get(compId)!.nodeIds.push(nodeId);
  }
  for (const edge of edges) {
    const src = assignment.get(edge.source);
    const dst = assignment.get(edge.target);
    if (src !== undefined && src === dst) {
      byComponent.get(src)!.internalEdges++;
    }
  }
  return Array.from(byComponent.values()).sort((a, b) => b.nodeIds.length - a.nodeIds.length);
}
