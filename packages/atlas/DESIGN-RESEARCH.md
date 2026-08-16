# Astrivya Atlas — Design Research Report

**Fusing six graph tools into one interaction model, visual language, and layout strategy for a PixiJS 8 + d3-force + React knowledge-graph app.**

*Research date: 2026-08-15 · Sources: primary docs (Neo4j Bloom, Obsidian help, Kumu docs, Kineviz help center, Wikidata data model, Gephi/ForceAtlas2 paper), graph-drawing aesthetics literature, decision-provenance tooling survey.*

---

## 0. Thesis

Atlas today renders everything at once (1,822 nodes now, 16k in the KG) and hopes the user finds a node. The six references agree on the opposite: **the graph is a query surface, not a poster.** The guiding philosophy — *beautiful at 20 nodes, useful at 20,000* — is only achievable by **never rendering more than ~300 nodes at full fidelity, and making everything else a search, an aggregate, or deferred**. Empirically, force-directed layouts become hairballs at just 20–100 nodes (Yoghourdjian; Ghoniem); edge crossings are the single most damaging aesthetic (Purchase 1997); a 100° of path-bendiness costs ~1.7s vs 0.65s per crossing (Ware 2002). Calm is not decoration — it is the *only* legible scale.

---

## 1. Per-tool teardowns (why each is beautiful)

### 1.1 Neo4j Bloom — the interaction model (⭐ #1 reference)

- **Core loop:** search-first. Empty state offers two doors — *"Show a graph snippet"* or *"Search the graph"*. The search bar accepts four input classes: **search phrase, graph pattern, full-text, actions**. Typing builds a *near-natural-language pattern* from a vocabulary of node labels, relationship types, and property keys with proactive step-by-step suggestions (start label → property filter w/ datatype hint → relationship type in/out → end node → play). Results land in a **Scene** — not the whole graph, just what was asked for.
- **Exploration is expansion:** select a node → right-click → **Expand** by relationship *type and direction* ("expand only `decided` edges out"), or Advanced Expansion (paths, node types, node limits). Everything in the scene is user-curated: **Dismiss, Dismiss others, Clear Scene, Invert selection, Fit to selection, Undo/Redo** are typed actions. Filters **grey out** (still visible, non-interactive) then can be **Dismiss-filtered**.
- **Perspective = curated visual language:** a named lens mapping labels→categories, choosing which properties/relationships are visible (hidden props leave the search vocabulary), and storing per-category color/icon/caption + saved search phrases. Auto-generated perspectives identify "the smallest number of labels that uniquely categorize all nodes."
- **Rule-based styling:** single (condition→color/size/caption, with a **histogram** over numeric props), range (green→red spectrum), unique values (distinct color per value).
- **Caps that protect beauty:** 10,000-record result cap, per-expansion node limits, mini-map, dynamic caption scaling (text size ∝ node size), shortest-path search within 20 hops.
- **Why it's beautiful:** every pixel has provenance — the scene is *the answer to a question*, never noise. Restraint is enforced by the interaction, not willpower.

### 1.2 Obsidian Graph — personal-KG simplicity (⭐ #2 reference)

- **Two graphs, one surface:** the global graph is *decorative* (a starfield); the **local graph is the query** — an ego view around the active note with a **depth slider** (1–5 hops). "The global graph is decorative; the local graph is a query."
- **The signature beauty move — foreground/background:** hovering a node highlights its neighbors and **dims everything else** to context. Calm = see the context, not the clutter.
- **Styling discipline:** circles = notes, lines = links; node size ∝ degree (incoming references); near-monochrome dark canvas; **labels fade in by zoom band** (text fade threshold); color enters ONLY via user-defined groups (query → color). No 3D, no glow, no shapes. "Dots, not shapes."
- **Tunable forces, settle-then-freeze:** center force (compactness/circularity), repel force, link force, link distance. Recommended starters: center 0.50, repel 0.00, link 1.00, distance 30. The simulation **settles and goes dead quiet** — jittery graphs feel broken.
- **Documented failures (design lessons, not bugs):** hairball past ~50 nodes, reliably unreadable ~500; no typed edges, no clustering, no hierarchy, no label-overlap management; clicking a node *steals focus* to the editor (top complaint); the "poster problem" — graphs people screenshot but don't navigate.
- **Why it's beautiful:** radical restraint. One reserved semantic channel (color), one metric (degree), and a zoom-band label budget. Its failures prove untyped flat graphs can't scale past a few hundred nodes — Atlas must ship typed edges + hierarchy.

### 1.3 Kumu — visual cleanliness + semantic encoding (⭐ #3 reference)

- **Interaction — "walk the map":** click-and-hold to **focus** on an element, walk in/out **by degree** with `+`/`-`/number keys (`3` = 3 degrees out), `esc` returns; direction configurable (in/out/all). **Prompted mode** lets a viewer literally type `Bill Gates out 3` to build a map. Hover = **showcase** (highlight + mute the rest). Presentations are **slides, each with its own focus/filter** — the map unfolds beat by beat.
- **Meaning-is-the-encoding:** `Size by` a numeric field, `Color by` any field, `Shape by`, icons; multi-valued fields render as **flags** (colored arcs around an element). Built-in metrics (degree, indegree, outdegree, betweenness, closeness) feed the same channels.
- **Edge grammar (maps 1:1 to Atlas relations):** width/`strength` (0..1), dash, **curvature (0..1)**, arrows, labels, delay ticks for causal loops — direction *and* kind readable at a glance.
- **Curated palettes, not rainbows:** default `neon2` = 7 colors; `paired`/`set2` scale to 10–11 categories; curated sequential/diverging scales (`bujumbra`, `deepsea`, `heat`, `stoplight`).
- **Layout:** gravity + particle-charge + connection-length forces with a "layout grammar" — and three named presets: **auto, dense, hairball** (they literally name Obsidian's failure mode). Decluttering is discrete mechanisms (focus/filter/cluster/showcase/layer), not slider soup.
- **Documented failures:** busy maps at hundreds of elements (heavy curation is the product); layout tweaks don't persist; link inflation ("plausible" connections make maps messy) → *weight and type your edges, de-emphasize weak ones*.
- **Why it's beautiful:** typography-driven whitespace, flat curated palettes, and the discipline that *the default view must be small — start focused, expand on demand.*

### 1.4 GraphXR (Kineviz) — advanced exploration

- **Interaction:** a 3D "functionally infinite" project space; full-text search → results by category → click = **fly-to/center**; right-click selection grammar (floating/leaf/neighbor nodes — repeat for more hops; child/parent); **Expand with relationships; Trace Neighbor** slider (N hops); **Find Path** (start/end sets, optional weight) → **Spotlight Path**; **Inverse → Hide** isolates a lineage; **Collection Nodes** collapse single-edge runs; pin + force-disable for manual choreography.
- **The algorithm→property→encoding loop (the deepest lesson):** graph algorithms *write results back as node properties* — `pageRank, betweenness, closeness, eigenvector, componentId, louvainComponentId` — then you color/size/scatter by them. Computation is a column; styling is a mapping.
- **Styling:** named **sequential scales** (BuPu on a numeric field: pale blue → dark purple); node size by property ("your biggest customers are literally the biggest circles"); edge **Bind Width** scales by numeric property; distance-based caption fade.
- **Layout:** force with exposed sliders (link strength/distance, gravity, charge, collision, **Z-compress**); **parametric** (scatter by X/Y/Z properties); geometric (line/grid/circle/spiral/cube/spring/ring/tree); distribution by property. 3D exists to buy *density breathing room*, not gimmickry. Caps: 50k nodes/50k edges.
- **Why it's beautiful:** cinematic camera idioms (fly-to, spotlight), and the discipline that every continuous measure gets a *named sequential scale* and a size encoding.

### 1.5 Wikidata — semantic/data-model richness

- **The model that makes edges honest:** a **Statement** = Claim (property→value) + **qualifiers** + **references** + **rank** (preferred/normal/deprecated). "Wikidata doesn't state facts; it states that *a source* states a fact." Disagreement is first-class — conflicting values coexist.
- **Reification (the big idea):** in SPARQL, `p:` (statement node), `ps:` (value), `pq:` (qualifier), `pr:` (reference) — **the edge becomes a vertex.** Population 3.5M is not a bare edge: it carries `point in time → 2005`, `method → census`, `stated in → source`. Every edge is an attribute bag + a confidence chain.
- **Qualifiers as readable edge context:** "Louis XIV — position held → King of France (start 1643, end 1715)" — multi-hop paths carry *property names per hop*, not bare nodes.
- **Query-then-render:** results style themselves via `#defaultView:` tags and `?rgb`/`?layer` columns — *styling is computed in the query, shareable as a URL*.
- **Why it's rich:** because provenance is a *structural* concern (edge → vertex), not a string field. This is the exact model Atlas needs for `decides / affects / supersedes`.

### 1.6 Gephi — graph algorithms & layout

- **The pipeline:** Data Lab → **Statistics** (each run writes a node/edge column: degree, betweenness, eigenvector, PageRank, closeness, clustering coefficient, modularity_class) → **Layout** (watch live, stop by hand) → **Appearance** → **Filters** → Preview. "Query" = run algorithm → look → re-tune → restyle.
- **The classic beauty recipe (Jacomy):** (1) ForceAtlas2 with gravity≈0.05, stop when stable; (2) run Modularity/Louvain → `modularity_class`; (3) color by Partition → modularity class, regenerate palette; (4) size by Ranking → degree (min 3, max 15) or betweenness (10–50); (5) optional LinLog + Prevent Overlap; (6) labels proportional to size, small font + **halo outline**; (7) curved edges, edge opacity 60–70%, black background.
- **ForceAtlas2 parameters (transferable numbers):** **scaling** (repulsion) default 10 for <100 nodes, 2 for ≥100; **gravity** (pulls to center, stops islands drifting) default 1.0, tune 0.05–5; **linLog** (log attraction ≈ Newman modularity placement — visually clusters); **dissuadeHubs** (hubs → periphery, authorities central); **preventOverlap** as post-pass; **edgeWeightInfluence** 0/1/>1; **tolerance/speed** 0.1 (<5k) / 1 (≤50k); Barnes-Hut θ=1.2 above ~1,000 nodes. Fruchterman-Reingold (1–1k), Yifan Hu (multilevel, 100–100k), OpenOrd (5-phase annealing, 100–1M, auto-stops).
- **Louvain:** modularity Q; resolution γ <1 → fewer/bigger clusters, >1 → more/smaller; resolution limit swallows small communities → prefer **Leiden** for guaranteed-connected clusters.
- **Spatial memory (most underrated insight):** positions persist across restyling; you never re-randomize a converged layout. Gephi's maps are *trusted* because they don't reshuffle.

---

## 2. Beauty principles — distilled, ranked, actionable

1. **Progressive disclosure / search-first scenes (Bloom).** Render only what was asked. Every rung reachable from a search bar. *"Beautiful at 20" is a consequence of never showing 20,000.*
2. **Foreground/background emphasis (Obsidian, Kumu showcase).** Hover/select = highlight connected subgraph, dim the rest. Context without clutter. This is the single cheapest, highest-impact technique.
3. **Typed, styled edges (Kumu).** Arrows + curvature + dash + width-for-weight on *semantic* relations; grey, thin, straight for structural ones. Edge crossings are the #1 perceptual killer — minimize by typing and bundling.
4. **Degree-scaled nodes (Obsidian, Gephi).** `radius = a + b·sqrt(degree)`, range ≤5x, baseline ≥3px. Hubs emerge; nothing dominates.
5. **Curated flat palette + one reserved channel (Obsidian, Kumu).** ~10-hue categorical ramp for node types; a distinct ramp for status/provenance; alarm hue reserved for contradiction/cycles. No rainbows.
6. **Zoom-band label LOD (Obsidian text fade, Bloom caption scaling).** Labels fade in only when legible; budget ≤40/screen; top-degree + focused nodes first; everything else on hover.
7. **Settle-then-freeze physics (Obsidian).** Force sim goes quiet when done; jitter reads as broken. Cache converged positions forever (**spatial memory**, Gephi).
8. **Edge provenance as visual channels (Wikidata).** Qualifiers → tiny edge labels; confidence → opacity/thickness; superseded → dash; contradiction → reserved hue. Status visible at every rung.
9. **Algorithms write columns, styling maps them (Gephi, GraphXR).** Precompute degree/betweenness/community/recency; encode instantly. Never run layout-blind.
10. **Aggregation before rendering (Cambridge funnel, yFiles).** Filter @1M+ → aggregate @100K → visual model 10K–1K → declutter ~100 → layout. Atlas's real cap is ~300 interactive nodes; beyond that, supernodes + heat.

---

## 3. Design recommendation for Astrivya Atlas

### 3.1 Interaction model — Bloom's search-first scene, Kumu's walk-the-map, Obsidian's local-graph

Replace the current "render-everything + mode pills" with a **scene model**:

- **Rung 0 — Atlas (overview):** aggregates only. Cluster the 16k nodes by repo/folder/community into **supernodes** (count, type histogram, dominant color); density heat where local density >15%; cross-cluster edges as thin bundles. No labels. Minimap + region select. This replaces the current full-graph render.
- **Rung 1 — Search-first:** a type-aware search bar building patterns from the AKG vocabulary — `ADR decided by Person`, `function implements Interface`, `document affects file`. Type-ahead with suggestions (Bloom). Empty state: *"Show a graph snippet"* or *"Search the graph."* Result = a 20–80-node scene at full fidelity.
- **Rung 2 — Focus/expand:** select a node → hover = **foreground/background** emphasis; **expand by relationship type + direction** (`+1`, `+2`, reset — keyboard: Kumu's `+`/`-`/numbers/esc); `2` = two hops of `decides/affects/references`. Keep scene ≤150–300 nodes; 2-hop default, 3-hop warns. Dismiss/Dismiss-others/Clear-Scene typed actions. Breadcrumb trail + back/forward history.
- **Rung 3 — Inspect:** graph dims to a spine; a side panel takes over — node record, backlinks + unlinked mentions (Obsidian), reverse-chronological activity timeline (Linear), relations list (blocks/related/duplicate + sub-decisions), provenance strip (author, date, commit → PR → issue). **Clicking a node never steals focus** — Obsidian's cardinal sin.

**Decision-provenance flow (the product's reason to exist):** search `why did we choose Redis` → scene: ADR + decider + affected files → click ADR → panel shows context, deciders, status (accepted/superseded), backlinks (meeting notes), timeline (created → files touched → superseding ADR) → click the `supersedes` edge → scene re-centers on the newer decision. Two interactions, four rungs, full provenance.

### 3.2 Visual language

- **Node geometry:** circles ("dots not shapes"). Radius ∝ degree: `r = 3.5 + 2.2·sqrt(deg)` for leaves→hubs (existing theme is 4–8px; keep, but make degree-driven). Shape is a *secondary* channel — reserved for one semantic case (e.g. decision = small square or diamond).
- **Node color:** curated ~10-hue categorical ramp mapped to type (keep current indigo-family, but flatten to perceptual evenness — no two hues adjacent on the wheel). **Status ramp** for ADRs/decisions: proposed=amber, accepted=green, superseded/deprecated=gray+dash, **contradiction=reserved red** (keep `#e2574c` as the alarm; nothing else uses it). Neutral-dominant canvas (`#0a0c12`) — color only encodes meaning.
- **Edges:** grey `rgba(58,58,68,0.12)`, width 1 for structural (`contains`, `imports`); colored, arrowed, curved, width-scaled for semantic (`decides`, `affects`, `supersedes`, `references`). Dash = superseded/deprecated. Edge labels (tiny, 8–9px) only in rung 2 (≤150 nodes) for qualifier-rich edges (e.g. `affects · via ADR-004 · 2026-08`).
- **Typography:** existing Inter 10px labels, but add **halo/outline** (Gephi Preview) so labels read over edges; fade in by zoom band (keep `lodZooms`, raise the top budget from 40 → ~60 when settled, always ≤40 mid-zoom). Node captions scale with node size (Bloom).
- **Glow/halo:** keep the additive halo but *use it semantically* — on focus/inspect, not hover (hover = ring only). One glow at a time = readability.

### 3.3 Layout strategy — two-phase force with spatial memory

Keep the two-phase d3-force (unclump → refine) but parameterize it Gephi-style:

- **Unclump phase:** link distance 70→**90**, charge −160, theta 1.2, α-decay 0.03. Run link+charge only.
- **Refine phase** (α<0.25): add collide (radius 22), community centroid (0.04), group centroid (0.025) — current values are good; add **prevent-overlap post-pass** and **dissuadeHubs-style** handling so ADR/person authorities stay central and files go peripheral.
- **Spatial memory:** cache converged positions; on re-render or live updates, *incremental* re-layout from cached coords — never re-randomize (Gephi's trust-building insight). Persist camera + layout state (Kumu's failure).
- **Rung-aware layout:** rung 2 focus = egocentric rings by BFS distance (current `applyFocusLayout`; ring spacing 180 → 150, cap at 3 rings); path mode = straight spine (keep 180 spacing) with curved side-edges; topo mode stays layered.
- **Scale ceiling:** hard cap interactive scene ~300 nodes; above that, aggregate. Never let the renderer chase Gephi's 1M — PixiJS instancing + culling gets you 50k, but *perceptual* scale is the binding constraint.

### 3.4 Semantic layers — provenance-first, Wikidata-style

The AKG already has the raw material (15 node types, 23 relations, per-edge `confidence`/`extractionMethod`, node `churnRate`/`contributorCount`/`community`). Surface it:

- **Reify the decision spine:** `Person --decided--> Decision --decides/affects--> File/Function --implements--> Commit`, plus `Decision --supersedes--> Decision` (the built-in contradiction edge) and `Decision --blocks/enables--> Decision`. The Wikidata lesson: treat `decides/affects/supersedes` edges as **edges with qualifiers** — approvedBy, via-ADR, date, status — and render qualifiers as edge labels or tiny badges, not prose.
- **Algorithm→column→encoding loop (Gephi/GraphXR):** precompute per node: degree, **betweenness** (bridging decisions), eigenvector/PageRank (influence), **community** (already there), **recency** (last modified), **churn** (already there). Encode: size=degree/betweenness, color=type (identity) + status ramp (decision state), edge opacity=confidence, dash=superseded.
- **Confidence as a channel:** `confidence < 0.8` → reduced edge opacity + a subtle dotted texture; `superseded` → dash; **contradiction** → reserved red. Disagreement stays visible (Wikidata's "conflicting values coexist").
- **The invisible-author fix (provenance survey):** AI-authored changes must not dead-end at a human reviewer — link agent + prompt/sidecar + generated edge, so the blame chain survives the 46–60% AI-written reality.
- **Live agent mesh** stays a distinct visual class (docked panel + `agent_message` nodes) — it's the *present*, the graph is the *memory*; don't let live updates reshuffle the layout (use incremental + fly-to, current behavior is already correct).

### 3.5 Concrete parameters (drop-in for `theme.ts` / `force-layout.ts`)

| Channel | Value |
|---|---|
| Interactive scene cap | ≤300 nodes, 2-hop default expand |
| Overview | supernodes + density heat, 0 labels |
| Node radius | `3.5 + 2.2·sqrt(degree)`, clamp [3, 16] |
| Categorical palette | 10 hues, perceptually even, from current indigo family; flat (no glow) |
| Status ramp | accepted `#3ecf8e`, proposed `#e2a14f`, superseded gray `#6b6b76`+dash, contradiction `#e2574c` |
| Structural edges | `rgba(58,58,68,0.12)` w1 straight |
| Semantic edges | arrow + curve 0.2–0.35, width 1.5–3 by weight/confidence |
| Edge label | only ≤150-node scenes, 8–9px, halo |
| Label LOD | fade-in bands; budget 40 (zoom) / 60 (settled) |
| Forces | link 90, charge −160, θ 1.2, collide 22, community 0.04, group 0.025, settle α<0.005 |
| Spatial memory | persist converged coords; incremental re-layout; persist camera |
| Palette source | Kumu `paired`/`set2`-style 10-class + Gephi dark Preview preset |

---

## 4. Risks / open questions

- **Scope creep is the real risk.** Scene model + search grammar + supernodes + provenance panel is ~2–3 months of focused work. Ship order: (1) search-first scenes + expand-by-type (the philosophy), (2) foreground/background emphasis + degree sizing (the beauty), (3) spatial memory + camera persistence (the trust), (4) supernode overview (the scale), (5) provenance panel + status/dash encodings (the differentiator).
- **Search grammar must be autogenerated** from AKG types, or it rots (Bloom auto-generates perspectives; do the same for the search vocabulary + "smallest label set that uniquely categorizes").
- **Perf ceilings:** 50k nodes is GraphXR's browser cap — Atlas's real target (perceptual) is ~300 interactive / ~20k aggregate. Document it as a budget, not a hope.
- **Don't copy Obsidian's poster problem:** every surface must be reachable from the search bar, or the graph is decoration.