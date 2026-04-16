/**
 * connectionManager.js — GM tools for creating, updating and deleting
 * connections between nodes.
 *
 * Connection data structure:
 *   stops[]  — ordered array of { kind, nodeId?, x, y, locked?, encounter? }
 *     kind: "terminal" | "junction" | "path"
 *     junction stops pause travel and show the direction panel
 *     path stops are routing hints (invisible to players)
 *   path[]   — dense computed routing path (array of {x,y})
 */

import {
  MODULE_ID,
  DEFAULT_CONNECTION,
} from "./constants.js";
import { upsertConnection, deleteConnection, getConnection, listConnections, getNode, listNodes } from "./flags.js";
import { buildPath } from "./routing.js";
import { edgePoint } from "./geometry.js";
import { redrawMap, setWaypointCallbacks, setSecretToggleCallback } from "./renderer.js";
import { ConnectionConfigApp } from "./ui/connectionConfig.js";

// Register stop editing callbacks — avoids circular imports
setWaypointCallbacks(
  (connId, idx, pos)    => ConnectionManager.updateStop(connId, idx, pos),
  (connId, segIdx, pos) => ConnectionManager.insertStop(connId, segIdx, pos),
  (connId, idx)         => ConnectionManager.removeStop(connId, idx),
  (connId, idx)         => ConnectionManager.toggleStopKind(connId, idx),
);

// Toggle hidden state from the eye icon click
setSecretToggleCallback(connId => ConnectionManager.updateConnection(connId, { hidden: !getConnection(canvas?.scene, connId)?.hidden }));

// ── Last-used connection style (localStorage, per client) ────────────────────

const _CONN_STYLE_KEY    = `${MODULE_ID}.lastConnStyle`;
const _CONN_STYLE_FIELDS = ["type", "lineColor", "lineWidth", "lineStyle",
                            "accentColor", "travelable", "oneWay", "hidden"];

function _saveConnStyle(data) {
  const style = {};
  for (const f of _CONN_STYLE_FIELDS) {
    if (data[f] !== undefined) style[f] = data[f];
  }
  try { localStorage.setItem(_CONN_STYLE_KEY, JSON.stringify(style)); } catch {}
}

function _getConnStyle() {
  try {
    const raw = localStorage.getItem(_CONN_STYLE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ── Connect-mode state ────────────────────────────────────────────────────────
let connectMode    = false;
let firstEndpoint  = null;   // { type:"node", nodeId } | { type:"junction", connId, stopIdx, x, y }

// ── Public API ────────────────────────────────────────────────────────────────

export class ConnectionManager {

  static isConnectModeActive() { return connectMode; }

  static toggleConnectMode(on) {
    if (!game.user?.isGM) return;
    connectMode = typeof on === "boolean" ? on : !connectMode;
    if (!connectMode) firstEndpoint = null;
    else ui.notifications?.info("Connection tool: click a node or junction stop to start.");
  }

  // Called when connect mode is active and a node is clicked
  static handleNodeClick(nodeId) {
    if (!connectMode) return;
    if (!firstEndpoint) {
      firstEndpoint = { type: "node", nodeId };
      ui.notifications?.info("Node selected — now click the destination node or junction.");
      return;
    }
    if (firstEndpoint.type === "node" && firstEndpoint.nodeId === nodeId) {
      firstEndpoint = null;
      ui.notifications?.info("Cancelled.");
      return;
    }
    const from = firstEndpoint;
    firstEndpoint = null;
    ConnectionManager._openConfigForEndpoints(from, { type: "node", nodeId });
  }

  // Called when connect mode is active and a junction stop is clicked
  static handleJunctionClick(connId, stopIdx, x, y) {
    if (!connectMode) return;

    // Enforce max 2 connections per junction point (X junction = 4 directions)
    if (_junctionIsFull(x, y, connId)) {
      ui.notifications?.warn("This junction already has 2 connections (4 directions). Add another junction stop for a third connection.");
      return;
    }

    if (!firstEndpoint) {
      firstEndpoint = { type: "junction", connId, stopIdx, x, y };
      ui.notifications?.info("Junction selected — now click the destination node or junction.");
      return;
    }
    if (firstEndpoint.type === "junction" && firstEndpoint.connId === connId && firstEndpoint.stopIdx === stopIdx) {
      firstEndpoint = null;
      ui.notifications?.info("Cancelled.");
      return;
    }

    // Also check destination junction
    const to = { type: "junction", connId, stopIdx, x, y };
    if (to.type === "junction" && _junctionIsFull(to.x, to.y, to.connId)) {
      ui.notifications?.warn("Destination junction already has 2 connections (4 directions). Add another junction stop for a third connection.");
      firstEndpoint = null;
      return;
    }

    const from = firstEndpoint;
    firstEndpoint = null;
    ConnectionManager._openConfigForEndpoints(from, to);
  }

  // Build initial stops and open the config dialog
  static _openConfigForEndpoints(from, to) {
    const scene = canvas.scene;

    const stops = [];

    // From endpoint
    if (from.type === "node") {
      const node = getNode(scene, from.nodeId);
      stops.push({ kind: "terminal", nodeId: from.nodeId, x: node?.x ?? 0, y: node?.y ?? 0 });
    } else {
      // Junction — terminal without nodeId, positioned at the junction
      stops.push({ kind: "terminal", x: from.x, y: from.y });
      // Upgrade the clicked stop to junction kind so it's visible as a branch point
      const parentConn = getConnection(scene, from.connId);
      if (parentConn?.stops?.[from.stopIdx]?.kind === "path") {
        ConnectionManager.toggleStopKind(from.connId, from.stopIdx, "junction");
      }
    }

    // To endpoint
    if (to.type === "node") {
      const node = getNode(scene, to.nodeId);
      stops.push({ kind: "terminal", nodeId: to.nodeId, x: node?.x ?? 0, y: node?.y ?? 0 });
    } else {
      stops.push({ kind: "terminal", x: to.x, y: to.y });
      const parentConn = getConnection(scene, to.connId);
      if (parentConn?.stops?.[to.stopIdx]?.kind === "path") {
        ConnectionManager.toggleStopKind(to.connId, to.stopIdx, "junction");
      }
    }

    // Resolve display labels
    const fromNodeId = stops[0].nodeId;
    const toNodeId   = stops[stops.length - 1].nodeId;
    const fromNode   = fromNodeId ? getNode(scene, fromNodeId) : null;
    const toNode     = toNodeId   ? getNode(scene, toNodeId)   : null;

    const data = {
      ...DEFAULT_CONNECTION,
      ..._getConnStyle(),
      stops,
      fromLabel: fromNode?.label ?? "Junction",
      toLabel:   toNode?.label   ?? "Junction",
    };

    new ConnectionConfigApp(data, {
      onSubmit: d => ConnectionManager.createConnection(d),
      onDelete: null,
    }).render(true);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  static async createConnection(data) {
    const scene = canvas.scene;
    if (!scene) return null;

    const merged = foundry.utils.mergeObject({ ...DEFAULT_CONNECTION }, data ?? {}, { inplace: false });
    merged.id    = foundry.utils.randomID();

    if (!merged.stops || merged.stops.length < 2) {
      console.warn("[DNM] createConnection: stops missing or too short", merged);
      return null;
    }

    const gs            = canvas.grid?.size ?? 100;
    const allNodes      = listNodes(scene);
    const existingPaths = Object.values(listConnections(scene)).map(c => c.path).filter(Boolean);

    _assignSlotsForConn(scene, merged);
    merged.path = _buildPathFromStops(scene, merged.stops, allNodes, gs, existingPaths);
    _syncTerminalPositions(merged);
    _cacheStopDirections(merged);
    const conn = await upsertConnection(scene, merged);
    _saveConnStyle(merged);
    redrawMap();
    Hooks.callAll("dnmConnectionCreated", conn);
    return conn;
  }

  static async updateConnection(id, patch) {
    const scene = canvas.scene;
    if (!scene) return null;
    const current = getConnection(scene, id);
    if (!current) return null;

    const updated = foundry.utils.mergeObject({ ...current }, patch ?? {}, { inplace: false });

    // Ensure stops exist (migration safety net)
    if (!updated.stops?.length) {
      console.warn("[DNM] updateConnection: no stops on connection", id);
      return null;
    }

    const gs            = canvas.grid?.size ?? 100;
    const allNodes      = listNodes(scene);
    const existingPaths = Object.values(listConnections(scene))
      .filter(c => c.id !== id).map(c => c.path).filter(Boolean);

    _assignSlotsForConn(scene, updated);
    updated.path = _buildPathFromStops(scene, updated.stops, allNodes, gs, existingPaths);
    _syncTerminalPositions(updated);
    _cacheStopDirections(updated);

    // Purge any legacy walls from old versions that created blocking walls
    await _deleteConnWalls(scene, current);
    updated.wallIds = [];

    const conn = await upsertConnection(scene, updated);
    redrawMap();
    Hooks.callAll("dnmConnectionUpdated", conn);
    return conn;
  }

  static async deleteConnection(id) {
    const scene = canvas.scene;
    if (!scene) return;
    const conn = getConnection(scene, id);
    if (!conn) return;
    await _deleteConnWalls(scene, conn);
    await deleteConnection(scene, id);
    // Purge any child connections whose floating terminals are now unanchored
    await ConnectionManager.purgeOrphanConnections();
    redrawMap();
    Hooks.callAll("dnmConnectionDeleted", id);
  }

  /**
   * Delete any connection whose floating terminal stop (no nodeId) no longer
   * sits on a junction stop of another connection.  Runs on canvasReady and
   * after every deleteConnection so stale child connections are cleaned up
   * automatically when the user removes junction waypoints.
   */
  static async purgeOrphanConnections() {
    const scene = canvas.scene;
    if (!scene || !game.user?.isGM) return;
    const conns = Object.values(listConnections(scene));
    const MATCH = canvas.grid?.size ?? 100;

    const orphanIds = [];
    for (const conn of conns) {
      const stops = conn.stops ?? [];
      if (stops.length < 2) { orphanIds.push(conn.id); continue; }
      const first = stops[0];
      const last  = stops[stops.length - 1];

      const isOrphaned = (s) => {
        if (!s || s.nodeId) return false; // anchored to a room node — valid
        // Valid if any other connection has a junction stop nearby
        return !conns.some(c => {
          if (c.id === conn.id) return false;
          return (c.stops ?? []).some(os =>
            os.kind === "junction" &&
            Math.hypot(os.x - s.x, os.y - s.y) < MATCH
          );
        });
      };

      if (isOrphaned(first) || isOrphaned(last)) orphanIds.push(conn.id);
    }

    if (!orphanIds.length) return;
    console.log(`[DNM] Purging ${orphanIds.length} orphaned connection(s):`, orphanIds);
    for (const id of orphanIds) {
      const c = getConnection(scene, id);
      if (c) await _deleteConnWalls(scene, c);
      await deleteConnection(scene, id);
    }
    redrawMap();
  }

  // Rebuild connections where any terminal stop references this nodeId
  static async rebuildForNode(nodeId) {
    const scene = canvas.scene;
    if (!scene || !nodeId) return;
    const all = Object.values(listConnections(scene)).filter(c =>
      c.stops?.some(s => s.nodeId === nodeId) ||
      c.from === nodeId || c.to === nodeId   // legacy
    );
    for (const c of all) await this.updateConnection(c.id, {});
  }

  // Rebuild connections whose free-floating terminal is positioned near a stop on connId
  static async rebuildForStop(connId, stopIdx) {
    const scene = canvas.scene;
    if (!scene) return;
    const sourceConn = getConnection(scene, connId);
    const sourceStop = sourceConn?.stops?.[stopIdx];
    if (!sourceStop) return;

    const MATCH_DIST = 40;
    const all = Object.values(listConnections(scene)).filter(c => {
      if (c.id === connId) return false;
      return c.stops?.some(s =>
        s.kind === "terminal" && !s.nodeId &&
        Math.hypot(s.x - sourceStop.x, s.y - sourceStop.y) < MATCH_DIST
      );
    });
    for (const c of all) await this.updateConnection(c.id, {});
  }

  // ── Config dialog ────────────────────────────────────────────────────────────

  static openConfig(connectionId) {
    const scene    = canvas.scene;
    const existing = connectionId ? getConnection(scene, connectionId) : null;
    if (!existing) return;

    const stops      = existing.stops ?? [];
    const fromNodeId = stops[0]?.nodeId;
    const toNodeId   = stops[stops.length - 1]?.nodeId;
    const fromNode   = fromNodeId ? getNode(scene, fromNodeId) : null;
    const toNode     = toNodeId   ? getNode(scene, toNodeId)   : null;

    const data = {
      ...existing,
      fromLabel: fromNode?.label ?? "Junction",
      toLabel:   toNode?.label   ?? "Junction",
    };

    new ConnectionConfigApp(data, {
      onSubmit: d  => ConnectionManager.updateConnection(connectionId, d),
      onDelete: () => ConnectionManager.deleteConnection(connectionId),
    }).render(true);
  }

  // ── Stop editing ─────────────────────────────────────────────────────────────

  static async updateStop(connId, idx, pos) {
    const scene = canvas.scene;
    const conn  = getConnection(scene, connId);
    if (!conn) return;
    const stops = [...(conn.stops ?? [])];
    // Don't allow moving terminal stops (they're tied to node edge positions)
    if (!stops[idx] || stops[idx].kind === "terminal") return;

    // Snap to grid so stop position always matches the path vertex.
    const gs   = canvas.grid?.size ?? 100;
    const snap = v => Math.round(v / gs) * gs;
    const oldX = stops[idx].x, oldY = stops[idx].y;
    const newX = snap(pos.x),  newY = snap(pos.y);

    if (oldX === newX && oldY === newY) return; // no actual move

    stops[idx] = { ...stops[idx], x: newX, y: newY };

    // ── 1. Rebuild parent with waypoint at new position first ─────────────────
    // The parent path must have a vertex at (newX, newY) before child connections
    // run _assignSlotsForConn and scan the parent path to detect occupied arms.
    await ConnectionManager.updateConnection(connId, { stops });

    // ── 2. Move child terminals and rebuild them ───────────────────────────────
    // Children have terminal stops at the OLD position.  rebuildForStop() can't
    // find them because it searches near the new position.  Move them explicitly.
    if (stops[idx].kind === "junction") {
      const MATCH = gs;
      const all   = Object.values(listConnections(scene));
      for (const c of all) {
        if (c.id === connId) continue;
        const newStops = (c.stops ?? []).map(s => {
          if (s.kind === "terminal" && !s.nodeId &&
              Math.hypot(s.x - oldX, s.y - oldY) < MATCH) {
            // Relocate to new junction position; clear stale slot for fresh assignment
            const { cardinalSlot: _dropped, ...rest } = s;
            return { ...rest, x: newX, y: newY };
          }
          return s;
        });
        const changed = newStops.some((s, i) => s !== c.stops[i]);
        if (changed) await ConnectionManager.updateConnection(c.id, { stops: newStops });
      }
    }
  }

  static async insertStop(connId, insertBefore, pos) {
    const scene = canvas.scene;
    const conn  = getConnection(scene, connId);
    if (!conn) return;
    const stops = [...(conn.stops ?? [])];
    // Only insert between first and last (never before index 0 or after last)
    const idx = Math.max(1, Math.min(stops.length - 1, insertBefore));
    // Snap to grid so the stored stop position matches the path vertex exactly.
    const gs   = canvas.grid?.size ?? 100;
    const snap = v => Math.round(v / gs) * gs;
    stops.splice(idx, 0, { kind: "path", x: snap(pos.x), y: snap(pos.y) });
    return ConnectionManager.updateConnection(connId, { stops });
  }

  static async removeStop(connId, idx) {
    const scene = canvas.scene;
    const conn  = getConnection(scene, connId);
    if (!conn) return;
    const stops = [...(conn.stops ?? [])];
    if (stops[idx]?.kind === "terminal") return; // never delete terminals
    stops.splice(idx, 1);
    return ConnectionManager.updateConnection(connId, { stops });
  }

  static async toggleStopKind(connId, idx, force) {
    const scene = canvas.scene;
    const conn  = getConnection(scene, connId);
    if (!conn) return;
    const stops = [...(conn.stops ?? [])];
    if (!stops[idx] || stops[idx].kind === "terminal") return;
    const next = force !== undefined
      ? force
      : (stops[idx].kind === "junction" ? "path" : "junction");
    stops[idx] = { ...stops[idx], kind: next };
    return ConnectionManager.updateConnection(connId, { stops });
  }

  // ── Direction cache rebuild (called on canvasReady for legacy connections) ────

  /**
   * For every connection whose stops lack a pathIdx cache, rebuild it.
   * Lighter than a full updateConnection — no wall rebuild, no redraw.
   */
  static async rebuildMissingCaches() {
    const scene = canvas.scene;
    if (!scene || !game.user?.isGM) return;
    const conns = Object.values(
      foundry.utils.duplicate(scene.getFlag(MODULE_ID, "connections") ?? {})
    );
    const eligible = conns.filter(c => c.stops?.length && c.path?.length);
    if (!eligible.length) return;

    // Clear ALL junction-terminal slots first so every connection gets a fresh
    // best-slot assignment — stale/wrong slots from before routing fixes are purged.
    for (const conn of eligible) {
      for (const s of (conn.stops ?? [])) {
        if (s.kind === "terminal" && !s.nodeId) delete s.cardinalSlot;
      }
    }

    // All connections now need a slot rebuild.
    const needSlot = eligible.filter(c =>
      c.stops.some(s => s.kind === "terminal" && !s.nodeId)
    );
    if (needSlot.length) {
      console.log(`[DNM] Assigning cardinal slots on ${needSlot.length} connection(s)`);
      const gs       = canvas.grid?.size ?? 100;
      const allNodes = listNodes(scene);
      for (const conn of needSlot) {
        const otherPaths = eligible
          .filter(c => c.id !== conn.id).map(c => c.path).filter(Boolean);
        _assignSlotsForConn(scene, conn);
        conn.path = _buildPathFromStops(scene, conn.stops, allNodes, gs, otherPaths);
        _syncTerminalPositions(conn);
        _cacheStopDirections(conn);
      }
    }

    console.log(`[DNM] Rebuilding direction cache on ${eligible.length} connection(s)`);
    const updates = {};
    for (const conn of eligible) {
      if (!needSlot.includes(conn)) _cacheStopDirections(conn);
      updates[`flags.${MODULE_ID}.connections.${conn.id}`] = conn;
    }
    await scene.update(updates);
    console.log("[DNM] Direction cache rebuild complete");
  }

  /** Force-rebuild every connection's path from scratch (e.g. after routing changes). */
  static async rebuildAllPaths() {
    const scene = canvas.scene;
    if (!scene || !game.user?.isGM) return;
    const conns = Object.values(
      foundry.utils.duplicate(scene.getFlag(MODULE_ID, "connections") ?? {})
    );
    const eligible = conns.filter(c => c.stops?.length >= 2);
    if (!eligible.length) { console.log("[DNM] No connections to rebuild."); return; }

    ui.notifications?.info(`[DNM] Rebuilding ${eligible.length} connection paths…`);
    console.log(`[DNM] rebuildAllPaths: rebuilding ${eligible.length} connection(s)`);

    const gs       = canvas.grid?.size ?? 100;
    const allNodes = listNodes(scene);
    const updates  = {};

    for (const conn of eligible) {
      const otherPaths = eligible
        .filter(c => c.id !== conn.id).map(c => c.path).filter(Boolean);
      _assignSlotsForConn(scene, conn);
      conn.path = _buildPathFromStops(scene, conn.stops, allNodes, gs, otherPaths);
      _syncTerminalPositions(conn);
      _cacheStopDirections(conn);
      updates[`flags.${MODULE_ID}.connections.${conn.id}`] = conn;
    }

    await scene.update(updates);
    ui.notifications?.info(`[DNM] Rebuilt ${eligible.length} connection paths.`);
    console.log("[DNM] rebuildAllPaths complete");
  }

  /**
   * Shift every node, connection, wall, and light by (dx, dy).
   * Call with no args to auto-centre on the scene, or pass explicit offsets.
   * All relative spacing and connections are preserved exactly.
   * The last used offset is stored so undoTranslate() can reverse it.
   */
  static async translateMap(dx, dy) {
    const scene = canvas.scene;
    if (!scene || !game.user?.isGM) return;

    const nodes = foundry.utils.duplicate(scene.getFlag(MODULE_ID, "nodes") ?? {});
    const conns = foundry.utils.duplicate(scene.getFlag(MODULE_ID, "connections") ?? {});

    if (dx === undefined || dy === undefined) {
      // Auto-centre: find bounding box of all nodes and centre on scene
      const nodeArr = Object.values(nodes);
      if (!nodeArr.length) { ui.notifications?.warn("[DNM] No nodes found."); return; }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodeArr) {
        const hw = (n.width  ?? 200) / 2;
        const hh = (n.height ?? 200) / 2;
        minX = Math.min(minX, n.x - hw);
        minY = Math.min(minY, n.y - hh);
        maxX = Math.max(maxX, n.x + hw);
        maxY = Math.max(maxY, n.y + hh);
      }
      const mapCx  = (minX + maxX) / 2;
      const mapCy  = (minY + maxY) / 2;
      const sceneCx = (canvas.dimensions?.sceneX ?? 0) + (canvas.dimensions?.sceneWidth  ?? 4000) / 2;
      const sceneCy = (canvas.dimensions?.sceneY ?? 0) + (canvas.dimensions?.sceneHeight ?? 4000) / 2;
      dx = sceneCx - mapCx;
      dy = sceneCy - mapCy;
    }

    console.log(`[DNM] translateMap dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
    ui.notifications?.info(`[DNM] Shifting map by (${Math.round(dx)}, ${Math.round(dy)})…`);

    // ── DNM node flags ──────────────────────────────────────────────────────────
    const flagUpdates = {};
    for (const [id, n] of Object.entries(nodes)) {
      n.x += dx;
      n.y += dy;
      flagUpdates[`flags.${MODULE_ID}.nodes.${id}`] = n;
    }
    for (const [id, conn] of Object.entries(conns)) {
      if (conn.path)  conn.path  = conn.path.map(p  => ({ ...p,  x: p.x  + dx, y: p.y  + dy }));
      if (conn.stops) conn.stops = conn.stops.map(s => ({ ...s,  x: s.x  + dx, y: s.y  + dy }));
      flagUpdates[`flags.${MODULE_ID}.connections.${id}`] = conn;
    }
    await scene.update(flagUpdates);

    // ── Foundry walls owned by DNM nodes ───────────────────────────────────────
    const wallIds = new Set(Object.values(nodes).flatMap(n => n.wallIds ?? []));
    if (wallIds.size) {
      const wallUpdates = scene.walls
        .filter(w => wallIds.has(w.id))
        .map(w => ({
          _id: w.id,
          c: [w.c[0] + dx, w.c[1] + dy, w.c[2] + dx, w.c[3] + dy],
        }));
      if (wallUpdates.length) await scene.updateEmbeddedDocuments("Wall", wallUpdates);
    }

    // ── Ambient lights owned by DNM nodes ──────────────────────────────────────
    const lightIds = new Set(Object.values(nodes).map(n => n.lightId).filter(Boolean));
    if (lightIds.size) {
      const lightUpdates = scene.lights
        .filter(l => lightIds.has(l.id))
        .map(l => ({ _id: l.id, x: l.x + dx, y: l.y + dy }));
      if (lightUpdates.length) await scene.updateEmbeddedDocuments("AmbientLight", lightUpdates);
    }

    // Store last offset for undo
    ConnectionManager._lastTranslate = { dx, dy };

    ui.notifications?.info("[DNM] Map shift complete.");
    console.log("[DNM] translateMap complete");
  }

  /** Reverse the last translateMap call. */
  static async undoTranslate() {
    const last = ConnectionManager._lastTranslate;
    if (!last) { ui.notifications?.warn("[DNM] Nothing to undo."); return; }
    const { dx, dy } = last;
    ConnectionManager._lastTranslate = null;
    await ConnectionManager.translateMap(-dx, -dy);
    // Clear the new last (the undo itself) so it can't be double-undone
    ConnectionManager._lastTranslate = null;
  }

  /**
   * Lock a single stop on a connection without rebuilding path or walls.
   * Used by lock-on-traverse doors — geometry is unchanged, only the locked flag changes.
   * GM-only: players trigger this via socket broadcast.
   */
  static async lockConnectionStop(connectionId, stopIdx) {
    const scene = canvas.scene;
    if (!scene) return;
    const conns = foundry.utils.duplicate(scene.getFlag(MODULE_ID, "connections") ?? {});
    const conn  = conns[connectionId];
    if (!conn?.stops?.[stopIdx]) return;
    if (conn.stops[stopIdx].locked) return; // already locked — no write needed
    conn.stops[stopIdx].locked = true;
    await scene.setFlag(MODULE_ID, "connections", conns);
  }

}

// ── Direction cache ───────────────────────────────────────────────────────────

/**
 * Walk the stored path once and write onto each non-"path" stop:
 *   stop.pathIdx    — index into conn.path (terminals always 0 / last)
 *   stop.navForward — cardinal direction toward the next pause stop (or null)
 *   stop.navBack    — cardinal direction toward the prev pause stop (or null)
 *
 * Called after every _syncTerminalPositions so the cache is always current.
 * Travel reads these values instead of computing directions at runtime.
 */
function _cacheStopDirections(conn) {
  const path  = conn.path;
  const stops = conn.stops;
  if (!path?.length || !stops?.length) return;

  const n = stops.length;

  // ── Assign pathIdx — search sequentially so two close stops never share one ─
  let searchFrom = 1;
  for (let i = 0; i < n; i++) {
    const s = stops[i];
    if (i === 0)     { s.pathIdx = 0;               searchFrom = 1;                continue; }
    if (i === n - 1) { s.pathIdx = path.length - 1;                                continue; }
    s.pathIdx  = _pathNearestIdx(path, s.x, s.y, searchFrom);
    searchFrom = s.pathIdx + 1;  // next stop must be strictly forward
  }

  // ── Compute navForward / navBack for every non-path stop ───────────────────
  for (let i = 0; i < n; i++) {
    const s = stops[i];
    if (s.kind === "path") continue;

    const pi = s.pathIdx;

    // Forward: direction toward the next non-path stop's pathIdx
    let fwdPi = -1;
    for (let j = i + 1; j < n; j++) {
      if (stops[j].kind !== "path") { fwdPi = stops[j].pathIdx; break; }
    }
    s.navForward = fwdPi >= 0 ? _cardinalAlongPath(path, pi, fwdPi) : null;

    // Back: direction toward the prev non-path stop's pathIdx
    let backPi = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (stops[j].kind !== "path") { backPi = stops[j].pathIdx; break; }
    }
    s.navBack = backPi >= 0 ? _cardinalAlongPath(path, pi, backPi) : null;
  }
}

/** Find the index of the path point closest to (x, y), searching from fromIdx. */
function _pathNearestIdx(path, x, y, fromIdx = 0) {
  let best = Math.max(0, fromIdx), bestDist = Infinity;
  for (let i = Math.max(0, fromIdx); i < path.length; i++) {
    const d = Math.hypot(path[i].x - x, path[i].y - y);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * Return the cardinal direction you face when standing at path[fromPi]
 * and looking toward path[toPi].  Reads up to 3 steps along the path for
 * a stable reading (avoids noise at near-identical points).
 */
function _cardinalAlongPath(path, fromPi, toPi) {
  if (fromPi === toPi) return null;
  const step   = fromPi < toPi ? 1 : -1;
  const scanTo = Math.max(0, Math.min(path.length - 1,
    fromPi + step * Math.min(3, Math.abs(toPi - fromPi))));
  const dx = path[scanTo].x - path[fromPi].x;
  const dy = path[scanTo].y - path[fromPi].y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  return Math.abs(dx) >= Math.abs(dy)
    ? (dx > 0 ? "east" : "west")
    : (dy > 0 ? "south" : "north");
}

// ── Cardinal slot assignment for junction terminals ───────────────────────────

/** Unit vectors for each cardinal slot. */
const _SLOT_DIRS = {
  north: { x:  0, y: -1 },
  south: { x:  0, y:  1 },
  east:  { x:  1, y:  0 },
  west:  { x: -1, y:  0 },
};

/**
 * Returns the set of cardinal slot names already claimed at junction (jx, jy)
 * by connections other than excludeConnId.
 *
 * Two sources of occupancy:
 *  1. Terminal stops with a cardinalSlot (child connections branching here).
 *  2. Connections whose stored PATH passes through the junction position —
 *     the parent line uses two of the four cardinal directions (in + out).
 *     Detected from path geometry directly, bypassing stop.kind / pathIdx.
 */
function _occupiedSlots(scene, jx, jy, excludeConnId) {
  const MATCH = canvas.grid?.size ?? 100;
  const occupied = new Set();
  for (const conn of Object.values(listConnections(scene))) {
    if (conn.id === excludeConnId) continue;
    const path  = conn.path ?? [];
    const stops = conn.stops ?? [];

    // ── Child branch terminals with an assigned slot ──────────────────────────
    for (const s of stops) {
      if (s.kind === "terminal" && !s.nodeId && s.cardinalSlot &&
          Math.hypot(s.x - jx, s.y - jy) < MATCH) {
        occupied.add(s.cardinalSlot);
      }
    }

    // ── Parent connections passing through the junction ────────────────────────
    // Find the interior path point (index 1..n-2) closest to the junction.
    // If it's within MATCH px the connection travels through here — read both arms.
    if (path.length >= 3) {
      let bestPi = -1, bestDist = MATCH;
      for (let pi = 1; pi < path.length - 1; pi++) {
        const d = Math.hypot(path[pi].x - jx, path[pi].y - jy);
        if (d < bestDist) { bestDist = d; bestPi = pi; }
      }
      if (bestPi >= 0) {
        const fwd = _junctionArmDir(path, bestPi, true);
        const bak = _junctionArmDir(path, bestPi, false);
        if (fwd) occupied.add(fwd);
        if (bak) occupied.add(bak);
      }
    }
  }
  return occupied;
}

/**
 * Read the cardinal direction of a single path step from path[pi].
 * forward=true → toward pi+1, forward=false → toward pi-1.
 */
function _junctionArmDir(path, pi, forward) {
  const ni = forward ? pi + 1 : pi - 1;
  if (ni < 0 || ni >= path.length) return null;
  const dx = path[ni].x - path[pi].x;
  const dy = path[ni].y - path[pi].y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "east" : "west") : (dy > 0 ? "south" : "north");
}

/**
 * Pick the best available cardinal slot at junction (jx, jy) for a path
 * heading toward (otherX, otherY).  Ranks all four directions by dot-product
 * alignment with the toward-other-end vector and returns the first free one.
 */
function _bestSlot(occupied, jx, jy, otherX, otherY) {
  const dx  = otherX - jx;
  const dy  = otherY - jy;
  const len = Math.hypot(dx, dy) || 1;
  const ux  = dx / len, uy = dy / len;
  const ranked = Object.entries(_SLOT_DIRS)
    .map(([name, v]) => ({ name, dot: v.x * ux + v.y * uy }))
    .sort((a, b) => b.dot - a.dot);
  for (const { name } of ranked) {
    if (!occupied.has(name)) return name;
  }
  return null; // all 4 slots occupied
}

/**
 * Assign a cardinalSlot to each junction terminal stop (kind=terminal, no nodeId)
 * on conn.  Reads occupied slots from other connections at the same position.
 * Preserves an existing assignment if the slot is still available.
 * Modifies conn.stops in place.
 */
function _assignSlotsForConn(scene, conn) {
  const stops = conn.stops;
  if (!stops || stops.length < 2) return;
  const first = stops[0];
  const last  = stops[stops.length - 1];

  // Always recompute — never preserve a stale slot.  The best available slot
  // is determined fresh each time so corrections propagate on every rebuild.
  if (first.kind === "terminal" && !first.nodeId) {
    const occupied = _occupiedSlots(scene, first.x, first.y, conn.id);
    first.cardinalSlot = _bestSlot(occupied, first.x, first.y, last.x, last.y) ?? null;
  }

  if (last.kind === "terminal" && !last.nodeId) {
    const occupied = _occupiedSlots(scene, last.x, last.y, conn.id);
    last.cardinalSlot = _bestSlot(occupied, last.x, last.y, first.x, first.y) ?? null;
  }
}

// ── Path building from stops ──────────────────────────────────────────────────

function _buildPathFromStops(scene, stops, allNodes, gs, existingPaths) {
  if (!stops || stops.length < 2) return [];
  const first = stops[0];
  const last  = stops[stops.length - 1];

  const fromNode = first.nodeId ? getNode(scene, first.nodeId) : null;
  const toNode   = last.nodeId  ? getNode(scene, last.nodeId)  : null;
  const fromPos  = !fromNode ? { x: first.x, y: first.y } : null;
  const toPos    = !toNode   ? { x: last.x,  y: last.y  } : null;

  // Pass stored cardinal slots for junction terminals — router uses them to lock arm direction.
  const fromSlot = (fromPos && !first.nodeId) ? (first.cardinalSlot ?? null) : null;
  const toSlot   = (toPos   && !last.nodeId)  ? (last.cardinalSlot  ?? null) : null;

  // Intermediate stops become waypoints for routing
  const waypoints = stops.slice(1, -1).map(s => ({
    x: s.x,
    y: s.y,
    isJunction: s.kind === "junction",
  }));

  return buildPath(fromNode, toNode, waypoints, allNodes, gs, fromPos, toPos, existingPaths, fromSlot, toSlot);
}

/**
 * After path is built, write the computed edge positions back into the terminal stops.
 * This keeps stop.x/y accurate for travel, direction panel placement, etc.
 */
function _syncTerminalPositions(conn) {
  const path  = conn.path;
  const stops = conn.stops;
  if (!path || path.length < 2 || !stops || stops.length < 2) return;
  const scene = canvas?.scene;

  // For node terminals: store the true wall edge (edgePoint), NOT the travel
  // stop position (which is offset outward by WALL_STOP_OFFSET in routing.js).
  // Non-node terminals (junction floaters) use path[0]/path[last] as before.
  const first = stops[0];
  const last  = stops[stops.length - 1];

  if (first.nodeId && scene) {
    const node = getNode(scene, first.nodeId);
    if (node) {
      // Direction from node center toward next path point
      const toward = path[1] ?? path[path.length - 1];
      const ep = edgePoint(node, toward);
      first.x = ep.x;
      first.y = ep.y;
    } else {
      first.x = path[0].x;
      first.y = path[0].y;
    }
  } else {
    first.x = path[0].x;
    first.y = path[0].y;
  }

  if (last.nodeId && scene) {
    const node = getNode(scene, last.nodeId);
    if (node) {
      // Direction from node center toward second-to-last path point
      const toward = path[path.length - 2] ?? path[0];
      const ep = edgePoint(node, toward);
      last.x = ep.x;
      last.y = ep.y;
    } else {
      last.x = path[path.length - 1].x;
      last.y = path[path.length - 1].y;
    }
  } else {
    last.x = path[path.length - 1].x;
    last.y = path[path.length - 1].y;
  }
}

/**
 * Returns true if all 4 cardinal slots at the junction point (x, y) are
 * occupied (excluding the connection that owns it, `ownConnId`).
 * Also counts any connections at this position that predate slot assignment.
 */
function _junctionIsFull(x, y, ownConnId) {
  const scene = canvas.scene;
  if (!scene) return false;
  const MATCH = canvas.grid?.size ?? 100;
  // Count claimed slots (connections with cardinalSlot set)
  const occupied = _occupiedSlots(scene, x, y, ownConnId);
  if (occupied.size >= 4) return true;
  // Count legacy terminals without a slot yet (conservative)
  let unslotted = 0;
  for (const conn of Object.values(listConnections(scene))) {
    if (conn.id === ownConnId) continue;
    const has = (conn.stops ?? []).some(
      s => s.kind === "terminal" && !s.nodeId && !s.cardinalSlot &&
           Math.hypot(s.x - x, s.y - y) < MATCH
    );
    if (has) unslotted++;
  }
  return (occupied.size + unslotted) >= 4;
}

async function _deleteConnWalls(scene, conn) {
  const ids = [
    ...(conn.wallIds ?? []),
    ...(conn.wallId ? [conn.wallId] : []),
  ].filter(id => scene.walls.has(id));
  if (ids.length) await scene.deleteEmbeddedDocuments("Wall", ids, { strict: false });
}
