/**
 * routing.js — path generation between two nodes.
 *
 * Path structure:
 *   [startEdge] → [EXIT_CLEARANCE px straight out] →
 *   [manhattan segments via user waypoints, avoiding other nodes] →
 *   [EXIT_CLEARANCE px straight in] → [endEdge]
 *
 * Connections store `waypoints: [{x,y,isJunction?}]` — user-placed
 * intermediate points.  The full computed `path` is rebuilt whenever
 * nodes or waypoints change.
 */

import { edgePoint, nodeBounds, snapToGrid } from "./geometry.js";

export const EXIT_CLEARANCE = 100; // px straight out from node edge before turning
const WALL_STOP_OFFSET = 50;       // px outside node wall where travel dot stops
const JUNCTION_ARM = 40;           // px cardinal arm from junction points before turning
const NODE_MARGIN = 30;            // extra buffer around obstacle nodes

/** Unit vectors for stored cardinal slots. */
const _SLOT_VEC = {
  north: { x:  0, y: -1 },
  south: { x:  0, y:  1 },
  east:  { x:  1, y:  0 },
  west:  { x: -1, y:  0 },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the full world-space path array for a connection.
 *
 * @param {object}   fromNode  – node data {x,y,width,height,shape}
 * @param {object}   toNode    – node data
 * @param {object[]} waypoints – user waypoints [{x,y,isJunction?}], may be []
 * @param {object}   allNodes  – full node dict keyed by id (for avoidance)
 * @param {number}   gridSize
 * @returns {{x:number,y:number}[]}
 */
/**
 * @param {object|null}  fromNode  – node data or null if start is a waypoint pos
 * @param {object|null}  toNode    – node data or null if end is a waypoint pos
 * @param {object[]}     waypoints – user waypoints [{x,y,isJunction?}]
 * @param {object}       allNodes  – full node dict keyed by id (obstacle avoidance)
 * @param {number}       gridSize
 * @param {{x,y}|null}  fromPos   – explicit start position (bypasses node edge + exit arm)
 * @param {{x,y}|null}  toPos     – explicit end position   (bypasses node edge + entry arm)
 */
export function buildPath(fromNode, toNode, waypoints = [], allNodes = {}, gridSize = 100, fromPos = null, toPos = null, existingPaths = [], fromSlot = null, toSlot = null) {
  const snap   = v => snapToGrid(v, gridSize);
  const others = Object.values(allNodes).filter(n =>
    (fromNode ? n.id !== fromNode.id : true) &&
    (toNode   ? n.id !== toNode.id   : true)
  );

  // ── Resolve the two path endpoints ─────────────────────────────────────────
  // startEdge / endEdge: exact perimeter or waypoint position (path first/last point)
  // exits / entry: snapped point EXIT_CLEARANCE px out from the node, or the
  //                snapped waypoint position itself when no node is involved

  let startEdge, exits, endEdge, entry;

  // Figure out what the "other end" looks like for edge-point direction calcs
  const roughEnd   = toPos   ?? (toNode   ? { x: toNode.x,   y: toNode.y   } : null);
  const roughStart = fromPos ?? (fromNode ? { x: fromNode.x, y: fromNode.y } : null);

  if (fromPos) {
    startEdge      = fromPos;
    const fwdTarget = waypoints[0] ?? roughEnd ?? fromPos;
    const fwdDir    = (fromSlot && _SLOT_VEC[fromSlot]) ? _SLOT_VEC[fromSlot] : _cardinalUnit(fromPos, fwdTarget);
    // Do NOT snap the arm endpoint — snapping a 40px offset on a 100px grid
    // would collapse it back to the junction position, eliminating the arm.
    exits = { x: fromPos.x + fwdDir.x * JUNCTION_ARM,
              y: fromPos.y + fwdDir.y * JUNCTION_ARM };
  } else {
    const target = waypoints[0] ?? roughEnd ?? { x: fromNode.x, y: fromNode.y };
    const se     = edgePoint(fromNode, target);
    const ep     = _exitPoint(fromNode, se, roughEnd ?? target);
    exits        = { x: snap(ep.x), y: snap(ep.y) };
    // Pull stop point WALL_STOP_OFFSET px outward from the node wall
    const sdx = exits.x - se.x, sdy = exits.y - se.y;
    const slen = Math.hypot(sdx, sdy) || 1;
    startEdge = { x: se.x + (sdx / slen) * WALL_STOP_OFFSET, y: se.y + (sdy / slen) * WALL_STOP_OFFSET };
  }

  if (toPos) {
    endEdge        = toPos;
    const bkTarget  = waypoints[waypoints.length - 1] ?? roughStart ?? toPos;
    const bkDir     = (toSlot && _SLOT_VEC[toSlot]) ? _SLOT_VEC[toSlot] : _cardinalUnit(toPos, bkTarget);
    // Do NOT snap — same reason as exits above.
    entry = { x: toPos.x + bkDir.x * JUNCTION_ARM,
              y: toPos.y + bkDir.y * JUNCTION_ARM };
  } else {
    const target = waypoints[waypoints.length - 1] ?? roughStart ?? { x: toNode.x, y: toNode.y };
    const ee     = edgePoint(toNode, target);
    const ep     = _exitPoint(toNode, ee, roughStart ?? target);
    entry        = { x: snap(ep.x), y: snap(ep.y) };
    // Pull stop point WALL_STOP_OFFSET px outward from the node wall
    const edx = entry.x - ee.x, edy = entry.y - ee.y;
    const elen = Math.hypot(edx, edy) || 1;
    endEdge = { x: ee.x + (edx / elen) * WALL_STOP_OFFSET, y: ee.y + (edy / elen) * WALL_STOP_OFFSET };
  }

  // ── Build path ──────────────────────────────────────────────────────────────
  const wpts        = waypoints.map(p => ({ x: snap(p.x), y: snap(p.y) }));
  const checkpoints = [exits, ...wpts, entry];

  const path = [startEdge];
  if (!_samePoint(startEdge, exits)) path.push(exits);

  for (let i = 0; i < checkpoints.length - 1; i++) {
    const segs = _manhattanAvoid(checkpoints[i], checkpoints[i + 1], others, gridSize, 0, existingPaths);
    for (let j = 1; j < segs.length; j++) path.push(segs[j]);
  }

  if (!_samePoint(entry, endEdge)) path.push(endEdge);

  return _dedup(path);
}

export function pointAtDistance(path, d) {
  let rem = d;
  for (let i = 0; i < path.length - 1; i++) {
    const a   = path[i];
    const b   = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (rem <= len) {
      const t = len > 0 ? rem / len : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    rem -= len;
  }
  return { ...path[path.length - 1] };
}

export function pathLength(path) {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
  }
  return total;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compute the exit arm endpoint: EXIT_CLEARANCE px outward from the node,
 * along the edge-normal direction.  Clamped so it never exceeds 30% of the
 * total start→end distance (prevents arms crossing on close nodes).
 */
function _exitPoint(node, edgePt, oppositePt) {
  const b    = nodeBounds(node);
  const dx   = edgePt.x - b.cx;
  const dy   = edgePt.y - b.cy;
  const nlen = Math.hypot(dx, dy) || 1;
  const maxDist = oppositePt
    ? Math.max(10, Math.hypot(oppositePt.x - edgePt.x, oppositePt.y - edgePt.y) * 0.3)
    : EXIT_CLEARANCE;
  const dist = Math.min(EXIT_CLEARANCE, maxDist);
  return {
    x: edgePt.x + (dx / nlen) * dist,
    y: edgePt.y + (dy / nlen) * dist,
  };
}

/**
 * Return a 2- or 3-point Manhattan path from a to b that avoids obstacle
 * bounding boxes.  Falls back to the best of the two elbow options if all
 * detour attempts fail.  depth limits recursion to 2 levels.
 */
function _manhattanAvoid(a, b, obstacles, gridSize, depth = 0, existingPaths = []) {
  if (_samePoint(a, b)) return [a];
  const snap = v => snapToGrid(v, gridSize);

  // Combined score: node intersections (hard, weight 100) + path crossings (soft, weight 1)
  const score = p => _pathScore(p, obstacles) * 100 + _pathCrossScore(p, existingPaths);

  // Axis-aligned: straight line is the only option, but may need a detour
  if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) {
    const straight = [a, b];
    if (score(straight) === 0 || depth >= 2) return straight;
    const horiz   = Math.abs(a.y - b.y) < 1;
    const offsets = [gridSize * 3, -gridSize * 3, gridSize * 5, -gridSize * 5];
    let best = straight, bestScore = score(straight);
    for (const off of offsets) {
      const via = horiz
        ? { x: snap((a.x + b.x) / 2), y: snap(a.y + off) }
        : { x: snap(a.x + off),        y: snap((a.y + b.y) / 2) };
      const combined = [
        ..._manhattanAvoid(a,   via, obstacles, gridSize, depth + 1, existingPaths),
        ..._manhattanAvoid(via, b,   obstacles, gridSize, depth + 1, existingPaths).slice(1),
      ];
      const s = score(combined);
      if (s < bestScore) { best = _dedup(combined); bestScore = s; }
      if (bestScore === 0) break;
    }
    return best;
  }

  const elbow1 = { x: b.x, y: a.y };
  const elbow2 = { x: a.x, y: b.y };
  const path1  = [a, elbow1, b];
  const path2  = [a, elbow2, b];
  const s1     = score(path1);
  const s2     = score(path2);

  if (s1 === 0) return path1;
  if (s2 === 0) return path2;

  // Try detouring around hard node obstacles
  if (depth < 2) {
    for (const obs of obstacles) {
      const bounds = _expanded(obs, NODE_MARGIN);
      if (!_pathBlockedBy(path1, bounds) && !_pathBlockedBy(path2, bounds)) continue;
      const rest    = obstacles.filter(o => o !== obs);
      const detours = [
        { x: snap(bounds.cx),                y: snap(bounds.top    - NODE_MARGIN) },
        { x: snap(bounds.cx),                y: snap(bounds.bottom + NODE_MARGIN) },
        { x: snap(bounds.left  - NODE_MARGIN), y: snap(bounds.cy)  },
        { x: snap(bounds.right + NODE_MARGIN), y: snap(bounds.cy)  },
      ];
      for (const via of detours) {
        const combined = [
          ..._manhattanAvoid(a,   via, rest, gridSize, depth + 1, existingPaths),
          ..._manhattanAvoid(via, b,   rest, gridSize, depth + 1, existingPaths).slice(1),
        ];
        if (_pathScore(combined, [obs]) === 0) return _dedup(combined);
      }
    }
  }

  return s1 <= s2 ? path1 : path2;
}

function _pathScore(path, obstacles) {
  let score = 0;
  for (const obs of obstacles) {
    const bounds = _expanded(obs, NODE_MARGIN);
    for (let i = 0; i < path.length - 1; i++) {
      if (_segIntersectsRect(path[i], path[i + 1], bounds)) score++;
    }
  }
  return score;
}

/**
 * Count how many times a path crosses segments of existing connection paths.
 * Two orthogonal segments cross only when one is horizontal and the other
 * vertical and they genuinely intersect (not just touch at a junction point).
 */
function _pathCrossScore(path, existingPaths) {
  let score = 0;
  for (const existing of existingPaths) {
    if (!existing?.length) continue;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      for (let j = 0; j < existing.length - 1; j++) {
        const c = existing[j], d = existing[j + 1];
        if (_segsIntersect(a, b, c, d)) score++;
      }
    }
  }
  return score;
}

function _pathBlockedBy(path, bounds) {
  for (let i = 0; i < path.length - 1; i++) {
    if (_segIntersectsRect(path[i], path[i + 1], bounds)) return true;
  }
  return false;
}

function _expanded(node, margin) {
  const b = nodeBounds(node);
  return {
    left:   b.left   - margin,
    right:  b.right  + margin,
    top:    b.top    - margin,
    bottom: b.bottom + margin,
    cx:     b.cx,
    cy:     b.cy,
  };
}

/**
 * Cohen-Sutherland–style rectangle vs segment test.
 * Returns true if the segment (p1→p2) intersects the rect interior.
 */
function _segIntersectsRect(p1, p2, r) {
  if (Math.max(p1.x, p2.x) < r.left   || Math.min(p1.x, p2.x) > r.right)  return false;
  if (Math.max(p1.y, p2.y) < r.top    || Math.min(p1.y, p2.y) > r.bottom)  return false;

  const inside = p =>
    p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
  if (inside(p1) || inside(p2)) return true;

  // Check segment against all four edges
  const edges = [
    [{ x: r.left,  y: r.top    }, { x: r.right, y: r.top    }],
    [{ x: r.right, y: r.top    }, { x: r.right, y: r.bottom }],
    [{ x: r.right, y: r.bottom }, { x: r.left,  y: r.bottom }],
    [{ x: r.left,  y: r.bottom }, { x: r.left,  y: r.top    }],
  ];
  for (const [ea, eb] of edges) {
    if (_segsIntersect(p1, p2, ea, eb)) return true;
  }
  return false;
}

function _segsIntersect(p1, p2, p3, p4) {
  const d1 = _cross(p3, p4, p1);
  const d2 = _cross(p3, p4, p2);
  const d3 = _cross(p1, p2, p3);
  const d4 = _cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function _cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function _samePoint(a, b) {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
}

/** Unit vector in the dominant cardinal direction from `from` toward `to`. */
function _cardinalUnit(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
  return { x: 0, y: dy >= 0 ? 1 : -1 };
}

function _dedup(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1];
    if (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5) out.push(p);
  }
  return out;
}
