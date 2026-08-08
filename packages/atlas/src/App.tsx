import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Compass,
  Crosshair,
  GitBranch,
  Info,
  Layers,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

// Map types to human readable display
const KNOWLEDGE_LAYERS = [
  { name: "Workspace Structure", types: ["workspace", "folder"], color: "#6366f1" },
  { name: "Files & Code Modules", types: ["file"], color: "#3b82f6" },
  { name: "Functions & Methods", types: ["function"], color: "#10b981" },
  { name: "Classes & Interfaces", types: ["class", "interface"], color: "#f59e0b" },
  { name: "Documentation Files", types: ["document"], color: "#ec4899" },
  { name: "Decision Records (ADRs)", types: ["adr"], color: "#ef4444" },
  { name: "Team Authorship", types: ["person"], color: "#e11d48" },
  { name: "External Dependencies", types: ["dependency"], color: "#6b7280" },
];

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null);

  // Core engine references
  const layoutRef = useRef<ForceLayout | null>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);

  // Data State
  const [stats, setStats] = useState<AkgStats | null>(null);
  const [communities, setCommunities] = useState<{ id: number; label: string; nodeCount: number }[]>([]);
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(new Set(KNOWLEDGE_LAYERS.flatMap((l) => l.types)));

  // App UI State
  const [selectedNode, setSelectedNode] = useState<AkgNode | null>(null);
  const [neighbors, setNeighbors] = useState<{ node: AkgNode; relation: string; direction: "in" | "out" }[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<AkgNode[]>([]);
  const [visualMode, setVisualMode] = useState<"explore" | "focus" | "impact" | "path" | "topo">("explore");

  // Mode Action Results
  const [impactReport, setImpactReport] = useState<ImpactReport | null>(null);
  const [cycleLoops, setCycleLoops] = useState<{ path: string[] }[]>([]);
  const [pathResult, setPathResult] = useState<PathResult | null>(null);
  const [isPathSelecting, setIsPathSelecting] = useState(false);

  // Topo mode state
  const [topoResult, setTopoResult] = useState<TopoSortResult | null>(null);

  // Performance state
  const [fps, setFps] = useState(60);
  const fpsTimerRef = useRef(0);
  const [settled, setSettled] = useState(false);
  const graphRef = useRef<GraphData>({ nodes: [], edges: [] });

  // Initialize data and renderer
  useEffect(() => {
    async function loadData() {
      try {
        const fullGraph = await akgClient.getFullGraph();
        const dbStats = await akgClient.getStats();
        const commList = await fetch("/api/akg/communities").then((r) => r.json());

        graphRef.current = fullGraph;
        setStats(dbStats);
        setCommunities(commList || []);

        // Initialize layout engine
        const layout = new ForceLayout();
        layoutRef.current = layout;
        layout.setGraph(fullGraph.nodes, fullGraph.edges);

        // Initialize WebGL renderer
        if (canvasRef.current) {
          const renderer = new PixiRenderer();
          rendererRef.current = renderer;
          await renderer.init(canvasRef.current);

          // On tick, update Pixi node locations
          layout.onTick(() => {
            const isSettled = layoutRef.current?.isSettled() ?? false;
            setSettled(isSettled);

            renderer.updateNodesPositions(layout.getNodes(), layout.getEdges(), visibleTypes, isSettled);

            // Throttle FPS React state update to 500ms
            const now = Date.now();
            if (now - fpsTimerRef.current > 500) {
              setFps(Math.round(renderer.app.ticker.FPS));
              fpsTimerRef.current = now;
            }
          });

          // Draw initial graph
          renderer.updateGraph(layout.getNodes(), layout.getEdges(), visibleTypes);

          // Bind click selections
          renderer.onNodeSelect((nodeId) => {
            handleNodeSelection(nodeId);
          });
        }
      } catch (err) {
        console.error("Failed to load local AKG data:", err);
      }
    }

    loadData();

    // Live update event subscriber
    const eventSource = new EventSource("/api/akg/events");
    eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "update") {
          console.log("Live update received:", data.file);
          const updatedGraph = await akgClient.getFullGraph();
          const dbStats = await akgClient.getStats();
          const commList = await fetch("/api/akg/communities").then((r) => r.json());

          graphRef.current = updatedGraph;
          setStats(dbStats);
          setCommunities(commList || []);

          if (layoutRef.current && rendererRef.current) {
            layoutRef.current.setGraph(updatedGraph.nodes, updatedGraph.edges);
            rendererRef.current.updateGraph(layoutRef.current.getNodes(), layoutRef.current.getEdges(), visibleTypes);

            const updatedNodeId = `file::${data.file}`;
            rendererRef.current.flyToNode(updatedNodeId, layoutRef.current.getNodes());
          }
        }
      } catch (err) {
        console.warn("Failed to parse live event:", err);
      }
    };

    return () => {
      eventSource.close();
      if (layoutRef.current) layoutRef.current.stop();
      if (rendererRef.current) rendererRef.current.dispose();
    };
  }, [handleNodeSelection, visibleTypes]);

  // Update layout when visibility checkboxes change
  const handleToggleLayer = (types: string[]) => {
    const nextTypes = new Set(visibleTypes);
    const anyEnabled = types.some((t) => nextTypes.has(t));

    if (anyEnabled) {
      types.forEach((t) => nextTypes.delete(t));
    } else {
      types.forEach((t) => nextTypes.add(t));
    }

    setVisibleTypes(nextTypes);

    if (layoutRef.current && rendererRef.current) {
      rendererRef.current.updateGraph(layoutRef.current.getNodes(), layoutRef.current.getEdges(), nextTypes);
      layoutRef.current.restart();
    }
  };

  // Node Selection Handler
  async function handleNodeSelection(nodeId: string) {
    try {
      const res = await fetch(`/api/akg/node?id=${encodeURIComponent(nodeId)}`);
      const details = await res.json();

      setSelectedNode(details.node);
      setNeighbors(details.neighbors || []);

      if (rendererRef.current) {
        rendererRef.current.setSelection(nodeId);
      }

      // If in path target selection mode, set target
      if (isPathSelecting) {
        setIsPathSelecting(false);
        triggerPathTrace(selectedNode?.id || "", nodeId);
      }
    } catch (err) {
      console.error("Failed to fetch node details:", err);
    }
  }

  // Search input typing handler
  const handleSearchChange = async (val: string) => {
    setSearchQuery(val);
    if (val.trim().length > 1) {
      const matches = await akgClient.searchNodes(val);
      setSuggestions(matches);
    } else {
      setSuggestions([]);
    }
  };

  // Click search suggestion
  const handleSelectSuggestion = (node: AkgNode) => {
    setSearchQuery("");
    setSuggestions([]);
    handleNodeSelection(node.id);

    if (rendererRef.current && layoutRef.current) {
      rendererRef.current.flyToNode(node.id, layoutRef.current.getNodes());
    }
  };

  // Reset visual mode back to Explore graph
  const resetToExplore = () => {
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
  };

  // Trigger Focus Mode (Radial subgraph around selected)
  const triggerFocusMode = async (nodeId: string) => {
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
  };

  // Trigger Change Impact Mode
  const triggerImpactMode = async (nodeId: string) => {
    setVisualMode("impact");
    try {
      const data = await akgClient.getImpact(nodeId);
      setImpactReport(data.report);
      setCycleLoops(data.cycles);

      const direct = data.report.directlyAffected.map((d) => d.id);
      const transitive = data.report.transitivelyAffected.map((t) => t.id);

      if (layoutRef.current && rendererRef.current) {
        // Run standard physics but isolate outlines in renderer
        layoutRef.current.applyDefaultLayout();
        rendererRef.current.setVisualMode("impact", {
          directImpactIds: direct,
          transitiveImpactIds: transitive,
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Trigger Path Mode (linear chain traversal)
  const triggerPathTrace = async (sourceId: string, targetId: string) => {
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
  };

  // Trigger Topo Mode (dependency layers)
  const triggerTopoMode = async () => {
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
          maxTopoDepth: Math.max(...result.entries.map((e) => e.depth)),
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Render MiniMap component
  const MiniMap = () => {
    const mapCanvasRef = useRef<HTMLCanvasElement>(null);
    const miniMapTimerRef = useRef(0);
    useEffect(() => {
      const canvas = mapCanvasRef.current;
      if (!canvas || !layoutRef.current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Throttle minimap redraw to 5fps
      const now = Date.now();
      if (now - miniMapTimerRef.current < 200) return;
      miniMapTimerRef.current = now;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const nodes = layoutRef.current.getNodes();
      if (nodes.length === 0) return;

      // Calculate bounds
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const n of nodes) {
        if (n.x === undefined || n.y === undefined) continue;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }

      const graphW = maxX - minX || 1;
      const graphH = maxY - minY || 1;
      const scale = Math.min((canvas.width - 16) / graphW, (canvas.height - 16) / graphH);

      // Draw dots
      for (const n of nodes) {
        if (n.x === undefined || n.y === undefined) continue;
        const cx = (n.x - minX) * scale + 8;
        const cy = (n.y - minY) * scale + 8;

        ctx.fillStyle = n.id === selectedNode?.id ? "#ef4444" : "#6366f1";
        ctx.beginPath();
        ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }, []);

    return (
      <div className="minimap-overlay">
        <div className="minimap-title">Mini Map</div>
        <div className="minimap-canvas-holder">
          <canvas ref={mapCanvasRef} width={140} height={116} style={{ display: "block" }} />
        </div>
      </div>
    );
  };

  return (
    <div className="atlas-app">
      {/* Header Bar */}
      <header className="atlas-header">
        <div className="atlas-logo">
          <span>⬡</span> Astrivya Atlas
        </div>

        {/* Search Input widget */}
        <div className="search-container">
          <Search className="search-icon" size={16} />
          <input
            type="text"
            className="search-input"
            placeholder="Search symbols, files, functions..."
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

        {/* Mode Toolbars */}
        <div className="toolbar-container">
          <button className={`toolbar-btn ${visualMode === "explore" ? "active" : ""}`} onClick={resetToExplore}>
            <Compass size={14} /> Explore
          </button>
          <button
            className={`toolbar-btn ${visualMode === "focus" ? "active" : ""}`}
            disabled={!selectedNode}
            onClick={() => selectedNode && triggerFocusMode(selectedNode.id)}
          >
            <Crosshair size={14} /> Focus Neighborhood
          </button>
          <button
            className={`toolbar-btn ${visualMode === "impact" ? "active" : ""}`}
            disabled={!selectedNode}
            onClick={() => selectedNode && triggerImpactMode(selectedNode.id)}
          >
            <Activity size={14} /> Blast Impact
          </button>
          <button className={`toolbar-btn ${visualMode === "topo" ? "active" : ""}`} onClick={triggerTopoMode}>
            <Layers size={14} /> Dependency
          </button>
        </div>
      </header>

      {/* Left Sidebar Checklist */}
      <aside className="atlas-panel left-sidebar">
        <h2>Knowledge Layers</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {KNOWLEDGE_LAYERS.map((layer) => {
            const isEnabled = layer.types.some((t) => visibleTypes.has(t));
            return (
              <div
                key={layer.name}
                className={`layer-item ${isEnabled ? "" : "disabled"}`}
                onClick={() => handleToggleLayer(layer.types)}
              >
                <div className="layer-info">
                  <span className="layer-color-dot" style={{ backgroundColor: layer.color }} />
                  {layer.name}
                </div>
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={() => {}} // Controlled by div click
                  style={{ accentColor: "var(--accent-primary)", cursor: "pointer" }}
                />
              </div>
            );
          })}
        </div>

        <h2>Community Clusters ({communities.length})</h2>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            maxHeight: "150px",
            overflowY: "auto",
            fontSize: "12px",
            paddingRight: "4px",
            marginBottom: "15px",
          }}
        >
          {communities.length === 0 ? (
            <p style={{ fontStyle: "italic", fontSize: "12px", color: "var(--text-dim)" }}>No clusters detected.</p>
          ) : (
            communities.map((c) => (
              <div key={c.id} className="relation-item" style={{ borderLeftColor: "var(--accent-purple)" }}>
                <span>{c.label}</span>
                <span style={{ color: "var(--text-dim)", fontSize: "10px" }}>{c.nodeCount} nodes</span>
              </div>
            ))
          )}
        </div>

        <h2>Graph Overview</h2>
        <div style={{ fontSize: "13px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div className="inspector-detail-row">
            <span className="inspector-detail-label">Active Visual Mode</span>
            <span
              className="inspector-detail-value"
              style={{ color: "var(--accent-cyan)", textTransform: "uppercase" }}
            >
              {visualMode}
            </span>
          </div>
          <div className="inspector-detail-row">
            <span className="inspector-detail-label">Render Framework</span>
            <span className="inspector-detail-value">PixiJS v8 / WebGL</span>
          </div>
          <div className="inspector-detail-row">
            <span className="inspector-detail-label">Layout Solver</span>
            <span className="inspector-detail-value">d3-force</span>
          </div>
        </div>
      </aside>

      {/* Center canvas panel */}
      <main className="atlas-canvas-container">
        <div ref={canvasRef} className="atlas-canvas" />

        {/* MiniMap Layer */}
        <MiniMap />

        {/* Impact HUD Overlay */}
        {visualMode === "impact" && impactReport && (
          <div className="impact-overlay-hud">
            <div className="impact-hud-label">Risk Blast Score</div>
            <div
              className="impact-hud-score"
              style={{
                color: impactReport.riskScore > 0.65 ? "var(--accent-red)" : "var(--accent-amber)",
              }}
            >
              {impactReport.riskScore.toFixed(2)}{" "}
              <span style={{ fontSize: "14px", color: "var(--text-dim)" }}>/ 1.0</span>
            </div>
            <p style={{ maxWidth: "260px", fontSize: "12px" }}>{impactReport.summary}</p>
          </div>
        )}

        {/* Path Traversal HUD Overlay */}
        {visualMode === "path" && pathResult && (
          <div className="impact-overlay-hud" style={{ border: "1px solid var(--accent-amber)" }}>
            <div className="impact-hud-label">Relationship Path Trace</div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: "600",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {pathResult.nodes.length} nodes{" "}
              <span style={{ color: "var(--text-dim)", fontWeight: "normal" }}>
                ({pathResult.totalWeight.toFixed(1)} hops)
              </span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                fontSize: "11px",
                fontFamily: "var(--font-mono)",
                opacity: 0.85,
              }}
            >
              {pathResult.nodes.map((n, idx) => (
                <div key={n.id} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <span style={{ color: "var(--accent-emerald)" }}>[{n.type}]</span>
                  <span>{n.label}</span>
                  {idx < pathResult.nodes.length - 1 && (
                    <ChevronRight size={10} style={{ color: "var(--accent-amber)" }} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Topo HUD Overlay */}
        {visualMode === "topo" && topoResult && (
          <div className="impact-overlay-hud" style={{ border: "1px solid var(--accent-primary)" }}>
            <div className="impact-hud-label">Dependency Layers</div>
            <div style={{ fontSize: "14px", fontWeight: "600" }}>{topoResult.entries.length} files</div>
            {topoResult.entries.length > 0 && (
              <div style={{ fontSize: "11px", color: "var(--text-dim)", marginTop: "4px" }}>
                Layers: {new Set(topoResult.entries.map((e) => e.depth)).size} · Cycle files:{" "}
                {topoResult.cycleNodeIds.length}
              </div>
            )}
            {topoResult.cycleNodeIds.length > 0 && (
              <div
                style={{
                  marginTop: "8px",
                  fontSize: "11px",
                  color: "var(--accent-red)",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <AlertTriangle size={12} /> Cyclic dependencies detected
              </div>
            )}
          </div>
        )}
      </main>

      {/* Right Sidebar Inspector panel */}
      <aside className="atlas-panel right-sidebar">
        <h2>Symbol Inspector</h2>
        {selectedNode ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px", height: "100%" }}>
            <div className="inspector-header">
              <span
                className="inspector-type"
                style={{
                  backgroundColor: "var(--bg-hover)",
                  border: "1px solid var(--border-color)",
                }}
              >
                {selectedNode.type}
              </span>
              <h3
                style={{
                  marginTop: "12px",
                  fontFamily: "var(--font-mono)",
                  wordBreak: "break-all",
                }}
              >
                {selectedNode.label}
              </h3>
              <p
                style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-dim)",
                  marginTop: "4px",
                  wordBreak: "break-all",
                }}
              >
                {selectedNode.id}
              </p>
            </div>

            {/* Git Metadata Details Card if available */}
            <div>
              <h3>Metadata Metrics</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "10px" }}>
                <div className="inspector-detail-row">
                  <span className="inspector-detail-label">Git Commits Churn</span>
                  <span className="inspector-detail-value">{selectedNode.churnRate || 0} / mo</span>
                </div>
                <div className="inspector-detail-row">
                  <span className="inspector-detail-label">Contributor Count</span>
                  <span className="inspector-detail-value">{selectedNode.contributorCount || 0}</span>
                </div>
                <div className="inspector-detail-row">
                  <span className="inspector-detail-label">Community ID</span>
                  <span className="inspector-detail-value">
                    {selectedNode.community !== null && selectedNode.community !== undefined
                      ? selectedNode.community
                      : "None"}
                  </span>
                </div>
              </div>
            </div>

            {/* Neighbor Relationships list */}
            <div>
              <h3>Relationships ({neighbors.length})</h3>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  marginTop: "10px",
                  maxHeight: "180px",
                  overflowY: "auto",
                  paddingRight: "4px",
                }}
              >
                {neighbors.length === 0 ? (
                  <p style={{ fontStyle: "italic", fontSize: "12px" }}>No connection edges found.</p>
                ) : (
                  neighbors.map((r, idx) => (
                    <div key={idx} className="relation-item" onClick={() => handleNodeSelection(r.node.id)}>
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontWeight: "600", color: "var(--text-primary)" }}>{r.node.label}</span>
                        <span style={{ fontSize: "10px", color: "var(--text-dim)" }}>{r.node.type}</span>
                      </div>
                      <span className="relation-type">
                        {r.direction === "out" ? "➔" : "←"} {r.relation}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Circular loops warn overlay if present */}
            {visualMode === "impact" && cycleLoops.length > 0 && (
              <div className="cycle-warning-card">
                <div className="cycle-warning-title">
                  <AlertTriangle size={14} /> Circular Loops Detect
                </div>
                <div className="cycle-path-list">
                  {cycleLoops.slice(0, 3).map((c, idx) => (
                    <div key={idx} style={{ padding: "4px 0" }}>
                      • {c.path.map((p) => p.split("::").pop()?.split("/").pop()).join(" ➔ ")}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons list */}
            <div className="inspector-actions">
              <button className="action-btn" onClick={() => triggerFocusMode(selectedNode.id)}>
                <Crosshair size={16} /> Focus Neighborhood
              </button>

              <button
                className="action-btn"
                style={{
                  backgroundColor: "rgba(239, 68, 68, 0.15)",
                  borderColor: "rgba(239, 68, 68, 0.3)",
                }}
                onClick={() => triggerImpactMode(selectedNode.id)}
              >
                <Activity size={16} /> Blast Impact Radius
              </button>

              {isPathSelecting ? (
                <button className="action-btn danger" onClick={() => setIsPathSelecting(false)}>
                  <RefreshCw size={16} className="animate-spin" /> Click path target node...
                </button>
              ) : (
                <button className="action-btn secondary" onClick={() => setIsPathSelecting(true)}>
                  <GitBranch size={16} /> Trace path from here
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "60%",
              color: "var(--text-dim)",
              gap: "10px",
            }}
          >
            <Info size={32} />
            <p style={{ textAlign: "center" }}>
              Click any node on the graph viewport to inspect its architectural details.
            </p>
          </div>
        )}
      </aside>

      {/* Bottom Status bar */}
      <footer className="atlas-status-bar">
        <div className="status-indicator">
          <div className="status-dot" />
          <span>Local Serve Link Connected</span>
        </div>
        {stats && (
          <div style={{ display: "flex", gap: "20px" }}>
            <span>Nodes: {stats.nodes}</span>
            <span>Edges: {stats.edges}</span>
            <span>Chunks: {stats.chunks}</span>
            <span>Size: {(stats.dbSize / 1024 / 1024).toFixed(2)} MB</span>
          </div>
        )}
        <div style={{ display: "flex", gap: "15px" }}>
          <span>FPS: {fps}</span>
          <span>{settled ? "Layout settled" : "Layout animating..."}</span>
          <span>WebGL 2 Active</span>
        </div>
      </footer>
    </div>
  );
}
