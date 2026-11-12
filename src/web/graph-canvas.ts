/**
 * 60 FPS Interactive Maltego-Style Knowledge Graph Canvas Renderer
 * Supports Pan/Zoom, Node Dragging, Contagion Path Highlighting, and Shockwave Particles.
 */

import type {
  GraphEdge,
  GraphNode,
  NodeTier,
  SimulationResult,
} from "../core/types.js";

interface PositionedNode {
  node: GraphNode;
  x: number;
  y: number;
  radius: number;
}

const TIER_X_RATIO: Record<NodeTier, number> = {
  ACTOR: 0.12,
  MACRO_EQUITY: 0.34,
  INFRA_STABLE: 0.56,
  CRYPTO_ASSET: 0.78,
  NARRATIVE: 0.91,
};

const TIER_COLORS: Record<NodeTier, string> = {
  ACTOR: "#d8b876", // Warm Gold
  MACRO_EQUITY: "#5d909b", // Steel Cyan
  INFRA_STABLE: "#9b7ec8", // Institutional Violet
  CRYPTO_ASSET: "#8caa6b", // Sage Green
  NARRATIVE: "#c98a5b", // Amber Copper
};

export class MaltegoGraphCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: PositionedNode[] = [];
  private nodeMap = new Map<string, PositionedNode>();
  private edges: GraphEdge[] = [];
  private activeSimulation: SimulationResult | null = null;
  private selectedNodeId: string | null = null;
  private hoveredNodeId: string | null = null;

  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private isDraggingCanvas = false;
  private draggingNode: PositionedNode | null = null;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private animFrame = 0;
  private startTime = performance.now();
  private onSelectNode: (nodeId: string | null) => void;

  constructor(
    canvas: HTMLCanvasElement,
    onSelectNode: (nodeId: string | null) => void,
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.onSelectNode = onSelectNode;

    this.bindEvents();
    this.resize();
    this.startLoop();
  }

  setData(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.edges = edges;
    const width = this.canvas.clientWidth || 1000;
    const height = this.canvas.clientHeight || 620;

    // Group nodes by tier for clean layered Maltego layout
    const byTier = new Map<NodeTier, GraphNode[]>();
    for (const n of nodes) {
      const list = byTier.get(n.tier) ?? [];
      list.push(n);
      byTier.set(n.tier, list);
    }

    const oldPos = new Map(
      this.nodes.map((p) => [p.node.id, { x: p.x, y: p.y }]),
    );
    this.nodes = [];
    this.nodeMap.clear();

    for (const [tier, tierNodes] of byTier.entries()) {
      const baseX = width * TIER_X_RATIO[tier];
      const count = tierNodes.length;
      const spacing = Math.min(72, (height - 90) / Math.max(1, count));
      const startY = (height - spacing * (count - 1)) / 2;

      tierNodes.forEach((n, idx) => {
        const prev = oldPos.get(n.id);
        // Deterministic slight horizontal stagger for readability
        const stagger = (idx % 2 === 0 ? -1 : 1) * 18;
        const pNode: PositionedNode = {
          node: n,
          x: prev?.x ?? baseX + stagger,
          y: prev?.y ?? startY + idx * spacing,
          radius: 13 + n.systemicWeight * 9,
        };
        this.nodes.push(pNode);
        this.nodeMap.set(n.id, pNode);
      });
    }
  }

  setSimulation(sim: SimulationResult | null): void {
    this.activeSimulation = sim;
    if (sim) {
      this.selectedNodeId = sim.triggerNodeId;
    }
  }

  selectNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 900;
    const h = this.canvas.clientHeight || 600;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }

  private findNodeAt(wx: number, wy: number): PositionedNode | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const p = this.nodes[i];
      const dx = wx - p.x;
      const dy = wy - p.y;
      if (dx * dx + dy * dy <= (p.radius + 6) * (p.radius + 6)) {
        return p;
      }
    }
    return null;
  }

  private bindEvents(): void {
    window.addEventListener("resize", () => this.resize());

    this.canvas.addEventListener("mousedown", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x, y } = this.screenToWorld(sx, sy);
      const hit = this.findNodeAt(x, y);

      this.lastMouseX = sx;
      this.lastMouseY = sy;

      if (hit) {
        this.draggingNode = hit;
        this.selectedNodeId = hit.node.id;
        this.onSelectNode(hit.node.id);
      } else {
        this.isDraggingCanvas = true;
      }
    });

    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this.draggingNode) {
        const dx = (sx - this.lastMouseX) / this.zoom;
        const dy = (sy - this.lastMouseY) / this.zoom;
        this.draggingNode.x += dx;
        this.draggingNode.y += dy;
      } else if (this.isDraggingCanvas) {
        this.panX += sx - this.lastMouseX;
        this.panY += sy - this.lastMouseY;
      } else {
        const { x, y } = this.screenToWorld(sx, sy);
        const hit = this.findNodeAt(x, y);
        this.hoveredNodeId = hit?.node.id ?? null;
        this.canvas.style.cursor = hit ? "pointer" : "grab";
      }

      this.lastMouseX = sx;
      this.lastMouseY = sy;
    });

    window.addEventListener("mouseup", () => {
      this.draggingNode = null;
      this.isDraggingCanvas = false;
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.09 : 0.92;
        const nextZoom = Math.max(0.45, Math.min(2.6, this.zoom * factor));

        this.panX = sx - ((sx - this.panX) / this.zoom) * nextZoom;
        this.panY = sy - ((sy - this.panY) / this.zoom) * nextZoom;
        this.zoom = nextZoom;
      },
      { passive: false },
    );
  }

  private startLoop(): void {
    const render = (now: number) => {
      this.draw((now - this.startTime) / 1000);
      this.animFrame = requestAnimationFrame(render);
    };
    this.animFrame = requestAnimationFrame(render);
  }

  destroy(): void {
    cancelAnimationFrame(this.animFrame);
  }

  private draw(elapsedSec: number): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth || 900;
    const h = this.canvas.clientHeight || 600;

    // Background
    ctx.fillStyle = "#111315";
    ctx.fillRect(0, 0, w, h);

    // Subtle institutional grid
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 1;
    const gridStep = 48 * this.zoom;
    const offX = ((this.panX % gridStep) + gridStep) % gridStep;
    const offY = ((this.panY % gridStep) + gridStep) % gridStep;
    ctx.beginPath();
    for (let x = offX; x < w; x += gridStep) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = offY; y < h; y += gridStep) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Build contagion edge lookup if simulation active
    const simEdgeSet = new Set<string>();
    const simNodeImpact = new Map<string, number>();
    if (this.activeSimulation) {
      simNodeImpact.set(
        this.activeSimulation.triggerNodeId,
        this.activeSimulation.shockPct,
      );
      for (const a of this.activeSimulation.affectedNodes) {
        simNodeImpact.set(a.nodeId, a.expectedMovePct);
        for (let i = 0; i < a.path.length - 1; i++) {
          simEdgeSet.add(`${a.path[i]}->${a.path[i + 1]}`);
        }
      }
    }

    // 1. Draw Edges
    for (const e of this.edges) {
      const s = this.nodeMap.get(e.source);
      const t = this.nodeMap.get(e.target);
      if (!s || !t) continue;

      const isSimPath = simEdgeSet.has(`${e.source}->${e.target}`);
      const isSelectedAdj =
        this.selectedNodeId === e.source || this.selectedNodeId === e.target;

      let stroke = "rgba(160, 172, 184, 0.16)";
      let lw = 1 + e.weight * 1.2;

      if (isSimPath) {
        const isNeg = (this.activeSimulation?.shockPct ?? 0) < 0;
        stroke = isNeg
          ? "rgba(207, 106, 106, 0.85)"
          : "rgba(140, 170, 107, 0.85)";
        lw = 2.4;
      } else if (isSelectedAdj) {
        stroke =
          e.origin === "CAUSAL_ENGINE"
            ? "rgba(93, 144, 155, 0.85)"
            : "rgba(216, 184, 118, 0.72)";
        lw = 2;
      } else if (e.origin === "CAUSAL_ENGINE") {
        stroke = "rgba(93, 144, 155, 0.35)";
      }

      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      if (e.origin === "NEWS_HYPOTHESIS") ctx.setLineDash([4, 4]);
      else ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrowhead near target
      const angle = Math.atan2(t.y - s.y, t.x - s.x);
      const ax = t.x - Math.cos(angle) * (t.radius + 4);
      const ay = t.y - Math.sin(angle) * (t.radius + 4);
      ctx.fillStyle = stroke;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(
        ax - 7 * Math.cos(angle - 0.35),
        ay - 7 * Math.sin(angle - 0.35),
      );
      ctx.lineTo(
        ax - 7 * Math.cos(angle + 0.35),
        ay - 7 * Math.sin(angle + 0.35),
      );
      ctx.closePath();
      ctx.fill();

      // Animated shockwave particle along active contagion edge
      if (isSimPath) {
        const progress = (elapsedSec * 0.65) % 1;
        const px = s.x + (t.x - s.x) * progress;
        const py = s.y + (t.y - s.y) * progress;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Draw Nodes
    for (const p of this.nodes) {
      const isSelected = p.node.id === this.selectedNodeId;
      const isHovered = p.node.id === this.hoveredNodeId;
      const impact = simNodeImpact.get(p.node.id);
      const baseColor = TIER_COLORS[p.node.tier];

      // Outer glow if impacted or selected
      if (isSelected || impact !== undefined) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius + 6, 0, Math.PI * 2);
        ctx.fillStyle =
          impact !== undefined
            ? impact < 0
              ? "rgba(207, 106, 106, 0.25)"
              : "rgba(140, 170, 107, 0.25)"
            : "rgba(216, 184, 118, 0.25)";
        ctx.fill();
      }

      // Main circle
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = "#1b1e22";
      ctx.fill();
      ctx.lineWidth = isSelected || isHovered ? 2.8 : 1.6;
      ctx.strokeStyle =
        impact !== undefined ? (impact < 0 ? "#cf6a6a" : "#8caa6b") : baseColor;
      ctx.stroke();

      // Label
      ctx.font = "600 11px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#e6e8ea";
      ctx.fillText(p.node.ticker ?? p.node.label, p.x, p.y + p.radius + 13);

      // Impact badge
      if (impact !== undefined) {
        const badge = `${impact > 0 ? "+" : ""}${impact.toFixed(1)}%`;
        ctx.font = "700 10px monospace";
        ctx.fillStyle = impact < 0 ? "#ff8a8a" : "#a8d182";
        ctx.fillText(badge, p.x, p.y - p.radius - 6);
      }
    }

    ctx.restore();
  }
}
