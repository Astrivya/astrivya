import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Compass,
  Crosshair,
  GitBranch,
  HelpCircle,
  Info,
  Layers,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Star,
  X,
  ZoomIn,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  type AkgNode,
  type AkgStats,
  type GraphData,
  type ImpactReport,
  type PathResult,
  type TopoSortResult,
  akgClient,
} from "./api/akg-client";
import { ForceLayout } from "./layout/force-layout";
import { PixiRenderer } from "./renderer/pixi-renderer";
import astrivyaLogo from "./assets/astrivya-logo.webp?inline";

const KNOWLEDGE_LAYERS = [
  { name: "Workspace Structure", types: ["workspace", "folder"], color: "#7986d6" },
  { name: "Files & Code Modules", types: ["file"], color: "#5b8cff" },
  { name: "Functions & Methods", types: ["function"], color: "#3ecf8e" },
  { name: "Classes & Interfaces", types: ["class", "interface"], color: "#8f7ef0" },
  { name: "Documentation Files", types: ["document"], color: "#c8a15e" },
  { name: "Decision Records (ADRs)", types: ["adr"], color: "#dcae53" },
  { name: "Team Authorship", types: ["person"], color: "#d4798f" },
  { name: "External Dependencies", types: ["dependency"], color: "#6b6b76" },
];

const ALL_TYPES = KNOWLEDGE_LAYERS.flatMap((l) => l.types);

function App() {
  const canvasRef = useRef<HTMLDivElement>(null);

  const layoutRef = useRef<ForceLayout | null>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);

  // Data State
  const [stats, setStats] = useState<AkgStats | null>(null);
  const [communities, setCommunities] = useState<{ id: number; label: string; nodeCount: number }[]>([]);
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(new Set(ALL_TYPES));

  // App UI State
  const [selectedNode, setSelectedNode] = useState<AkgNode | null>(null);
  const [neighbors, setNeighbors] = useState<{ node: AkgNode; relation: string; direction: "in" | "out" }[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<AkgNode[]>([]);
  const [visualMode, setVisualMode] = useState<"explore" | "focus" | "impact" | "path" | "topo">("explore");

  // Drawers
  const [layersOpen, setLayersOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // Mode Action Results
  const [impactReport, setImpactReport] = useState<ImpactReport | null>(null);
  const [cycleLoops, setCycleLoops] = useState<{ path: string[] }[]>([]);
  const [pathResult, setPathResult] = useState<PathResult | null>(null);
  const [isPathSelecting, setIsPathSelecting] = useState(false);
  const [topoResult, setTopoResult] = useState<TopoSortResult | null>(null);

  // Performance state
  const [fps, setFps] = useState(60);
  const fpsTimerRef = useRef(0);
  const [settled, setSettled] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const graphRef = useRef<GraphData>({ nodes: [], edges: [] });

  const visibleTypesRef = useRef(visibleTypes);
  visibleTypesRef.current = visibleTypes;

  // Latest callbacks (stable identity for the mount-once effect)
  const handleNodeSelectionRef = useRef<(id: string) => void>(() => {});
  const handleToggleLayerRef = useRef<(types: string[]) => void>(() => {});
  const resetToExploreRef = useRef<() => void>(() => {});
  const triggerFocusModeRef = useRef<(id: string) => void>(() => {});
  const triggerImpactModeRef = useRef<(id: string) => void>(() => {});
  const triggerPathTraceRef = useRef<(from: string, to: string) => void>(() => {});
  const triggerTopoModeRef = useRef<() => void>(() => {});

  handleNodeSelectionRef.current = handleNodeSelection;
  handleToggleLayerRef.current = handleToggleLayer;
  resetToExploreRef.current = resetToExplore;
  triggerFocusModeRef.current = triggerFocusMode;
  triggerImpactModeRef.current = triggerImpactMode;
  triggerPathTraceRef.current = triggerPathTrace;
  triggerTopoModeRef.current = triggerTopoMode;

  // Initialize data + renderer once
  useEffect(() => {
    let disposed = false;

    async function loadData() {
      try {
        const fullGraph = await akgClient.getFullGraph();
        if (disposed) return;
        const dbStats = await akgClient.getStats();
        const commList = await fetch("/api/akg/communities").then((r) => r.json());

        graphRef.current = fullGraph;
        setStats(dbStats);
        setCommunities(commList || []);

        const layout = new ForceLayout();
        layoutRef.current = layout;
        layout.setGraph(fullGraph.nodes, fullGraph.edges);

        if (canvasRef.current) {
          const renderer = new PixiRenderer();
          rendererRef.current = renderer;
          await renderer.init(canvasRef.current);
          if (disposed) {
            renderer.dispose();
            return;
          }

          renderer.updateGraph(layout.getNodes(), layout.getEdges(), visibleTypesRef.current);

          // Bind click selections
          renderer.onNodeSelect((nodeId) => {
            handleNodeSelectionRef.current(nodeId);
          });

          // Drive physics + render on the Pixi ticker (chunked ticks, decoupled
          // from React). setSettled fires only on transition to avoid re-renders.
          const tick = () => {
            const l = layoutRef.current;
            const r = rendererRef.current;
            if (!l || !r) return;

            const isSettled = l.isSettled();
            if (!isSettled) l.tick();

            r.updateNodesPositions(l.getNodes(), l.getEdges(), visibleTypesRef.current, l.isSettled());

            const now = Date.now();
            if (now - fpsTimerRef.current > 500) {
              setFps(Math.round(r.app.ticker.FPS));
              fpsTimerRef.current = now;
            }
          };

          // fit-to-bounds once when settling flips false→true
          let wasSettled = false;
          const settleCheck = () => {
            const l = layoutRef.current;
            const r = rendererRef.current;
            if (!l || !r) return;
            const isSettled = l.isSettled();
            if (isSettled && !wasSettled) {
              wasSettled = true;
              r.fitToBounds(l.getNodes());
              r.requestLabelRefresh();
              setSettled(true);
            } else if (!isSettled && wasSettled) {
              wasSettled = false;
              setSettled(false);
            }
          };

          renderer.app.ticker.add(tick);
          renderer.app.ticker.add(settleCheck);
        }
      } catch (err) {
        console.error("Failed to load local AKG data:", err);
        setInitError(err instanceof Error ? err.message : String(err));
      }
    }

    loadData();

    // Live update event subscriber
    const eventSource = new EventSource("/api/akg/events");
    eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "update") {
          const updatedGraph = await akgClient.getFullGraph();
          const dbStats = await akgClient.getStats();
          const commList = await fetch("/api/akg/communities").then((r) => r.json());

          graphRef.current = updatedGraph;
          setStats(dbStats);
          setCommunities(commList || []);

          if (layoutRef.current && rendererRef.current) {
            layoutRef.current.setGraph(updatedGraph.nodes, updatedGraph.edges);
            rendererRef.current.updateGraph(
              layoutRef.current.getNodes(),
              layoutRef.current.getEdges(),
              visibleTypesRef.current,
            );

            const updatedNodeId = `file::${data.file}`;
            rendererRef.current.flyToNode(updatedNodeId, layoutRef.current.getNodes());
          }
        }
      } catch (err) {
        console.warn("Failed to parse live event:", err);
      }
    };

    // Keyboard shortcuts: `/` search, `l` layers, `Esc` close/deselect
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "/") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".search-input");
        input?.focus();
      } else if (e.key.toLowerCase() === "l") {
        setLayersOpen((v) => !v);
      } else if (e.key === "Escape") {
        setInspectorOpen(false);
        setSelectedNode(null);
        setPathResult(null);
        setImpactReport(null);
        setTopoResult(null);
        rendererRef.current?.setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      eventSource.close();
      if (layoutRef.current) layoutRef.current.stop();
      if (rendererRef.current) rendererRef.current.dispose();
    };
  }, []);

  function handleToggleLayer(types: string[]) {
    const nextTypes = new Set(visibleTypesRef.current);
    const anyEnabled = types.some((t) => nextTypes.has(t));
    if (anyEnabled) {
      types.forEach((t) => nextTypes.delete(t));
    } else {
      types.forEach((t) => nextTypes.add(t));
    }

    setVisibleTypes(nextTypes);
    visibleTypesRef.current = nextTypes;

    if (layoutRef.current && rendererRef.current) {
      rendererRef.current.updateGraph(layoutRef.current.getNodes(), layoutRef.current.getEdges(), nextTypes);
      layoutRef.current.restart();
    }
  }

  function handleNodeSelection(nodeId: string) {
    try {
      (async () => {
        const res = await fetch(`/api/akg/node?id=${encodeURIComponent(nodeId)}`);
        const details = await res.json();
        setSelectedNode(details.node);
        setNeighbors(details.neighbors || []);
        setInspectorOpen(true);
        rendererRef.current?.setSelection(nodeId);
      })();
    } catch (err) {
      console.error("Failed to fetch node details:", err);
    }
  }

  const handleSearchChange = async (val: string) => {
    setSearchQuery(val);
    if (val.trim().length > 1) {
      const matches = await akgClient.searchNodes(val);
      setSuggestions(matches);
    } else {
      setSuggestions([]);
    }
  };

  const handleSelectSuggestion = (node: AkgNode) => {
    setSearchQuery("");
    setSuggestions([]);
    handleNodeSelection(node.id);
    if (rendererRef.current && layoutRef.current) {
      rendererRef.current.flyToNode(node.id, layoutRef.current.getNodes());
    }
  };

  function resetToExplore() {
    setVisualMode("explore");
    setImpactReport(null);
    setCycleLoops([]);
    setPathResult(null);
    setIsPathSelecting(false);
    setTopoResult(null);

    if (layoutRef.current && rendererRef.current) {
      layoutRef.current.applyDefaultLayout();
      rendererRef.current.setVisualMode("explore");
    }
  }

  async function triggerFocusMode(nodeId: string) {
    setVisualMode("focus");
    try {
      const subgraph = await akgClient.getSubgraph(nodeId, 2);
      const highlightedIds = subgraph.nodes.map((n) => n.id);
      if (layoutRef.current && rendererRef.current) {
        layoutRef.current.applyFocusLayout(nodeId);
        rendererRef.current.setVisualMode("focus", { highlightIds: highlightedIds });
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function triggerImpactMode(nodeId: string) {
    setVisualMode("impact");
    try {
      const data = await akgClient.getImpact(nodeId);
      setImpactReport(data.report);
      setCycleLoops(data.cycles);
      const direct = data.report.directlyAffected.map((d) => d.id);
      const transitive = data.report.transitivelyAffected.map((t) => t.id);
      if (layoutRef.current && rendererRef.current) {
        layoutRef.current.applyDefaultLayout();
        rendererRef.current.setVisualMode("impact", {
          directImpactIds: direct,
          transitiveImpactIds: transitive,
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function triggerPathTrace(sourceId: string, targetId: string) {
    setVisualMode("path");
    try {
      const result = await akgClient.getPath(sourceId, targetId);
      setPathResult(result);
      if (result && result.nodes.length > 0) {
        const pathIds = result.nodes.map((n) => n.id);
        if (layoutRef.current && rendererRef.current) {
          layoutRef.current.applyPathLayout(pathIds);
          rendererRef.current.setVisualMode("path", { pathIds });
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function triggerTopoMode() {
    setVisualMode("topo");
    setTopoResult(null);
    try {
      const result = await akgClient.getTopo();
      setTopoResult(result);
      if (result.entries.length > 0 && layoutRef.current && rendererRef.current) {
        layoutRef.current.applyTopoLayout(result.entries, result.cycleNodeIds);
        rendererRef.current.setVisualMode("topo", {
          topoDepths: result.entries.map((e) => ({ nodeId: e.node.id, depth: e.depth })),
          topoCycleIds: result.cycleNodeIds,
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  // Clean up old path/impact state when switching back to explore
  const handleModeBtn = (mode: "explore" | "focus" | "impact" | "path" | "topo") => {
    if (mode === "explore") {
      resetToExploreRef.current();
    } else if (mode === "focus" && selectedNode) {
      triggerFocusModeRef.current(selectedNode.id);
    } else if (mode === "impact" && selectedNode) {
      triggerImpactModeRef.current(selectedNode.id);
    } else if (mode === "topo") {
      triggerTopoModeRef.current();
    }
  };

  const zoomControls = (
    <div className="zoom-controls">
      <button className="icon-btn" aria-label="Zoom in" onClick={() => rendererRef.current?.zoomAt(1.3)}>
        <Plus size={14} />
      </button>
      <button className="icon-btn" aria-label="Zoom out" onClick={() => rendererRef.current?.zoomAt(1 / 1.3)}>
        <Minus size={14} />
      </button>
      <button className="icon-btn" aria-label="Reset view" onClick={() => rendererRef.current?.resetFit()}>
        <Maximize2 size={14} />
      </button>
    </div>
  );

  const modePill = (
    <div className="mode-pill">
      <button
        className={`mode-chip ${visualMode === "explore" ? "active" : ""}`}
        onClick={() => handleModeBtn("explore")}
      >
        <Compass size={13} /> Explore
      </button>
      <button
        className={`mode-chip ${visualMode === "focus" ? "active" : ""}`}
        disabled={!selectedNode}
        onClick={() => handleModeBtn("focus")}
      >
        <Crosshair size={13} /> Focus
      </button>
      <button
        className={`mode-chip ${visualMode === "impact" ? "active" : ""}`}
        disabled={!selectedNode}
        onClick={() => handleModeBtn("impact")}
      >
        <Activity size={13} /> Impact
      </button>
      <button className={`mode-chip ${visualMode === "topo" ? "active" : ""}`} onClick={() => handleModeBtn("topo")}>
        <Layers size={13} /> Topo
      </button>
    </div>
  );

  const hud = useMemo(() => {
    if (visualMode === "impact" && impactReport) {
      return (
        <div className="mode-card">
          <div className="mode-card-label">Risk Blast Score</div>
          <div className="mode-card-score" style={{ color: impactReport.riskScore > 0.65 ? "#e2574c" : "#e2a14f" }}>
            {impactReport.riskScore.toFixed(2)} <span>/ 1.0</span>
          </div>
          <p>{impactReport.summary}</p>
        </div>
      );
    }
    if (visualMode === "path" && pathResult) {
      return (
        <div className="mode-card">
          <div className="mode-card-label">Path Trace</div>
          <div className="mode-card-path">
            {pathResult.nodes.map((n, idx) => (
              <span key={n.id} className="path-segment">
                <span className="path-type">{n.type}</span>
                {n.label}
                {idx < pathResult.nodes.length - 1 && <ChevronRight size={10} />}
              </span>
            ))}
          </div>
          <div className="mode-card-foot">{pathResult.totalWeight.toFixed(1)} hops</div>
        </div>
      );
    }
    if (visualMode === "topo" && topoResult) {
      return (
        <div className="mode-card">
          <div className="mode-card-label">Dependency Layers</div>
          <div className="mode-card-score">{topoResult.entries.length} files</div>
          {topoResult.cycleNodeIds.length > 0 && (
            <p className="cycle-note">
              <AlertTriangle size={12} /> {topoResult.cycleNodeIds.length} cyclic
            </p>
          )}
        </div>
      );
    }
    return null;
  }, [visualMode, impactReport, pathResult, topoResult]);

  const layersPanel = (
    <aside className={`atlas-drawer left ${layersOpen ? "open" : ""}`}>
      <div className="drawer-head">
        <span className="drawer-title">Knowledge Layers</span>
        <button className="icon-btn" onClick={() => setLayersOpen(false)} aria-label="Close layers">
          <X size={14} />
        </button>
      </div>
      <div className="drawer-body">
        {KNOWLEDGE_LAYERS.map((layer) => {
          const isEnabled = layer.types.some((t) => visibleTypes.has(t));
          return (
            <div
              key={layer.name}
              className={`layer-item ${isEnabled ? "" : "disabled"}`}
              onClick={() => handleToggleLayerRef.current(layer.types)}
            >
              <div className="layer-info">
                <span className="layer-color-dot" style={{ backgroundColor: layer.color }} />
                {layer.name}
              </div>
              <input type="checkbox" checked={isEnabled} onChange={() => {}} tabIndex={-1} />
            </div>
          );
        })}

        <div className="drawer-divider" />

        <div className="drawer-title small">Community Clusters ({communities.length})</div>
        <div className="community-list">
          {communities.length === 0 ? (
            <p className="empty-hint">No clusters detected.</p>
          ) : (
            communities.map((c) => (
              <div key={c.id} className="community-item">
                <span>{c.label}</span>
                <span className="count">{c.nodeCount}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );

  const inspectorPanel = (
    <aside className={`atlas-drawer right ${inspectorOpen ? "open" : ""}`}>
      <div className="drawer-head">
        <span className="drawer-title">Inspector</span>
        <button
          className="icon-btn"
          onClick={() => {
            setInspectorOpen(false);
            rendererRef.current?.setSelection(null);
          }}
          aria-label="Close inspector"
        >
          <X size={14} />
        </button>
      </div>
      <div className="drawer-body">
        {selectedNode ? (
          <>
            <div className="inspector-header">
              <span className="inspector-type">{selectedNode.type}</span>
              <h3 className="inspector-label">{selectedNode.label}</h3>
              <p className="inspector-id">{selectedNode.id}</p>
            </div>

            <div className="inspector-section">
              <div className="inspector-detail-row">
                <span className="label">Git Commits Churn</span>
                <span className="value">{selectedNode.churnRate || 0} / mo</span>
              </div>
              <div className="inspector-detail-row">
                <span className="label">Contributors</span>
                <span className="value">{selectedNode.contributorCount || 0}</span>
              </div>
              <div className="inspector-detail-row">
                <span className="label">Community</span>
                <span className="value">
                  {selectedNode.community !== null && selectedNode.community !== undefined
                    ? selectedNode.community
                    : "None"}
                </span>
              </div>
            </div>

            <div className="inspector-section">
              <div className="drawer-title small">Relationships ({neighbors.length})</div>
              <div className="relation-list">
                {neighbors.length === 0 ? (
                  <p className="empty-hint">No connection edges found.</p>
                ) : (
                  neighbors.map((r, idx) => (
                    <div key={idx} className="relation-item" onClick={() => handleNodeSelectionRef.current(r.node.id)}>
                      <div className="relation-node">
                        <span className="relation-label">{r.node.label}</span>
                        <span className="relation-type">{r.node.type}</span>
                      </div>
                      <span className="relation-edge">
                        {r.direction === "out" ? "→" : "←"} {r.relation}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {visualMode === "impact" && cycleLoops.length > 0 && (
              <div className="cycle-warning-card">
                <div className="cycle-warning-title">
                  <AlertTriangle size={13} /> Circular Loops
                </div>
                {cycleLoops.slice(0, 3).map((c, idx) => (
                  <div key={idx} className="cycle-path">
                    {c.path.map((p) => p.split("::").pop()?.split("/").pop()).join(" → ")}
                  </div>
                ))}
              </div>
            )}

            <div className="inspector-actions">
              <button className="action-btn" onClick={() => triggerFocusModeRef.current(selectedNode.id)}>
                <Crosshair size={14} /> Focus Neighborhood
              </button>
              <button
                className="action-btn danger"
                onClick={() => triggerImpactModeRef.current(selectedNode.id)}
              >
                <Activity size={14} /> Blast Impact
              </button>
              {isPathSelecting ? (
                <button className="action-btn secondary" onClick={() => setIsPathSelecting(false)}>
                  <RefreshCw size={14} /> Click path target…
                </button>
              ) : (
                <button
                  className="action-btn secondary"
                  onClick={() => {
                    setIsPathSelecting(true);
                    setPathResult(null);
                  }}
                >
                  <GitBranch size={14} /> Trace path from here
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="inspector-empty">
            <Info size={22} />
            <p>Click any node on the graph to inspect it.</p>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <div className="atlas-app">
      <header className="atlas-header">
        <div className="atlas-logo">
          <AstrivyaLogo size={22} />
          <span className="atlas-wordmark">Astrivya</span>
          <span className="atlas-sub">Atlas</span>
        </div>

        <div className="search-container">
          <Search className="search-icon" size={15} />
          <input
            type="text"
            className="search-input"
            placeholder="Search symbols, files, functions…  ( / )"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {suggestions.length > 0 && (
            <div className="suggestions-dropdown">
              {suggestions.map((s) => (
                <div key={s.id} className="suggestion-item" onClick={() => handleSelectSuggestion(s)}>
                  <span className="suggestion-label">{s.label}</span>
                  <span className="suggestion-type">{s.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="header-actions">
          <a
            className="gh-star-btn"
            href="https://github.com/astrivya/astrivya"
            target="_blank"
            rel="noreferrer"
            title="Star Astrivya on GitHub"
          >
            <Star size={13} fill="currentColor" />
            <span>Star</span>
            <span className="gh-star-suffix">on GitHub</span>
          </a>
          <div className="header-actions-divider" />
          <button
            className={`icon-btn ${layersOpen ? "active" : ""}`}
            onClick={() => setLayersOpen((v) => !v)}
            title="Layers (L)"
          >
            <Layers size={16} />
          </button>
          <button
            className={`icon-btn ${inspectorOpen ? "active" : ""}`}
            onClick={() => setInspectorOpen((v) => !v)}
            title="Inspector"
          >
            <ZoomIn size={16} />
          </button>
          <button className="icon-btn" title="Help">
            <HelpCircle size={16} />
          </button>
        </div>
      </header>

      <main className="atlas-canvas-container" ref={canvasRef}>
        {initError && (
          <div className="init-error-card">
            <AlertTriangle size={16} />
            <div>
              <strong>Renderer failed to start</strong>
              <p>{initError}</p>
              <p className="init-error-hint">
                Atlas needs WebGL. Try enabling hardware acceleration in your browser, or open this page in Chrome/Edge.
              </p>
            </div>
          </div>
        )}

        <MiniMap layoutRef={layoutRef} rendererRef={rendererRef} selectedNodeId={selectedNode?.id} />
        {hud}
        {modePill}
        {zoomControls}
      </main>

      {layersPanel}
      {inspectorPanel}

      <footer className="atlas-status-bar">
        <div className="status-indicator">
          <div className={`status-dot ${stats ? "live" : ""}`} />
          <span>{stats ? "localhost:4200 · live" : "connecting…"}</span>
        </div>
        {stats && (
          <div className="status-metrics">
            <span>{stats.nodes.toLocaleString()} nodes</span>
            <span>{stats.edges.toLocaleString()} edges</span>
            <span>{stats.chunks.toLocaleString()} chunks</span>
            <span>{(stats.dbSize / 1024 / 1024).toFixed(1)} MB</span>
          </div>
        )}
        <div className="status-right">
          {fps < 45 && <span className="fps-chip">{fps} fps</span>}
          <span>{settled ? "settled" : "laying out…"}</span>
        </div>
      </footer>
    </div>
  );
}

// AstrivyaLogo — official brand mark (astrivya-logo.webp, shared with the
// Astrivya app). Inlined as a base64 data URI so the header needs no
// separate network request.
function AstrivyaLogo({ size = 22 }: { size?: number }) {
  return (
    <img
      src={astrivyaLogo}
      width={size}
      height={size}
      className="atlas-logo-img"
      alt="Astrivya logo"
    />
  );
}

// MiniMap — redraws at ~5fps, dots cached, viewport rect follows camera.
const MiniMap = memo(function MiniMap({
  layoutRef,
  rendererRef,
  selectedNodeId,
}: {
  layoutRef: React.RefObject<ForceLayout | null>;
  rendererRef: React.RefObject<PixiRenderer | null>;
  selectedNodeId?: string;
}) {
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const layout = layoutRef.current;
      const renderer = rendererRef.current;
      if (!layout || !renderer) return;
      const nodes = layout.getNodes();
      if (nodes.length === 0) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Compute graph bounds
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        if (n.x === undefined || n.y === undefined) continue;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      const gw = maxX - minX || 1;
      const gh = maxY - minY || 1;
      const scale = Math.min((canvas.width - 16) / gw, (canvas.height - 16) / gh);

      // Nodes as 1px dots
      ctx.fillStyle = "rgba(138,138,150,0.5)";
      for (const n of nodes) {
        if (n.x === undefined || n.y === undefined) continue;
        ctx.fillRect((n.x - minX) * scale + 8, (n.y - minY) * scale + 8, 1, 1);
      }

      // Selected node
      if (selectedNodeId) {
        const n = nodes.find((x) => x.id === selectedNodeId);
        if (n && n.x !== undefined && n.y !== undefined) {
          ctx.fillStyle = "#8b88ff";
          ctx.beginPath();
          ctx.arc((n.x - minX) * scale + 8, (n.y - minY) * scale + 8, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Viewport rect
      let cam: ReturnType<PixiRenderer["getCamera"]> | null = null;
      try {
        cam = renderer.getCamera();
      } catch {
        cam = null;
      }
      if (cam) {
        const vw = (cam.width / cam.zoom / gw) * (canvas.width - 16);
        const vh = (cam.height / cam.zoom / gh) * (canvas.height - 16);
        const vx = (cam.x / gw) * (canvas.width - 16);
        const vy = (cam.y / gh) * (canvas.height - 16);
        ctx.strokeStyle = "rgba(139,136,255,0.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(vx, vy, vw, vh);
      }    };

    draw();
    const timer = setInterval(draw, 200);
    return () => clearInterval(timer);
  }, [layoutRef, rendererRef, selectedNodeId]);

  return (
    <div className="minimap-overlay">
      <canvas ref={mapCanvasRef} width={132} height={96} />
    </div>
  );
});

export default App;
