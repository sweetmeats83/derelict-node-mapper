/**
 * renderer.js — draws the full node map onto the map PIXI container.
 *
 * Called:
 *  - on canvasReady (full redraw)
 *  - after any node or connection is created / updated / deleted
 *
 * Everything here is pure PIXI.Graphics — no Foundry document creation.
 * Door icons are drawn procedurally so there are no external texture deps.
 *
 * Layer z-ordering inside mapContainer:
 *   z=0  connection lines
 *   z=10 node fills + borders
 *   z=20 node labels
 *   z=30 door icons (clickable for players)
 */

import { getMapContainer, getHandleContainer } from "./layer.js";
import { listNodes, listConnections } from "./flags.js";
import { nodeBounds, edgePoint, hexPoints, diamondPoints, pointAlongPath } from "./geometry.js";
import {
  DOOR_ICON_RADIUS,
  BLOCKING_TYPES,
  HIDDEN_TYPES,
  CONNECTION_TYPES,
} from "./constants.js";

// Callbacks set by nodeManager to avoid circular imports
let _onNodeDragEnd    = null;
let _onNodeRightClick = null;
let _onNodeConnect    = null;
let _isConnectMode    = () => false;

export function setNodeDragCallback(onDragEnd, onRightClick, onConnect, isConnectMode) {
  _onNodeDragEnd    = onDragEnd;
  _onNodeRightClick = onRightClick;
  _onNodeConnect    = onConnect;
  _isConnectMode    = isConnectMode ?? (() => false);
}

// Callbacks set by connectionManager for waypoint editing
let _onWaypointMove    = null;
let _onWaypointInsert  = null;
let _onWaypointDelete  = null;
let _onWaypointJunction = null;

export function setWaypointCallbacks(onMove, onInsert, onDelete, onJunction) {
  _onWaypointMove    = onMove;
  _onWaypointInsert  = onInsert;
  _onWaypointDelete  = onDelete;
  _onWaypointJunction = onJunction;
}

// Callback set by connectionManager to toggle hidden state
let _onSecretToggle = null;
export function setSecretToggleCallback(fn) { _onSecretToggle = fn; }

// ── Public entry point ────────────────────────────────────────────────────────

// Debounce handle — collapses burst calls (e.g. rebuildAllPaths) into one frame.
let _redrawPending = false;

// ── Geometry cache ────────────────────────────────────────────────────────────
// _computeDrawPaths and _computeCrossings are O(n²) in segments and are only
// needed when connection path geometry changes — not for color/type/hidden edits.
// Cache the results and reuse them when the path fingerprint is unchanged.
let _geoCache = { key: null, drawPaths: null, overHops: null, underGaps: null };

function _geoCacheKey(connList) {
  return connList.map(c => {
    const p = c.path ?? [];
    const n = p.length;
    const f = n > 0 ? `${p[0].x|0},${p[0].y|0}` : "";
    const l = n > 1 ? `${p[n-1].x|0},${p[n-1].y|0}` : "";
    return `${c.id}:${n}:${f}:${l}`;
  }).sort().join("|");
}

function _getGeo(connList) {
  const key = _geoCacheKey(connList);
  if (key === _geoCache.key) return _geoCache;
  const drawPaths = _computeDrawPaths(connList);
  const { overHops, underGaps } = _computeCrossings(connList, drawPaths);
  _geoCache = { key, drawPaths, overHops, underGaps };
  return _geoCache;
}

/**
 * Full redraw of the map.  Clears the container and redraws everything from
 * scene flags.  Calls are debounced to one animation frame so bulk operations
 * (rebuildAllPaths, translateMap, etc.) don't trigger dozens of redraws.
 */
export function redrawMap() {
  if (_redrawPending) return;
  _redrawPending = true;
  requestAnimationFrame(() => {
    _redrawPending = false;
    _redrawMapNow();
  });
}

function _redrawMapNow() {
  const container = getMapContainer();
  if (!container || container.destroyed) return;

  // Clear previous draw
  container.removeChildren().forEach(c => c.destroy({ children: true }));

  const scene = canvas?.scene;
  if (!scene) return;

  const nodes       = listNodes(scene);
  const connections = listConnections(scene);
  const isGM        = game.user?.isGM ?? false;

  // Compute visual draw paths (parallel offset) and crossing hop/gap points.
  // Results are cached by path geometry — reused when only visual props changed.
  const connList  = Object.values(connections);
  const { drawPaths, overHops, underGaps } = _getGeo(connList);

  // Draw "under" connections first, then "over" connections on top.
  // This ensures arch arcs are never covered by the line they bridge.
  const underConns = connList.filter(c => !overHops.get(c.id)?.length);
  const overConns  = connList.filter(c =>  overHops.get(c.id)?.length);

  for (const conn of [...underConns, ...overConns]) {
    drawConnection(container, conn, nodes, isGM,
      drawPaths.get(conn.id) ?? conn.path,
      overHops.get(conn.id)  ?? [],
      underGaps.get(conn.id) ?? []);
  }

  // Draw nodes on top
  for (const node of Object.values(nodes)) {
    drawNode(container, node, isGM);
  }

  // GM-only: invisible drag handles + waypoint handles in canvas.interface
  if (isGM) {
    const handles = getHandleContainer();
    if (handles && !handles.destroyed) {
      handles.removeChildren().forEach(c => c.destroy({ children: true }));
      for (const node of Object.values(nodes)) {
        drawNodeHandle(handles, node);
      }
      for (const conn of Object.values(connections)) {
        drawConnectionHandles(handles, conn);
      }
    }
  }
}

// ── Connection drawing ────────────────────────────────────────────────────────

// drawPath is the visually-offset path for rendering; conn.path is the stored
// path used for hit-testing and travel.
function drawConnection(container, conn, nodes, isGM, drawPath, hops = [], gaps = []) {
  const stops = conn.stops ?? [];
  if (stops.length < 2) return;
  if (conn.hidden && !isGM) return;

  const storedPath = conn.path;
  if (!Array.isArray(storedPath) || storedPath.length < 2) return;
  if (!Array.isArray(drawPath)   || drawPath.length < 2)   return;

  // ── Line ───────────────────────────────────────────────────────────────────
  // The stored path endpoints are pulled back from the node wall (travel stop position).
  // For rendering we extend the visual line all the way to the wall edge (stop.x/stop.y)
  // so the corridor appears to connect flush with the room.
  const firstStop = stops[0];
  const lastStop  = stops[stops.length - 1];
  let visualPath  = drawPath;
  if (firstStop?.nodeId && firstStop.x != null) {
    visualPath = [{ x: firstStop.x, y: firstStop.y }, ...visualPath.slice(1)];
  }
  if (lastStop?.nodeId && lastStop.x != null) {
    visualPath = [...visualPath.slice(0, -1), { x: lastStop.x, y: lastStop.y }];
  }

  const lineGfx  = new PIXI.Graphics();
  lineGfx.zIndex = 0;
  const color    = PIXI.utils.string2hex(conn.lineColor ?? "#00ffff");
  const width    = conn.lineWidth ?? 8;
  drawStroke(lineGfx, visualPath, color, width, conn.lineStyle ?? "solid", hops, gaps);
  container.addChild(lineGfx);

  // ── Door icons at terminal stops that have a nodeId ───────────────────────
  if (conn.type !== "corridor") {
    const allNodes  = listNodes(canvas.scene);

    if (firstStop?.nodeId) {
      const node = allNodes[firstStop.nodeId];
      const icon = makeDoorIcon(conn, _insetPoint(firstStop, node), isGM, firstStop.locked ?? false, firstStop.toll ?? false);
      if (icon) { icon.zIndex = 30; container.addChild(icon); }
    }
    if (lastStop?.nodeId) {
      const node = allNodes[lastStop.nodeId];
      const icon = makeDoorIcon(conn, _insetPoint(lastStop, node), isGM, lastStop.locked ?? false, lastStop.toll ?? false);
      if (icon) { icon.zIndex = 30; container.addChild(icon); }
    }
  }

  // ── One-way arrow ────────────────────────────────────────────────────────────
  if (conn.oneWay) {
    const arrow = _drawOneWayArrow(storedPath, color, width);
    if (arrow) { arrow.zIndex = 5; container.addChild(arrow); }
  }

  // ── GM-only secret/hidden eye toggle ────────────────────────────────────────
  if (isGM && (conn.hidden || conn.type === "secret")) {
    const eyeStops = [stops[0], stops[stops.length - 1]].filter(s => s && !s.nodeId);
    if (eyeStops.length > 0) {
      for (const s of eyeStops) _drawSecretEye(container, conn, s);
    } else {
      // Both terminals connect to nodes — draw at path midpoint
      const mid = storedPath[Math.floor(storedPath.length / 2)];
      if (mid) _drawSecretEye(container, conn, { x: mid.x, y: mid.y });
    }
  }

  // ── Junction stop icons ───────────────────────────────────────────────────
  for (let i = 1; i < stops.length - 1; i++) {
    const stop = stops[i];
    if (stop.kind !== "junction") continue;
    const accent = PIXI.utils.string2hex(conn.accentColor ?? conn.lineColor ?? "#ff9ff3");
    const jgfx   = new PIXI.Graphics();
    jgfx.zIndex  = 25;
    jgfx.position.set(stop.x, stop.y);
    jgfx.lineStyle({ width: 2.5, color: accent, alpha: 1 });
    jgfx.beginFill(0x000000, 0.65);
    jgfx.drawCircle(0, 0, DOOR_ICON_RADIUS);
    jgfx.endFill();
    jgfx.lineStyle({ width: 2, color: accent, alpha: 1 });
    jgfx.moveTo(0, -DOOR_ICON_RADIUS * 0.55);
    jgfx.lineTo(0, DOOR_ICON_RADIUS * 0.2);
    jgfx.moveTo(0, DOOR_ICON_RADIUS * 0.2);
    jgfx.lineTo(-DOOR_ICON_RADIUS * 0.5, DOOR_ICON_RADIUS * 0.6);
    jgfx.moveTo(0, DOOR_ICON_RADIUS * 0.2);
    jgfx.lineTo( DOOR_ICON_RADIUS * 0.5, DOOR_ICON_RADIUS * 0.6);
    jgfx._dnmConnectionId = conn.id;
    jgfx.eventMode = "static";
    container.addChild(jgfx);
  }
}

// ── Node drawing ──────────────────────────────────────────────────────────────

function drawNode(container, node, isGM = false) {
  const b     = nodeBounds(node);
  const fill  = PIXI.utils.string2hex(node.fillColor   ?? "#0a1c27");
  const border= PIXI.utils.string2hex(node.borderColor ?? "#00ffff");
  const bw    = node.borderWidth ?? 5;
  const shape = node.shape ?? "circle";

  const gfx   = new PIXI.Graphics();
  gfx.zIndex  = 10;
  gfx.lineStyle({ width: bw, color: border, alpha: 1, join: "round" });
  gfx.beginFill(fill, 1);

  switch (shape) {
    case "circle":
      gfx.drawEllipse(b.cx, b.cy, b.w / 2, b.h / 2);
      break;
    case "square":
      gfx.drawRect(b.left, b.top, b.w, b.h);
      break;
    case "rounded":
      gfx.drawRoundedRect(b.left, b.top, b.w, b.h, Math.min(b.w, b.h) * 0.15);
      break;
    case "diamond": {
      const pts = diamondPoints(b.cx, b.cy, b.w, b.h);
      drawPolygon(gfx, pts);
      break;
    }
    case "hex": {
      const pts = hexPoints(b.cx, b.cy, Math.min(b.w, b.h) / 2);
      drawPolygon(gfx, pts);
      break;
    }
    default:
      gfx.drawEllipse(b.cx, b.cy, b.w / 2, b.h / 2);
  }

  gfx.endFill();
  container.addChild(gfx);

  // ── Label (bold, all-caps) ────────────────────────────────────────────────
  const hasDesc  = Boolean(node.description?.trim());
  const labelStyle = new PIXI.TextStyle({
    fontFamily: node.fontFamily ?? "Orbitron, sans-serif",
    fontSize:   node.labelSize  ?? 22,
    fontWeight: "bold",
    fill:       node.labelColor ?? "#ffffff",
    align:      "center",
    wordWrap:   true,
    wordWrapWidth: b.w * 0.85,
  });
  if (node.label) {
    const labelText = new PIXI.Text((node.label ?? "").toUpperCase(), labelStyle);
    labelText.anchor.set(0.5, 0.5);
    // If there's a description, shift label up slightly so both fit
    const labelY = hasDesc
      ? b.cy + (node.labelOffset ?? 0) - (node.labelSize ?? 22) * 0.6
      : b.cy + (node.labelOffset ?? 0);
    labelText.position.set(b.cx, labelY);
    labelText.zIndex = 20;
    container.addChild(labelText);
  }

  // ── Description ───────────────────────────────────────────────────────────
  if (hasDesc) {
    const descStyle = new PIXI.TextStyle({
      fontFamily: node.fontFamily ?? "Orbitron, sans-serif",
      fontSize:   node.descriptionSize  ?? 14,
      fill:       node.descriptionColor ?? "#cccccc",
      align:      "center",
      wordWrap:   true,
      wordWrapWidth: b.w * 0.82,
    });
    const descText = new PIXI.Text(node.description, descStyle);
    descText.anchor.set(0.5, 0);
    const descY = hasDesc && node.label
      ? b.cy + (node.labelOffset ?? 0) + (node.labelSize ?? 22) * 0.1
      : b.cy + (node.labelOffset ?? 0);
    descText.position.set(b.cx, descY);
    descText.zIndex = 20;
    container.addChild(descText);
  }

  // ── GM-only onEnter trigger badge ─────────────────────────────────────────
  if (isGM && node.onEnter?.type) {
    _drawTriggerBadge(container, node.onEnter.type, b);
  }
}

/**
 * Draws a small colour-coded badge in the top-right corner of a node to
 * indicate that an onEnter trigger is configured.  GM-only.
 *   image   → amber  (I)
 *   scene   → green  (S)
 *   journal → violet (J)
 */
function _drawTriggerBadge(container, type, b) {
  const r  = 11;
  const bx = b.right - r * 0.6;
  const by = b.top   + r * 0.6;

  const color = type === "image"   ? 0xffaa00
              : type === "scene"   ? 0x44dd88
              :                      0xaa66ff;  // journal

  const letter = type === "image" ? "I" : type === "scene" ? "S" : "J";

  const gfx = new PIXI.Graphics();
  gfx.zIndex = 35;
  gfx.lineStyle({ width: 1.5, color: 0x000000, alpha: 0.7 });
  gfx.beginFill(color, 0.92);
  gfx.drawCircle(bx, by, r);
  gfx.endFill();
  container.addChild(gfx);

  const txt = new PIXI.Text(letter, new PIXI.TextStyle({
    fontFamily: "sans-serif",
    fontSize:   12,
    fontWeight: "bold",
    fill:       "#000000",
  }));
  txt.anchor.set(0.5, 0.5);
  txt.position.set(bx, by);
  txt.zIndex = 36;
  container.addChild(txt);
}

/**
 * Draw a filled arrowhead at the midpoint of a one-way connection path,
 * pointing in the direction of travel (stop[0] → stop[last]).
 */
function _drawOneWayArrow(path, color, lineWidth) {
  if (!path || path.length < 2) return null;

  // Find the midpoint along the path
  const mid = Math.floor(path.length / 2);
  const p0  = path[mid - 1] ?? path[0];
  const p1  = path[mid];

  const dx  = p1.x - p0.x;
  const dy  = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;

  const ux = dx / len;  // unit vector along path
  const uy = dy / len;
  const px = -uy;       // perpendicular
  const py =  ux;

  // Arrowhead size scales with line width, min 10px
  const size = Math.max(10, lineWidth * 2.2);
  const tip  = { x: p1.x + ux * size * 0.5, y: p1.y + uy * size * 0.5 };
  const bl   = { x: p1.x - ux * size + px * size * 0.6, y: p1.y - uy * size + py * size * 0.6 };
  const br   = { x: p1.x - ux * size - px * size * 0.6, y: p1.y - uy * size - py * size * 0.6 };

  const g = new PIXI.Graphics();
  g.beginFill(color, 0.9);
  g.moveTo(tip.x, tip.y);
  g.lineTo(bl.x,  bl.y);
  g.lineTo(br.x,  br.y);
  g.closePath();
  g.endFill();
  return g;
}

/**
 * GM-only eye icon drawn at a hidden/secret connection's floating terminal.
 * Open eye (teal)  = connection is currently visible to players (conn.hidden=false, but type=secret).
 * Closed eye (red) = connection is hidden from players (conn.hidden=true).
 * Clicking toggles conn.hidden via the _onSecretToggle callback.
 */
function _drawSecretEye(container, conn, stop) {
  const R       = 20;
  const isHidden = conn.hidden;
  const bgColor  = isHidden ? 0xcc2222 : 0x226688;
  const iconChar = isHidden ? "\uF070" : "\uF06E"; // fa-eye-slash / fa-eye

  // Background circle
  const gfx = new PIXI.Graphics();
  gfx.zIndex = 40;
  gfx.lineStyle({ width: 2, color: 0x000000, alpha: 0.8 });
  gfx.beginFill(bgColor, 0.92);
  gfx.drawCircle(stop.x, stop.y, R);
  gfx.endFill();
  container.addChild(gfx);

  // FontAwesome eye icon
  const icon = new PIXI.Text(iconChar, new PIXI.TextStyle({
    fontFamily: "Font Awesome 6 Free, FontAwesome",
    fontWeight: "900",
    fontSize:   20,
    fill:       "#ffffff",
  }));
  icon.anchor.set(0.5, 0.5);
  icon.position.set(stop.x, stop.y);
  icon.zIndex = 41;
  container.addChild(icon);

  // Hit area — make the whole circle clickable
  const hit = new PIXI.Graphics();
  hit.zIndex    = 42;
  hit.eventMode = "static";
  hit.cursor    = "pointer";
  hit.beginFill(0xffffff, 0.001);
  hit.drawCircle(stop.x, stop.y, R);
  hit.endFill();
  hit.on("pointerdown", (e) => {
    e.stopPropagation();
    if (_onSecretToggle) _onSecretToggle(conn.id);
  });
  container.addChild(hit);
}

// ── Door icon drawing ─────────────────────────────────────────────────────────

/**
 * Return a point offset inward from the path endpoint into the node interior.
 * path[0]/path[last] sits on the node wall — moving inward puts the icon on
 * the node side so it stays visible within token vision.
 * fromStart=true → offset from path[0] toward path[1] reversed (into node).
 * fromStart=false → offset from path[last] toward path[last-1] reversed.
 */
// How far inside the node wall the door icon sits.
// The stop's x,y is the wall edge; we push inward toward the node centre.
const DOOR_ICON_INSET = 30;

function _insetPoint(stop, node) {
  if (!stop || !node) return { x: stop?.x ?? 0, y: stop?.y ?? 0 };
  // Direction from wall edge toward node centre
  const dx  = node.x - stop.x;
  const dy  = node.y - stop.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: stop.x + (dx / len) * DOOR_ICON_INSET, y: stop.y + (dy / len) * DOOR_ICON_INSET };
}

/**
 * Returns a PIXI.Container with the door icon drawn at world position `point`.
 * Returns null for hidden connections when the user is not GM.
 */
function makeDoorIcon(conn, point, isGM, stopLocked = false, stopToll = false) {
  if (HIDDEN_TYPES.has(conn.type) && !isGM) return null;

  const r         = DOOR_ICON_RADIUS;
  const accent    = PIXI.utils.string2hex(conn.accentColor ?? conn.lineColor ?? "#00ffff");
  const isBlocked = stopLocked || BLOCKING_TYPES.has(conn.type);
  const alpha     = conn.hidden && isGM ? 0.45 : 1; // dim hidden icons for GM

  // For toll connections: show coin icon only on the tolled end, plain door on the other
  const iconType = (conn.type === "toll" && !stopToll) ? "door" : conn.type;

  const gfx     = new PIXI.Graphics();
  gfx.alpha     = alpha;
  gfx.position.set(point.x, point.y);

  // Outer circle — red tint if locked, gold tint if toll
  const rimColor = stopLocked ? 0xff4444 : (stopToll && conn.type === "toll") ? 0xffd84d : accent;
  gfx.lineStyle({ width: 2, color: rimColor, alpha: 1 });
  gfx.beginFill(0x000000, 0.65);
  gfx.drawCircle(0, 0, r);
  gfx.endFill();

  // Icon symbol
  drawIconSymbol(gfx, iconType, r, accent, isBlocked);

  // Make it interactive so players can click to travel
  gfx.eventMode = "static";
  gfx.cursor    = isBlocked ? "not-allowed" : "pointer";

  // Store metadata so click handlers can identify what was clicked
  gfx._dnmConnectionId = conn.id;
  gfx._dnmIconPoint    = { ...point };

  return gfx;
}

function drawIconSymbol(gfx, type, r, color, locked) {
  const inner = r * 0.55;
  gfx.lineStyle({ width: 1.5, color, alpha: 1 });

  switch (type) {
    case "door":
    default:
      // Simple door: rectangle
      gfx.drawRect(-inner * 0.6, -inner, inner * 1.2, inner * 2);
      // Door knob
      gfx.beginFill(color, 1);
      gfx.drawCircle(inner * 0.35, 0, inner * 0.18);
      gfx.endFill();
      break;

    case "locked":
      // Padlock outline
      gfx.drawRect(-inner * 0.6, 0, inner * 1.2, inner);
      gfx.moveTo(-inner * 0.3, 0);
      gfx.arc(0, 0, inner * 0.3, Math.PI, 0);
      break;

    case "sealed":
      // X through a rectangle
      gfx.drawRect(-inner * 0.6, -inner, inner * 1.2, inner * 2);
      gfx.moveTo(-inner * 0.4, -inner * 0.7);
      gfx.lineTo( inner * 0.4,  inner * 0.7);
      gfx.moveTo( inner * 0.4, -inner * 0.7);
      gfx.lineTo(-inner * 0.4,  inner * 0.7);
      break;

    case "airlock":
      // Circle with cross
      gfx.drawCircle(0, 0, inner);
      gfx.moveTo(-inner, 0); gfx.lineTo(inner, 0);
      gfx.moveTo(0, -inner); gfx.lineTo(0, inner);
      break;

    case "hatch":
      // Triangle (ladder/hatch symbol)
      gfx.moveTo(0, -inner);
      gfx.lineTo(inner * 0.8, inner * 0.7);
      gfx.lineTo(-inner * 0.8, inner * 0.7);
      gfx.closePath();
      break;

    case "junction":
      // Four-way node
      gfx.beginFill(color, 0.3);
      gfx.drawCircle(0, 0, inner);
      gfx.endFill();
      gfx.beginFill(color, 1);
      gfx.drawCircle(0, 0, inner * 0.35);
      gfx.endFill();
      break;

    case "secret":
      // Question mark styling — dashed circle
      gfx.lineStyle({ width: 1.5, color, alpha: 1 });
      gfx.drawCircle(0, 0, inner);
      gfx.beginFill(color, 1);
      gfx.drawCircle(0, inner * 0.55, inner * 0.15);
      gfx.endFill();
      gfx.moveTo(0, inner * 0.25);
      gfx.bezierCurveTo(0, -inner * 0.05, inner * 0.45, -inner * 0.05, inner * 0.45, -inner * 0.4);
      gfx.bezierCurveTo(inner * 0.45, -inner * 0.8, 0, -inner * 0.8, 0, -inner * 0.4);
      break;

    case "stairs": {
      // Three horizontal steps, bottom-left to top-right
      const sw = inner * 0.85;
      const sh = inner * 0.85;
      const step = sw / 3;
      gfx.lineStyle({ width: 1.5, color, alpha: 1 });
      // Step 1 (bottom)
      gfx.moveTo(-sw / 2,           sh / 2);
      gfx.lineTo(-sw / 2 + step,    sh / 2);
      gfx.lineTo(-sw / 2 + step,    sh / 2 - step);
      // Step 2 (middle)
      gfx.lineTo(-sw / 2 + step * 2, sh / 2 - step);
      gfx.lineTo(-sw / 2 + step * 2, sh / 2 - step * 2);
      // Step 3 (top)
      gfx.lineTo(sw / 2,            sh / 2 - step * 2);
      gfx.lineTo(sw / 2,            -sh / 2);
      break;
    }

    case "elevator": {
      // Rectangle with up/down arrows inside
      gfx.lineStyle({ width: 1.5, color, alpha: 1 });
      gfx.drawRect(-inner * 0.55, -inner, inner * 1.1, inner * 2);
      // Up arrow
      gfx.moveTo(-inner * 0.25, -inner * 0.15);
      gfx.lineTo(0,             -inner * 0.55);
      gfx.lineTo( inner * 0.25, -inner * 0.15);
      // Down arrow
      gfx.moveTo(-inner * 0.25,  inner * 0.15);
      gfx.lineTo(0,              inner * 0.55);
      gfx.lineTo( inner * 0.25,  inner * 0.15);
      break;
    }
    case "toll": {
      // Coin: circle with a "¢" cross inside
      gfx.lineStyle({ width: 1.5, color, alpha: 1 });
      gfx.drawCircle(0, 0, inner * 0.75);
      // Vertical bar through centre (credit symbol)
      gfx.moveTo(0, -inner * 0.55);
      gfx.lineTo(0,  inner * 0.55);
      // Small horizontal tick top
      gfx.moveTo(-inner * 0.25, -inner * 0.2);
      gfx.lineTo( inner * 0.25, -inner * 0.2);
      // Small horizontal tick bottom
      gfx.moveTo(-inner * 0.25,  inner * 0.2);
      gfx.lineTo( inner * 0.25,  inner * 0.2);
      break;
    }
  }

  // Locked overlay: red cross
  if (locked && type !== "locked" && type !== "sealed") {
    gfx.lineStyle({ width: 1.5, color: 0xff4444, alpha: 0.85 });
    gfx.moveTo(-inner * 0.55, -inner * 0.55);
    gfx.lineTo( inner * 0.55,  inner * 0.55);
    gfx.moveTo( inner * 0.55, -inner * 0.55);
    gfx.lineTo(-inner * 0.55,  inner * 0.55);
  }
}

// ── Node drag handle (canvas.interface, GM only) ──────────────────────────────

function drawNodeHandle(container, node) {
  const b = nodeBounds(node);

  // Invisible hit area covering the node bounds
  const hit = new PIXI.Graphics();
  hit.beginFill(0xffffff, 0.001); // nearly transparent but hittable
  hit.drawRect(b.left, b.top, b.w, b.h);
  hit.endFill();
  hit.eventMode = "static";
  hit.cursor    = "move";
  hit._dnmNodeId = node.id;

  // Drag state
  let dragging    = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let pointerId   = null;

  const _wp = ev => {
    const iface = canvas?.interface;
    if (!iface) return null;
    return ev.getLocalPosition?.(iface) ?? ev.data?.getLocalPosition?.(iface) ?? null;
  };

  hit.on("pointerdown", event => {
    const btn = event.button ?? event.data?.button ?? 0;

    // Right-click passes through — used by Foundry for canvas pan
    if (btn === 2) return;

    // Connect mode → register node selection, no drag
    if (_isConnectMode()) {
      if (_onNodeConnect) _onNodeConnect(node.id);
      event.stopPropagation();
      return;
    }

    // Normal left-click → start drag
    dragging    = true;
    pointerId   = event.pointerId ?? event.data?.pointerId;
    const pos   = _wp(event);
    if (!pos) return;
    dragOffsetX = pos.x - node.x;
    dragOffsetY = pos.y - node.y;
    event.stopPropagation();
  });

  hit.on("pointermove", event => {
    if (!dragging) return;
    const pid = event.pointerId ?? event.data?.pointerId;
    if (pid !== pointerId) return;
    const pos = _wp(event);
    if (!pos) return;
    const gs  = canvas.grid?.size ?? 100;
    const nx  = Math.round((pos.x - dragOffsetX) / gs) * gs;
    const ny  = Math.round((pos.y - dragOffsetY) / gs) * gs;
    // Move the handle visually while dragging
    hit.position.set(nx - node.x, ny - node.y);
  });

  hit.on("pointerup", event => {
    if (!dragging) return;
    dragging = false;
    const pid = event.pointerId ?? event.data?.pointerId;
    if (pid !== pointerId) return;
    const pos = _wp(event);
    if (!pos) return;
    const gs  = canvas.grid?.size ?? 100;
    const nx  = Math.round((pos.x - dragOffsetX) / gs) * gs;
    const ny  = Math.round((pos.y - dragOffsetY) / gs) * gs;
    hit.position.set(0, 0);
    if (_onNodeDragEnd) _onNodeDragEnd(node.id, nx, ny);
  });

  hit.on("pointerupoutside", () => {
    dragging = false;
    hit.position.set(0, 0);
  });

  container.addChild(hit);
}

// ── Parallel offset (schematic bundling) ─────────────────────────────────────

const CHANNEL_TOLERANCE = 16;  // px — lines within this distance are "same channel"
const CHANNEL_SPACING   = 11;  // px — gap between parallel lines (lineWidth 8 + 3px)

/**
 * Given all connection objects, returns a Map<connId, offsetPath> where
 * parallel overlapping segments are spread apart perpendicularly.
 * Stored paths are untouched — these are render-only.
 */
function _computeDrawPaths(conns) {
  // Build flat segment list
  const segs = [];
  for (const conn of conns) {
    const path = conn.path;
    if (!Array.isArray(path) || path.length < 2) continue;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const horiz = Math.abs(b.y - a.y) < 1;
      const vert  = Math.abs(b.x - a.x) < 1;
      if (!horiz && !vert) continue; // skip diagonals (shouldn't exist)
      segs.push({
        connId: conn.id,
        si:     i,
        ax: a.x, ay: a.y,
        bx: b.x, by: b.y,
        horiz,
      });
    }
  }

  // For each segment find its channel-mates and assign a perpendicular slot
  // slotMap: `connId:segIdx` → signed offset in px
  const slotMap = new Map();

  for (const seg of segs) {
    const key = `${seg.connId}:${seg.si}`;
    if (slotMap.has(key)) continue;

    // Collect all segments in the same channel (including this one)
    const channel = segs.filter(s => _sameChannel(s, seg));
    if (channel.length < 2) continue;

    // Sort deterministically so the same ordering appears every redraw
    channel.sort((a, b) =>
      a.connId < b.connId ? -1 : a.connId > b.connId ? 1 : a.si - b.si
    );

    const n = channel.length;
    channel.forEach((s, idx) => {
      // Centre the bundle around the original path line
      const offset = (idx - (n - 1) / 2) * CHANNEL_SPACING;
      slotMap.set(`${s.connId}:${s.si}`, offset);
    });
  }

  // Build per-connection offset paths
  const result = new Map();

  for (const conn of conns) {
    const path = conn.path;
    if (!Array.isArray(path) || path.length < 2) {
      result.set(conn.id, path);
      continue;
    }

    // For each point, accumulate the perpendicular offset contributions from
    // adjacent segments, then average.
    const ptDx = new Array(path.length).fill(0);
    const ptDy = new Array(path.length).fill(0);
    const ptCt = new Array(path.length).fill(0);

    for (let i = 0; i < path.length - 1; i++) {
      const off = slotMap.get(`${conn.id}:${i}`) ?? 0;
      if (off === 0) continue;
      const a = path[i], b = path[i + 1];
      const horiz = Math.abs(b.y - a.y) < 1;
      const sdx = horiz ? 0 : off;
      const sdy = horiz ? off : 0;
      ptDx[i]   += sdx; ptDy[i]   += sdy; ptCt[i]++;
      ptDx[i+1] += sdx; ptDy[i+1] += sdy; ptCt[i+1]++;
    }

    const drawPath = path.map((p, i) => ({
      x: p.x + (ptCt[i] ? ptDx[i] / ptCt[i] : 0),
      y: p.y + (ptCt[i] ? ptDy[i] / ptCt[i] : 0),
    }));

    result.set(conn.id, drawPath);
  }

  return result;
}

function _sameChannel(a, b) {
  if (a.connId === b.connId && a.si === b.si) return true;
  if (a.horiz !== b.horiz) return false;

  if (a.horiz) {
    // Both horizontal: y values within tolerance, x ranges overlap
    if (Math.abs(a.ay - b.ay) > CHANNEL_TOLERANCE) return false;
    const ax1 = Math.min(a.ax, a.bx), ax2 = Math.max(a.ax, a.bx);
    const bx1 = Math.min(b.ax, b.bx), bx2 = Math.max(b.ax, b.bx);
    return ax1 < bx2 && ax2 > bx1;
  } else {
    // Both vertical: x values within tolerance, y ranges overlap
    if (Math.abs(a.ax - b.ax) > CHANNEL_TOLERANCE) return false;
    const ay1 = Math.min(a.ay, a.by), ay2 = Math.max(a.ay, a.by);
    const by1 = Math.min(b.ay, b.by), by2 = Math.max(b.ay, b.by);
    return ay1 < by2 && ay2 > by1;
  }
}

// ── Crossing hop detection ────────────────────────────────────────────────────

const HOP_RADIUS = 10; // px — radius of the arc bump at a crossing

/**
 * Returns { overHops, underGaps }
 *
 * overHops:  Map<connId, [{segIdx, t, px, py, perpX, perpY}]>
 *   The connection with the later-sorted id draws an arch over the crossing.
 *
 * underGaps: Map<connId, [{segIdx, t, px, py}]>
 *   The connection with the earlier-sorted id draws a background-colored gap
 *   at the crossing so the arch above is clearly visible.
 *
 * Rule is deterministic regardless of draw order.
 */
function _computeCrossings(conns, drawPaths) {
  const overHops  = new Map();
  const underGaps = new Map();
  for (const conn of conns) { overHops.set(conn.id, []); underGaps.set(conn.id, []); }

  const list = conns.filter(c => {
    const p = drawPaths.get(c.id);
    return Array.isArray(p) && p.length >= 2;
  });

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const ca = list[i], cb = list[j];
      const pa = drawPaths.get(ca.id);
      const pb = drawPaths.get(cb.id);

      // The one with the later-sorted id arches over; the earlier one has a gap
      const [under, over, pathOver, pathUnder] = ca.id < cb.id
        ? [ca, cb, pb, pa]
        : [cb, ca, pa, pb];

      for (let si = 0; si < pathOver.length - 1; si++) {
        const a = pathOver[si], b = pathOver[si + 1];
        for (let sj = 0; sj < pathUnder.length - 1; sj++) {
          const c = pathUnder[sj], d = pathUnder[sj + 1];
          const hit = _segIntersectPoint(a, b, c, d);
          if (!hit) continue;

          // Arch on the over connection
          const dx   = b.x - a.x, dy = b.y - a.y;
          const len  = Math.hypot(dx, dy) || 1;
          const perpX = -dy / len;
          const perpY =  dx / len;
          overHops.get(over.id).push({ segIdx: si, t: hit.t, px: hit.x, py: hit.y, perpX, perpY });

          // Gap on the under connection — hit.s is already the parametric position
          // on segment c→d, so compute the crossing point directly (no second call).
          const gx = c.x + (d.x - c.x) * hit.s;
          const gy = c.y + (d.y - c.y) * hit.s;
          underGaps.get(under.id).push({ segIdx: sj, t: hit.s, px: gx, py: gy });
        }
      }
    }
  }

  // Sort by (segIdx, t) so drawStroke processes in path order
  for (const hops of overHops.values())  hops.sort((a, b)  => a.segIdx !== b.segIdx ? a.segIdx - b.segIdx : a.t - b.t);
  for (const gaps of underGaps.values()) gaps.sort((a, b)  => a.segIdx !== b.segIdx ? a.segIdx - b.segIdx : a.t - b.t);

  return { overHops, underGaps };
}

/**
 * Segment–segment intersection, returns {x, y, t, s} or null.
 * t is parametric on a→b, s is parametric on c→d.
 * Filters only genuine shared-endpoint touches (t or s exactly 0 or 1).
 */
function _segIntersectPoint(a, b, c, d) {
  const dx1 = b.x - a.x, dy1 = b.y - a.y;
  const dx2 = d.x - c.x, dy2 = d.y - c.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-8) return null; // parallel / collinear

  const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
  const s = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;

  // Must be within both segments (allow tiny float overshoot)
  if (t < -0.001 || t > 1.001 || s < -0.001 || s > 1.001) return null;

  // Reject only if BOTH sides are at an endpoint — that means the segments
  // share a junction point, not a crossing. A crossing near a corner is valid.
  const tEnd = (t < 0.01 || t > 0.99);
  const sEnd = (s < 0.01 || s > 0.99);
  if (tEnd && sEnd) return null;

  const tc = Math.max(0, Math.min(1, t));
  const sc = Math.max(0, Math.min(1, s));
  return { x: a.x + dx1 * tc, y: a.y + dy1 * tc, t: tc, s: sc };
}

// ── Stroke helpers ────────────────────────────────────────────────────────────

function drawStroke(gfx, path, color, width, style, hops = [], gaps = []) {
  gfx.lineStyle({ width, color, alpha: 1, cap: "round", join: "round" });

  if (style === "dashed" || style === "dotted") {
    drawDashedLine(gfx, path, width, style === "dotted");
    // Hops on dashed lines: draw arcs separately
    _drawHopArcs(gfx, hops, color, width);
    return;
  }

  // Build corner-radius elbow points first, then splice in hops
  const cornerR = Math.max(width * 1.2, 8);

  // Expand path into a list of drawing commands: {type, x, y} or arc params
  // We draw segment by segment, inserting hop arcs where needed.
  // hops are sorted by segIdx, t
  let hopIdx = 0;

  gfx.moveTo(path[0].x, path[0].y);

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];

    // Collect hops on this segment, sorted by t
    const segHops = [];
    while (hopIdx < hops.length && hops[hopIdx].segIdx === i) {
      segHops.push(hops[hopIdx++]);
    }

    // The segment is divided into sub-segments by the hop points.
    // For each sub-segment we draw a line, then at the hop draw an arc.
    let fromPt = a;

    for (const hop of segHops) {
      // Approach point: HOP_RADIUS before the crossing
      const dx   = b.x - a.x, dy = b.y - a.y;
      const segLen = Math.hypot(dx, dy) || 1;
      const ux   = dx / segLen, uy = dy / segLen;
      const pre  = { x: hop.px - ux * HOP_RADIUS, y: hop.py - uy * HOP_RADIUS };
      const post = { x: hop.px + ux * HOP_RADIUS, y: hop.py + uy * HOP_RADIUS };

      // Skip degenerate hops too close to segment endpoints
      if (Math.hypot(pre.x - fromPt.x, pre.y - fromPt.y) > 2) {
        gfx.lineTo(pre.x, pre.y);
      }

      // Bezier arc over the crossing (control point is perpendicular from midpoint)
      const cpx = hop.px + hop.perpX * HOP_RADIUS * 1.5;
      const cpy = hop.py + hop.perpY * HOP_RADIUS * 1.5;
      gfx.quadraticCurveTo(cpx, cpy, post.x, post.y);

      fromPt = post;
    }

    // Draw to the end of this segment, with corner rounding if there's a next segment
    if (i < path.length - 2) {
      const c      = path[i + 2];
      const before = offsetPt(b, fromPt.x === a.x && fromPt.y === a.y ? a : fromPt, cornerR);
      const after  = offsetPt(b, c, cornerR);
      // Only round if we haven't already passed the corner via a hop
      if (Math.hypot(fromPt.x - b.x, fromPt.y - b.y) > cornerR) {
        gfx.lineTo(before.x, before.y);
        gfx.quadraticCurveTo(b.x, b.y, after.x, after.y);
      } else {
        gfx.lineTo(after.x, after.y);
      }
    } else {
      gfx.lineTo(b.x, b.y);
    }
  }

  // Draw background-colored gaps over the crossing points so the arch above
  // is clearly visible (electrical diagram bridge look).
  if (gaps.length) _drawUnderGaps(gfx, path, gaps, width);
}

function _drawUnderGaps(gfx, path, gaps, width) {
  const GAP_R = HOP_RADIUS + width * 0.5; // slightly wider than the hop arc
  // Use the scene background colour so the gap blends with the canvas
  const bgHex  = canvas.scene?.background?.color ?? "#000000";
  const bgColor = PIXI.utils.string2hex(bgHex);
  gfx.lineStyle({ width: width + 2, color: bgColor, alpha: 1, cap: "butt", join: "round" });
  for (const gap of gaps) {
    const seg = path[gap.segIdx];
    const nxt = path[gap.segIdx + 1];
    if (!seg || !nxt) continue;
    const dx  = nxt.x - seg.x, dy = nxt.y - seg.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux  = dx / len, uy = dy / len;
    const pre  = { x: gap.px - ux * GAP_R, y: gap.py - uy * GAP_R };
    const post = { x: gap.px + ux * GAP_R, y: gap.py + uy * GAP_R };
    gfx.moveTo(pre.x, pre.y);
    gfx.lineTo(post.x, post.y);
  }
}

function _drawHopArcs(gfx, hops, color, width) {
  if (!hops.length) return;
  gfx.lineStyle({ width, color, alpha: 1, cap: "round", join: "round" });
  for (const hop of hops) {
    const pre  = { x: hop.px - (-hop.perpY) * HOP_RADIUS, y: hop.py - hop.perpX * HOP_RADIUS };
    const post = { x: hop.px + (-hop.perpY) * HOP_RADIUS, y: hop.py + hop.perpX * HOP_RADIUS };
    const cpx  = hop.px + hop.perpX * HOP_RADIUS * 1.5;
    const cpy  = hop.py + hop.perpY * HOP_RADIUS * 1.5;
    gfx.moveTo(pre.x, pre.y);
    gfx.quadraticCurveTo(cpx, cpy, post.x, post.y);
  }
}

function drawDashedLine(gfx, path, width, dotted) {
  const dash = dotted ? width * 0.5 : width * 3.5;
  const gap  = dotted ? width * 3.5 : width * 2.0;
  let draw   = true;
  let carry  = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const a      = path[i];
    const b      = path[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    let dist     = 0;

    while (dist < segLen) {
      const interval = (draw ? dash : gap) - carry;
      const travel   = Math.min(interval, segLen - dist);
      const t0       = dist / segLen;
      const t1       = (dist + travel) / segLen;
      if (draw) {
        gfx.moveTo(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0);
        gfx.lineTo(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1);
      }
      dist  += travel;
      carry += travel;
      if (carry >= (draw ? dash : gap)) { carry = 0; draw = !draw; }
    }
  }
}

function offsetPt(origin, toward, radius) {
  const dx   = origin.x - toward.x;
  const dy   = origin.y - toward.y;
  const dist = Math.hypot(dx, dy) || 1;
  const cut  = Math.min(radius, dist * 0.5);
  return { x: origin.x - (dx / dist) * cut, y: origin.y - (dy / dist) * cut };
}

// ── Connection waypoint handles (canvas.interface, GM only) ──────────────────

function drawConnectionHandles(container, conn) {
  const path = conn.path;
  if (!path || path.length < 2) return;

  const stops   = conn.stops ?? [];
  const lineHex = PIXI.utils.string2hex(conn.lineColor ?? "#00ffff");

  // ── Intermediate stop handles (skip first/last terminals) ─────────────────
  const midStops = stops.slice(1, -1);
  midStops.forEach((stop) => {
    const h = new PIXI.Graphics();
    h.lineStyle({ width: 2, color: lineHex, alpha: 0.9 });
    h.beginFill(stop.kind === "junction" ? 0x441144 : 0x002233, 0.95);
    h.drawCircle(0, 0, 9);
    h.endFill();
    if (stop.kind === "junction") {
      h.lineStyle({ width: 1.5, color: 0xff9ff3, alpha: 0.8 });
      h.drawCircle(0, 0, 13);
    }
    h.position.set(stop.x, stop.y);
    h.eventMode = "none";
    h.zIndex    = 210;
    container.addChild(h);
  });

  // ── Insert handles (+ dots at segment midpoints) ──────────────────────────
  const totalSegs = midStops.length + 1;
  for (let i = 0; i < totalSegs; i++) {
    const t   = (i + 0.5) / totalSegs;
    const pos = pointAlongPath(path, t);
    const dot = new PIXI.Graphics();
    dot.lineStyle({ width: 1.5, color: lineHex, alpha: 0.55 });
    dot.beginFill(0x001122, 0.75);
    dot.drawCircle(0, 0, 7);
    dot.endFill();
    dot.lineStyle({ width: 1.5, color: lineHex, alpha: 0.8 });
    dot.moveTo(-4, 0); dot.lineTo(4, 0);
    dot.moveTo(0, -4); dot.lineTo(0, 4);
    dot.position.set(pos.x, pos.y);
    dot.eventMode = "none";
    dot.zIndex    = 200;
    container.addChild(dot);
  }
}

// ── Polygon helper ────────────────────────────────────────────────────────────

function drawPolygon(gfx, pts) {
  if (!pts.length) return;
  gfx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);
  gfx.closePath();
}
