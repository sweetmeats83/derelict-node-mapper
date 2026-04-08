/**
 * geometry.js — shape math helpers.
 *
 * Core jobs:
 *  - nodeBounds(node)        → {left, top, right, bottom, cx, cy}
 *  - edgePoint(node, toward) → {x, y} on the node's perimeter nearest `toward`
 *  - hexPoints(cx, cy, r)    → polygon vertices for a flat-topped hexagon
 *  - diamondPoints(cx,cy,w,h)→ polygon vertices for a diamond
 *  - pointAlongPath(path, t) → {x,y} at fractional distance t ∈ [0,1]
 *  - pathLength(path)        → total arc length
 *  - pointAtDistance(path,d) → {x,y} at absolute pixel distance d
 */

// ── Bounding box ─────────────────────────────────────────────────────────────

export function nodeBounds(node) {
  const w  = node.width  ?? node.w  ?? 200;
  const h  = node.height ?? node.h  ?? 200;
  const cx = node.x;
  const cy = node.y;
  return {
    left:   cx - w / 2,
    top:    cy - h / 2,
    right:  cx + w / 2,
    bottom: cy + h / 2,
    cx,
    cy,
    w,
    h,
  };
}

// ── Edge intersection ─────────────────────────────────────────────────────────
/**
 * Returns the point on the node's perimeter (according to its shape) that lies
 * on the ray from the node centre toward `toward`.
 *
 * For circle/hex/diamond the maths differs slightly; for all rectangular shapes
 * we use the standard rect-edge projection.
 */
export function edgePoint(node, toward) {
  const b  = nodeBounds(node);
  const dx = toward.x - b.cx;
  const dy = toward.y - b.cy;
  if (!dx && !dy) return { x: b.cx, y: b.cy };

  const shape = node.shape ?? "circle";

  if (shape === "circle") {
    const r   = Math.min(b.w, b.h) / 2;
    const len = Math.hypot(dx, dy);
    return { x: b.cx + (dx / len) * r, y: b.cy + (dy / len) * r };
  }

  if (shape === "hex") {
    return hexEdgePoint(b.cx, b.cy, Math.min(b.w, b.h) / 2, dx, dy);
  }

  if (shape === "diamond") {
    return diamondEdgePoint(b.cx, b.cy, b.w / 2, b.h / 2, dx, dy);
  }

  // square / rounded — axis-aligned rectangle edge
  return rectEdgePoint(b, dx, dy);
}

function rectEdgePoint(b, dx, dy) {
  const hw = b.w / 2;
  const hh = b.h / 2;
  const tx = dx ? hw / Math.abs(dx) : Infinity;
  const ty = dy ? hh / Math.abs(dy) : Infinity;
  const t  = Math.min(tx, ty);
  return { x: b.cx + dx * t, y: b.cy + dy * t };
}

function hexEdgePoint(cx, cy, r, dx, dy) {
  // Flat-top hex: 6 edges. We check each edge segment and find the intersection.
  const verts = hexPoints(cx, cy, r);
  return polyEdgePoint(cx, cy, verts, dx, dy);
}

function diamondEdgePoint(cx, cy, hw, hh, dx, dy) {
  const verts = diamondPoints(cx, cy, hw * 2, hh * 2);
  return polyEdgePoint(cx, cy, verts, dx, dy);
}

function polyEdgePoint(cx, cy, verts, dx, dy) {
  // Ray from (cx,cy) in direction (dx,dy); find first intersection with polygon
  const len = verts.length;
  let best = null;
  let bestT = Infinity;
  for (let i = 0; i < len; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % len];
    const t = raySegmentIntersect(cx, cy, dx, dy, a.x, a.y, b.x, b.y);
    if (t !== null && t >= 0 && t < bestT) {
      bestT = t;
      best  = { x: cx + dx * t, y: cy + dy * t };
    }
  }
  return best ?? { x: cx + dx, y: cy + dy };
}

/**
 * Ray–segment intersection. Ray: P + t*(dx,dy). Segment: A + s*(B-A).
 * Returns t if intersection exists with s ∈ [0,1], else null.
 */
function raySegmentIntersect(px, py, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((ax - px) * ey - (ay - py) * ex) / denom;
  const s = ((ax - px) * dy  - (ay - py) * dx)  / denom;
  if (s < 0 || s > 1) return null;
  return t;
}

// ── Shape vertex generators ───────────────────────────────────────────────────

export function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6; // flat-top
    pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return pts;
}

export function diamondPoints(cx, cy, w, h) {
  return [
    { x: cx,       y: cy - h / 2 },
    { x: cx + w / 2, y: cy       },
    { x: cx,       y: cy + h / 2 },
    { x: cx - w / 2, y: cy       },
  ];
}

// ── Path math ─────────────────────────────────────────────────────────────────

export function pathLength(path) {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
  }
  return total;
}

export function pointAtDistance(path, distance) {
  let remaining = distance;
  for (let i = 0; i < path.length - 1; i++) {
    const a   = path[i];
    const b   = path[i + 1];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= seg) {
      const ratio = seg > 0 ? remaining / seg : 0;
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
    }
    remaining -= seg;
  }
  return { ...path[path.length - 1] };
}

export function pointAlongPath(path, t) {
  const total = pathLength(path);
  return pointAtDistance(path, total * Math.max(0, Math.min(1, t)));
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function snapToGrid(value, size) {
  if (!size) return value;
  return Math.round(value / size) * size;
}
