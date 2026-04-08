/**
 * nodeManager.js — GM tools for creating, updating and deleting nodes.
 *
 * Nodes are stored in scene flags (via flags.js).
 * Each node also owns a set of Foundry Wall documents that form a room box
 * for Fog of War.  Wall IDs are stored on the node so they can be cleaned up.
 *
 * GM interaction:
 *   - Activate the Node tool (toolbar button)
 *   - Drag on the canvas → preview rectangle → release → NodeConfigApp opens
 *   - Fill in label, shape, colours → confirm → node + walls created
 *   - Right-click an existing node icon → NodeConfigApp opens for editing
 */

import { MODULE_ID, MIN_NODE_SIZE, DEFAULT_NODE, FLAG_NODE_ID, TOOL_CREATE_NODE, DOOR_ICON_RADIUS } from "./constants.js";
import { upsertNode, deleteNode, getNode, connectionsForNode, listNodes, listConnections } from "./flags.js";
import { nodeBounds, edgePoint, pointAlongPath } from "./geometry.js";
import { redrawMap, setNodeDragCallback } from "./renderer.js";
import { NodeConfigApp } from "./ui/nodeConfig.js";
import { ConnectionManager } from "./connectionManager.js";
import { TravelManager } from "./travel.js";

// Register node interaction callbacks — avoids circular imports
setNodeDragCallback(
  (nodeId, nx, ny) => NodeManager.updateNode(nodeId, { x: nx, y: ny }),
  (nodeId)         => NodeManager.openConfig(nodeId),
  (nodeId)         => ConnectionManager.handleNodeClick(nodeId),
  ()               => ConnectionManager.isConnectModeActive()
);

// ── Last-used node style (localStorage, per client) ──────────────────────────

const _STYLE_KEY    = `${MODULE_ID}.lastNodeStyle`;
const _STYLE_FIELDS = ["shape", "fillColor", "borderColor", "borderWidth",
                       "labelColor", "labelSize", "fontFamily", "createWalls"];

function _saveNodeStyle(data) {
  const style = {};
  for (const f of _STYLE_FIELDS) {
    if (data[f] !== undefined) style[f] = data[f];
  }
  try { localStorage.setItem(_STYLE_KEY, JSON.stringify(style)); } catch {}
}

function _getNodeStyle() {
  try {
    const raw = localStorage.getItem(_STYLE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ── Overlay state ─────────────────────────────────────────────────────────────
let createMode          = false;
let externalOverlay     = false;

// ── Native DOM listener for travel / eye-toggle ───────────────────────────────
// The PIXI overlay (static, full-canvas) blocks ALL pointer events even when our
// handler returns without stopPropagation.  For travel and eye-toggle we instead
// attach a capture-phase native listener that fires before PIXI and only
// consumes the event when we actually handle it.
let _nativeTravelHandler = null;
let overlay             = null;
let overlayGfx          = null;
let dragPointerId       = null;
let dragStart           = null;
// Node drag state
let isNodeDrag          = false;
let nodeDragging        = null;
let dragOffsetX         = 0;
let dragOffsetY         = 0;
// Waypoint drag state
let isWaypointDrag      = false;
let waypointConnId      = null;
let waypointIdx         = -1;

// ── Public API ────────────────────────────────────────────────────────────────

export class NodeManager {

  static isCreateModeActive() { return createMode; }

  static toggleCreateMode(on) {
    if (!game.user?.isGM) return;
    createMode = typeof on === "boolean" ? on : !createMode;
    if (game.settings.get(MODULE_ID, "debug")) {
      console.log(`[DNM] toggleCreateMode → ${createMode}`);
    }
    if (createMode) _activateOverlay("create");
    else            _deactivateOverlay();
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  static async createNode(data) {
    const scene = canvas.scene;
    if (!scene) return null;

    const merged = foundry.utils.mergeObject({ ...DEFAULT_NODE }, data ?? {}, { inplace: false });
    merged.id    = foundry.utils.randomID();

    // Snap position to grid
    const gs = canvas.grid?.size ?? 100;
    merged.x  = Math.round((merged.x ?? canvas.dimensions.sceneWidth  / 2) / gs) * gs;
    merged.y  = Math.round((merged.y ?? canvas.dimensions.sceneHeight / 2) / gs) * gs;
    merged.width  = Math.max(MIN_NODE_SIZE, Math.round(merged.width  / gs) * gs);
    merged.height = Math.max(MIN_NODE_SIZE, Math.round(merged.height / gs) * gs);

    // Create bounding walls for FoW
    if (merged.createWalls) {
      merged.wallIds = await _createWallBox(scene, merged);
    }

    // Create ambient light filling the node interior
    merged.lightId = await _createNodeLight(scene, merged);

    const node = await upsertNode(scene, merged);
    _saveNodeStyle(merged);
    redrawMap();
    Hooks.callAll("dnmNodeCreated", node);
    return node;
  }

  static async updateNode(id, patch) {
    const scene = canvas.scene;
    if (!scene) return null;
    const current = getNode(scene, id);
    if (!current) return null;

    const updated = foundry.utils.mergeObject({ ...current }, patch ?? {}, { inplace: false });

    // Rebuild walls if geometry changed
    if (updated.createWalls) {
      if (current.wallIds?.length) await _deleteWalls(scene, current.wallIds);
      updated.wallIds = await _createWallBox(scene, updated);
    } else if (current.wallIds?.length) {
      await _deleteWalls(scene, current.wallIds);
      updated.wallIds = [];
    }

    // Rebuild ambient light
    if (current.lightId) await _deleteLight(scene, current.lightId);
    updated.lightId = await _createNodeLight(scene, updated);

    const node = await upsertNode(scene, updated);

    // Rebuild any attached connections since edge points changed
    await ConnectionManager.rebuildForNode(id);

    redrawMap();
    Hooks.callAll("dnmNodeUpdated", node);
    return node;
  }

  static async deleteNode(id) {
    const scene = canvas.scene;
    if (!scene) return;
    const node = getNode(scene, id);
    if (!node) return;

    // Delete attached connections first
    const conns = connectionsForNode(scene, id);
    for (const c of conns) await ConnectionManager.deleteConnection(c.id);

    // Delete FoW walls and ambient light
    if (node.wallIds?.length) await _deleteWalls(scene, node.wallIds);
    if (node.lightId) await _deleteLight(scene, node.lightId);

    await deleteNode(scene, id);
    redrawMap();
    Hooks.callAll("dnmNodeDeleted", id);
  }

  // ── Resync walls & lights to current node positions ─────────────────────────

  static async resyncWallsAndLights() {
    const scene = canvas.scene;
    if (!scene || !game.user?.isGM) return;
    const nodes = Object.values(listNodes(scene));
    if (!nodes.length) { ui.notifications?.warn("[DNM] No nodes found."); return; }

    ui.notifications?.info(`[DNM] Resyncing walls & lights for ${nodes.length} nodes…`);
    const flagUpdates = {};

    for (const node of nodes) {
      // Delete old walls
      if (node.wallIds?.length) await _deleteWalls(scene, node.wallIds);
      // Delete old light
      if (node.lightId) await _deleteLight(scene, node.lightId);

      // Recreate at current node position
      const newWallIds = node.createWalls ? await _createWallBox(scene, node) : [];
      const newLightId = await _createNodeLight(scene, node);

      flagUpdates[`flags.${MODULE_ID}.nodes.${node.id}`] = {
        ...node,
        wallIds: newWallIds,
        lightId: newLightId,
      };
    }

    await scene.update(flagUpdates);
    ui.notifications?.info("[DNM] Walls & lights resynced.");
    console.log("[DNM] resyncWallsAndLights complete");
  }

  // ── Config dialog ────────────────────────────────────────────────────────────

  static openConfig(nodeId, defaults = {}) {
    const scene   = canvas.scene;
    const existing = nodeId ? getNode(scene, nodeId) : null;
    const data     = existing ? { ...existing } : { ...DEFAULT_NODE, ..._getNodeStyle(), ...defaults };

    new NodeConfigApp(data, {
      onSubmit: d  => nodeId ? NodeManager.updateNode(nodeId, d) : NodeManager.createNode(d),
      onDelete: () => nodeId ? NodeManager.deleteNode(nodeId)    : null,
    }).render(true);
  }
}

// ── External overlay control (used by connect tool in main.js) ───────────────

export function activateConnectOverlay() {
  externalOverlay = true;
  _activateOverlay("connect");
}

export function deactivateConnectOverlay() {
  externalOverlay = false;
  if (!createMode) _deactivateOverlay();
}

/** Called on canvasReady — attach native listener for travel & eye-toggle. */
export function activateTravelOverlay() {
  _attachNativeTravelListener();
}

/** Called on canvasTearDown — remove native listener and hide overlay. */
export function resetTravelOverlay() {
  _detachNativeTravelListener();
  _deactivateOverlay();
}

// ── Native DOM travel / eye-toggle listener ───────────────────────────────────

function _attachNativeTravelListener() {
  if (_nativeTravelHandler) return;
  const el = canvas.app?.view ?? canvas.app?.canvas;
  if (!el) return;
  _nativeTravelHandler = _onNativePointerDown;
  // Capture phase: fires before PIXI and Foundry; we only stopPropagation on hits
  el.addEventListener("pointerdown", _nativeTravelHandler, { capture: true });
}

function _detachNativeTravelListener() {
  const el = canvas.app?.view ?? canvas.app?.canvas;
  if (el && _nativeTravelHandler) {
    el.removeEventListener("pointerdown", _nativeTravelHandler, { capture: true });
  }
  _nativeTravelHandler = null;
}

function _nativeToWorld(event) {
  const el = canvas.app?.canvas ?? canvas.app?.view;
  if (!el || !canvas.stage?.worldTransform) return null;
  const rect = el.getBoundingClientRect();
  const t    = canvas.stage.worldTransform;
  // In Foundry v13 + PIXI v8 the worldTransform operates in CSS-pixel space
  // (Foundry scales the renderer internally for devicePixelRatio).
  const x = (event.clientX - rect.left - t.tx) / t.a;
  const y = (event.clientY - rect.top  - t.ty) / t.d;
  if (game.settings.get(MODULE_ID, "debug")) {
    console.log(`[DNM] transform a=${t.a.toFixed(3)} tx=${t.tx.toFixed(1)} ty=${t.ty.toFixed(1)} | rect=(${rect.left.toFixed(0)},${rect.top.toFixed(0)}) ${rect.width.toFixed(0)}x${rect.height.toFixed(0)} | el=${el.width}x${el.height} | client=(${event.clientX},${event.clientY}) → world=(${x.toFixed(1)},${y.toFixed(1)})`);
  }
  return { x, y };
}

function _onNativePointerDown(event) {
  if (event.button !== 0) return; // only left-click

  const pos = _nativeToWorld(event);
  if (!pos) return;

  const dbg = game.settings.get(MODULE_ID, "debug");

  // ── GM: eye icon toggles hidden state (works on any layer/tool) ──────────
  if (game.user?.isGM) {
    const hitEye = _findSecretEyeAtPoint(pos.x, pos.y);
    if (hitEye) {
      event.stopPropagation();
      event.preventDefault();
      ConnectionManager.updateConnection(hitEye.id, { hidden: !hitEye.hidden });
      return;
    }
    // GMs: let all other clicks fall through to Foundry/PIXI normally
    return;
  }

  // ── Player travel: token layer only ───────────────────────────────────────
  if (dbg) console.log(`[DNM] player click | world=(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) | token layer active=${canvas.tokens?.active}`);

  if (!canvas.tokens?.active) return;

  const hitConn = _findConnectionIconAtPoint(pos.x, pos.y, dbg);
  if (dbg) console.log(`[DNM] icon hit=`, hitConn ? `conn ${hitConn.id} (${hitConn.type})` : "none");
  if (!hitConn) return;

  event.stopPropagation();
  event.preventDefault();
  const controlled = canvas.tokens?.controlled ?? [];
  if (dbg) console.log(`[DNM] controlled tokens=`, controlled.map(t => t.name));
  if (!controlled.length) {
    ui.notifications?.warn("Select a token first.");
    return;
  }
  const stops        = hitConn.stops ?? [];
  const lastStop     = stops[stops.length - 1];
  const nodeId       = _tokenNodeId(controlled[0]);
  const startStopIdx = (nodeId && lastStop?.nodeId === nodeId) ? stops.length - 1 : 0;
  if (dbg) console.log(`[DNM] startTravel | conn=${hitConn.id} stopIdx=${startStopIdx} tokenNodeId=${nodeId}`);
  TravelManager.startTravel(controlled[0], hitConn.id, startStopIdx);
}

// ── Drag-to-place overlay ─────────────────────────────────────────────────────

function _worldPos(event) {
  // canvas.interface is a world-space container — local coords = world coords.
  const iface = canvas?.interface;
  if (!iface) return null;
  return event.getLocalPosition?.(iface) ?? event.data?.getLocalPosition?.(iface) ?? null;
}

function _findNodeAtPoint(wx, wy) {
  const scene = canvas?.scene;
  if (!scene) return null;
  const nodes = Object.values(listNodes(scene));
  // Inset by DOOR_ICON_RADIUS so clicks on the node perimeter (where door icons
  // live) are NOT treated as node clicks — the icon check runs first anyway
  const inset = DOOR_ICON_RADIUS + 4;
  for (const node of nodes) {
    const hw = (node.width  ?? 200) / 2 - inset;
    const hh = (node.height ?? 200) / 2 - inset;
    if (wx >= node.x - hw && wx <= node.x + hw &&
        wy >= node.y - hh && wy <= node.y + hh) return node;
  }
  return null;
}

// Mirror of renderer._insetPoint — must stay in sync with DOOR_ICON_INSET in renderer.js
const DOOR_ICON_INSET = 30;
function _iconPoint(stop, node) {
  if (!stop || !node) return { x: stop?.x ?? 0, y: stop?.y ?? 0 };
  const dx  = node.x - stop.x;
  const dy  = node.y - stop.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: stop.x + (dx / len) * DOOR_ICON_INSET, y: stop.y + (dy / len) * DOOR_ICON_INSET };
}

function _findConnectionIconAtPoint(wx, wy, dbg = false) {
  const scene = canvas?.scene;
  if (!scene) return null;
  const conns    = Object.values(listConnections(scene));
  const allNodes = Object.fromEntries(
    Object.values(listNodes(scene)).map(n => [n.id, n])
  );
  const hitR  = DOOR_ICON_RADIUS + 10;
  if (dbg) console.log(`[DNM] checking ${conns.length} connections, hitR=${hitR}`);
  for (const conn of conns) {
    if (conn.hidden && !game.user?.isGM) continue;
    const stops = conn.stops ?? [];
    if (stops.length < 2) continue;
    if (dbg) console.log(`[DNM]  conn ${conn.id} type=${conn.type} stops=${stops.length} stop0nodeId=${stops[0]?.nodeId} lastNodeId=${stops[stops.length-1]?.nodeId}`);
    if (stops[0]?.nodeId) {
      const ip = _iconPoint(stops[0], allNodes[stops[0].nodeId]);
      if (dbg) console.log(`[DNM]   start icon at (${ip.x.toFixed(1)},${ip.y.toFixed(1)}) dist=${Math.hypot(wx-ip.x,wy-ip.y).toFixed(1)}`);
      if (Math.hypot(wx - ip.x, wy - ip.y) <= hitR) return conn;
    }
    if (stops[stops.length-1]?.nodeId) {
      const last = stops[stops.length-1];
      const ip   = _iconPoint(last, allNodes[last.nodeId]);
      if (dbg) console.log(`[DNM]   end icon at (${ip.x.toFixed(1)},${ip.y.toFixed(1)}) dist=${Math.hypot(wx-ip.x,wy-ip.y).toFixed(1)}`);
      if (Math.hypot(wx - ip.x, wy - ip.y) <= hitR) return conn;
    }
  }
  return null;
}

function _findSecretEyeAtPoint(wx, wy) {
  const scene = canvas?.scene;
  if (!scene) return null;
  const conns = Object.values(listConnections(scene));
  const hitR  = 26; // eye radius (20) + tolerance
  for (const conn of conns) {
    if (!conn.hidden && conn.type !== "secret") continue;
    const stops = conn.stops ?? [];
    const path  = conn.path;
    if (!path?.length) continue;
    const floaters = [stops[0], stops[stops.length - 1]].filter(s => s && !s.nodeId);
    if (floaters.length > 0) {
      for (const s of floaters) {
        if (Math.hypot(wx - s.x, wy - s.y) <= hitR) return conn;
      }
    } else {
      const mid = path[Math.floor(path.length / 2)];
      if (mid && Math.hypot(wx - mid.x, wy - mid.y) <= hitR) return conn;
    }
  }
  return null;
}

function _findWaypointAtPoint(wx, wy) {
  const scene = canvas?.scene;
  if (!scene) return null;
  const conns = Object.values(listConnections(scene));
  const hitR  = 14;
  for (const conn of conns) {
    const stops = conn.stops ?? [];
    // Only match intermediate stops (skip first/last terminals)
    for (let i = 1; i < stops.length - 1; i++) {
      const s = stops[i];
      if (Math.hypot(wx - s.x, wy - s.y) <= hitR) {
        return { connId: conn.id, idx: i, wpt: s };
      }
    }
  }
  return null;
}

function _tokenNodeId(token) {
  const scene = canvas?.scene;
  if (!scene) return null;
  const td  = token.document ?? token;
  const tx  = td.x + (td.width  * (canvas.grid?.size ?? 100)) / 2;
  const ty  = td.y + (td.height * (canvas.grid?.size ?? 100)) / 2;
  for (const node of Object.values(listNodes(scene))) {
    const hw = (node.width  ?? 200) / 2;
    const hh = (node.height ?? 200) / 2;
    if (tx >= node.x - hw && tx <= node.x + hw &&
        ty >= node.y - hh && ty <= node.y + hh) return node.id;
  }
  return null;
}

function _findInsertHandleAtPoint(wx, wy) {
  const scene = canvas?.scene;
  if (!scene) return null;
  const conns = Object.values(listConnections(scene));
  const hitR  = 12;
  for (const conn of conns) {
    const path = conn.path;
    if (!path?.length) continue;
    const stops     = conn.stops ?? [];
    const midStops  = stops.slice(1, -1);
    const totalSegs = midStops.length + 1;
    for (let i = 0; i < totalSegs; i++) {
      const t   = (i + 0.5) / totalSegs;
      const pos = pointAlongPath(path, t);
      if (Math.hypot(wx - pos.x, wy - pos.y) <= hitR) {
        return { connId: conn.id, insertBefore: i + 1 }; // +1 because we skip terminal at index 0
      }
    }
  }
  return null;
}

async function _showWaypointMenu(connId, idx, stop) {
  let action;
  const hasEncounter = stop.encounter?.chance > 0;
  try {
    action = await foundry.applications.api.DialogV2.wait({
      window:      { title: "Stop" },
      content:     "<p>What would you like to do with this stop?</p>",
      rejectClose: false,
      buttons: [
        { action: "delete",    label: "Delete Stop",   icon: "fa-solid fa-trash" },
        {
          action: "junction",
          label:  stop.kind === "junction" ? "Make Path Stop" : "Make Junction",
          icon:   "fa-solid fa-code-fork",
        },
        {
          action: "encounter",
          label:  hasEncounter ? "Edit Encounter" : "Set Encounter",
          icon:   "fa-solid fa-dice-d20",
        },
      ],
    });
  } catch { return; }
  if (!action) return;
  if (action === "delete")    ConnectionManager.removeStop(connId, idx);
  if (action === "junction")  ConnectionManager.toggleStopKind(connId, idx);
  if (action === "encounter") _showStopEncounterDialog(connId, idx, stop);
}

async function _showStopEncounterDialog(connId, idx, stop) {
  const enc = stop.encounter ?? { chance: 0, tableId: "" };
  let result;
  try {
    result = await foundry.applications.api.DialogV2.wait({
      window:      { title: "Stop Encounter" },
      rejectClose: false,
      content: `
        <div style="display:flex;flex-direction:column;gap:8px;padding:6px 0">
          <div style="display:flex;gap:8px;align-items:center">
            <label style="white-space:nowrap;min-width:80px">Chance %</label>
            <input id="dnm-enc-chance" type="number" min="0" max="100" step="1"
              value="${enc.chance}" style="width:70px;background:#0a1c27;color:#ccc;border:1px solid #00ffff44;border-radius:4px;padding:3px 6px" />
            <span style="font-size:11px;color:#aaa">(0 = off)</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <label style="white-space:nowrap;min-width:80px">Table ID</label>
            <input id="dnm-enc-table" type="text"
              value="${enc.tableId}" placeholder="Paste RollTable ID…"
              style="flex:1;background:#0a1c27;color:#ccc;border:1px solid #00ffff44;border-radius:4px;padding:3px 6px" />
          </div>
          <p style="font-size:11px;color:#aaa;margin:0">Right-click a Roll Table in the sidebar → Copy ID. Result is GM-only.</p>
        </div>`,
      buttons: [
        { action: "save",   label: "Save",   icon: "fa-solid fa-check" },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-times" },
      ],
    });
  } catch { return; }
  if (!result || result === "cancel") return;

  // Read values from DOM before dialog closes
  const chance  = Math.min(100, Math.max(0, Number(document.getElementById("dnm-enc-chance")?.value) || 0));
  const tableId = (document.getElementById("dnm-enc-table")?.value ?? "").trim();

  const scene = canvas?.scene;
  if (!scene) return;
  const conn  = (await import("./flags.js")).listConnections(scene)[connId];
  if (!conn) return;
  const stops = (conn.stops ?? []).map((s, i) =>
    i === idx ? { ...s, encounter: { chance, tableId } } : s
  );
  ConnectionManager.updateConnection(connId, { stops });
}

function _activateOverlay(mode = "create") {
  const iface = canvas?.interface;
  if (!iface) return;

  // Recreate if destroyed (scene reload clears canvas.interface children)
  if (!overlay || overlay.destroyed) {
    overlay    = new PIXI.Container();
    overlayGfx = new PIXI.Graphics();
    overlay.addChild(overlayGfx);
    overlay.eventMode = "static";  // interactive=true is deprecated in PIXI v7+
    overlay.cursor    = "crosshair";
    overlay.zIndex    = 9999;

    overlay.on("pointerdown",      _onDown);
    overlay.on("pointermove",      _onMove);
    overlay.on("pointerup",        _onUp);
    overlay.on("pointerupoutside", _cancel);
    overlay.on("pointercancel",    _cancel);
  }

  // Always refresh hitArea — canvas dimensions may differ after scene load
  overlay.hitArea = _canvasHitArea();

  // canvas.interface is world-space → coordinates match stored node positions
  if (!iface.children.includes(overlay)) iface.addChild(overlay);
  overlay.visible = true;

  if (mode === "connect") {
    ui.notifications?.info("Connection tool: click a node to start. Right-click a node to edit it.");
  } else if (mode === "create") {
    ui.notifications?.info("Node tool: click a node to edit, drag a node to move, drag empty canvas to place new.");
  }
}

function _deactivateOverlay() {
  dragPointerId = null;
  dragStart     = null;
  overlayGfx?.clear();
  if (overlay) overlay.visible = false;
}

function _canvasHitArea() {
  const d = canvas?.dimensions;
  return d
    ? new PIXI.Rectangle(d.sceneX, d.sceneY, d.sceneWidth, d.sceneHeight)
    : new PIXI.Rectangle(-1e5, -1e5, 2e5, 2e5);
}

function _onDown(event) {
  // The PIXI overlay is only active (visible, with hitArea) when the GM has
  // a DNM tool selected (createMode or externalOverlay/connect mode).
  // Travel and eye-toggle are handled by the native DOM listener instead.
  if (dragPointerId != null) return;

  const btn = event.button ?? event.data?.button ?? 0;

  const pos = _worldPos(event);
  if (!pos) return;

  // Only GMs with an active DNM tool reach here.
  // Priority order:
  // 1. Waypoints  (drag or right-click for menu)
  // 2. Door icons (right-click or connect-mode → config; left-click → travel)
  // 3. Insert handles
  // 4. Nodes (drag to move, short click to edit)
  // 5. Empty canvas (create mode: drag to place new node)

  const hitWaypoint = _findWaypointAtPoint(pos.x, pos.y);
  if (hitWaypoint) {
    event.stopPropagation();
    if (ConnectionManager.isConnectModeActive()) {
      // In connect mode, clicking a junction stop starts/ends a connection there
      ConnectionManager.handleJunctionClick(
        hitWaypoint.connId, hitWaypoint.idx,
        hitWaypoint.wpt.x, hitWaypoint.wpt.y
      );
      return;
    }
    // Normal mode: begin drag; short click opens menu (detected in _onUp)
    isWaypointDrag = true;
    waypointConnId = hitWaypoint.connId;
    waypointIdx    = hitWaypoint.idx;
    dragPointerId  = event.pointerId ?? event.data?.pointerId;
    dragStart      = { x: pos.x, y: pos.y };
    dragOffsetX    = pos.x - hitWaypoint.wpt.x;
    dragOffsetY    = pos.y - hitWaypoint.wpt.y;
    return;
  }

  const hitConn = _findConnectionIconAtPoint(pos.x, pos.y);
  if (hitConn) {
    event.stopPropagation();
    // GM with active tool: right-click or connect mode → config; left-click → travel
    if (btn === 2 || ConnectionManager.isConnectModeActive()) {
      ConnectionManager.openConfig(hitConn.id);
      return;
    }
    // Left-click → GM travel (GM bypass: no lock check)
    const controlled = canvas.tokens?.controlled ?? [];
    if (!controlled.length) { ui.notifications?.warn("Select a token first."); return; }
    const stops        = hitConn.stops ?? [];
    const lastStop     = stops[stops.length - 1];
    const nodeId       = _tokenNodeId(controlled[0]);
    const startStopIdx = (nodeId && lastStop?.nodeId === nodeId) ? stops.length - 1 : 0;
    TravelManager.startTravel(controlled[0], hitConn.id, startStopIdx);
    return;
  }

  const hitInsert = _findInsertHandleAtPoint(pos.x, pos.y);
  if (hitInsert) {
    event.stopPropagation();
    const gs = canvas.grid?.size ?? 100;
    ConnectionManager.insertStop(hitInsert.connId, hitInsert.insertBefore, {
      x: Math.round(pos.x / gs) * gs,
      y: Math.round(pos.y / gs) * gs,
    });
    return;
  }

  const hitNode = _findNodeAtPoint(pos.x, pos.y);
  if (hitNode) {
    event.stopPropagation();
    if (ConnectionManager.isConnectModeActive()) {
      ConnectionManager.handleNodeClick(hitNode.id);
      return;
    }
    // Short click = edit, drag = move — determined in _onUp
    isNodeDrag    = true;
    nodeDragging  = hitNode;
    dragPointerId = event.pointerId ?? event.data?.pointerId ?? 0;
    dragStart     = { x: pos.x, y: pos.y };
    dragOffsetX   = pos.x - hitNode.x;
    dragOffsetY   = pos.y - hitNode.y;
    return;
  }

  // Right-click on empty canvas passes through for Foundry pan
  if (btn === 2) return;

  // Empty canvas — new node drag (create mode only)
  if (!createMode) return;
  dragPointerId = event.pointerId ?? event.data?.pointerId;
  dragStart     = { x: pos.x, y: pos.y };
  event.stopPropagation();
  overlayGfx.clear();
}

function _onMove(event) {
  if (dragPointerId == null) return;
  const pid = event.pointerId ?? event.data?.pointerId ?? 0;
  if (pid !== dragPointerId) return;
  const pos = _worldPos(event);
  if (!pos) return;

  const gs = canvas.grid?.size ?? 100;

  if (isWaypointDrag) {
    const nx = Math.round((pos.x - dragOffsetX) / gs) * gs;
    const ny = Math.round((pos.y - dragOffsetY) / gs) * gs;
    overlayGfx.clear();
    overlayGfx.lineStyle(2, 0xff9ff3, 0.9);
    overlayGfx.beginFill(0xff9ff3, 0.15);
    overlayGfx.drawCircle(nx, ny, 10);
    overlayGfx.endFill();
    return;
  }

  if (isNodeDrag && nodeDragging) {
    const nx = Math.round((pos.x - dragOffsetX) / gs) * gs;
    const ny = Math.round((pos.y - dragOffsetY) / gs) * gs;
    const hw = (nodeDragging.width  ?? 200) / 2;
    const hh = (nodeDragging.height ?? 200) / 2;
    overlayGfx.clear();
    overlayGfx.lineStyle(2, 0xffff00, 0.9);
    overlayGfx.beginFill(0xffff00, 0.08);
    overlayGfx.drawRect(nx - hw, ny - hh, nodeDragging.width ?? 200, nodeDragging.height ?? 200);
    overlayGfx.endFill();
    return;
  }

  if (createMode) _drawPreview(dragStart, pos);
}

function _onUp(event) {
  const pid = event.pointerId ?? event.data?.pointerId ?? 0;
  if (dragPointerId == null || pid !== dragPointerId) return;

  const pos = _worldPos(event);
  dragPointerId = null;
  overlayGfx.clear();

  // ── Waypoint drag-to-move / click-to-menu ──────────────────────────────────
  if (isWaypointDrag) {
    const connId = waypointConnId;
    const idx    = waypointIdx;
    // Read wpt before clearing state
    const scene  = canvas?.scene;
    const conn   = scene ? (listConnections(scene)[connId]) : null;
    const wpt    = conn?.stops?.[idx];
    isWaypointDrag = false;
    waypointConnId = null;
    waypointIdx    = -1;

    if (pos && dragStart) {
      const moved = Math.hypot(pos.x - dragStart.x, pos.y - dragStart.y);
      if (moved >= 8) {
        const gs = canvas.grid?.size ?? 100;
        const nx = Math.round((pos.x - dragOffsetX) / gs) * gs;
        const ny = Math.round((pos.y - dragOffsetY) / gs) * gs;
        ConnectionManager.updateStop(connId, idx, { x: nx, y: ny });
      } else if (wpt) {
        // Treated as a click — open the waypoint menu
        _showWaypointMenu(connId, idx, wpt);
      }
    }
    dragStart = null;
    return;
  }

  // ── Node drag-to-move ───────────────────────────────────────────────────────
  if (isNodeDrag && nodeDragging) {
    const node = nodeDragging;
    isNodeDrag   = false;
    nodeDragging = null;

    if (pos) {
      const moved = Math.hypot(pos.x - dragStart.x, pos.y - dragStart.y);
      if (moved < 8) {
        NodeManager.openConfig(node.id);
      } else {
        const gs = canvas.grid?.size ?? 100;
        const nx = Math.round((pos.x - dragOffsetX) / gs) * gs;
        const ny = Math.round((pos.y - dragOffsetY) / gs) * gs;
        NodeManager.updateNode(node.id, { x: nx, y: ny });
      }
    }
    dragStart = null;
    return;
  }

  // ── New node drag-to-place ──────────────────────────────────────────────────
  if (!createMode || !dragStart || !pos) { dragStart = null; return; }
  const rect = _normalizeRect(dragStart, pos);
  dragStart   = null;
  if (rect.w < MIN_NODE_SIZE && rect.h < MIN_NODE_SIZE) return;
  NodeManager.openConfig(null, { x: rect.cx, y: rect.cy, width: rect.w, height: rect.h });
}

function _cancel() {
  dragPointerId  = null;
  dragStart      = null;
  isNodeDrag     = false;
  nodeDragging   = null;
  isWaypointDrag = false;
  waypointConnId = null;
  waypointIdx    = -1;
  overlayGfx?.clear();
}

function _drawPreview(start, end) {
  if (!overlayGfx || !start || !end) return;
  const r = _normalizeRect(start, end);
  overlayGfx.clear();
  overlayGfx.lineStyle(2, 0x00ffff, 0.9);
  overlayGfx.beginFill(0x00ffff, 0.08);
  overlayGfx.drawRect(r.left, r.top, r.w, r.h);
  overlayGfx.endFill();
}

function _normalizeRect(a, b) {
  const gs   = canvas.grid?.size ?? 100;
  const snap = v => Math.round(v / gs) * gs;
  const left = snap(Math.min(a.x, b.x));
  const top  = snap(Math.min(a.y, b.y));
  const w    = Math.max(MIN_NODE_SIZE, snap(Math.abs(b.x - a.x)));
  const h    = Math.max(MIN_NODE_SIZE, snap(Math.abs(b.y - a.y)));
  return { left, top, w, h, cx: left + w / 2, cy: top + h / 2 };
}

// ── FoW wall helpers ──────────────────────────────────────────────────────────

const NODE_WALL_OUTSET = 8; // px — walls expand beyond node edge for breathing room

async function _createWallBox(scene, node) {
  const b   = nodeBounds(node);
  const o   = NODE_WALL_OUTSET;
  const doorless = CONST.WALL_DOOR_TYPES?.NONE ?? 0;
  const walls = [
    { c: [b.left  - o, b.top    - o, b.right + o, b.top    - o] },  // top
    { c: [b.right + o, b.top    - o, b.right + o, b.bottom + o] },  // right
    { c: [b.right + o, b.bottom + o, b.left  - o, b.bottom + o] },  // bottom
    { c: [b.left  - o, b.bottom + o, b.left  - o, b.top    - o] },  // left
  ].map(w => ({
    ...w,
    door:   doorless,
    sense:  CONST.WALL_SENSE_TYPES?.NORMAL ?? 1,
    flags:  { [MODULE_ID]: { [FLAG_NODE_ID]: node.id } },
  }));

  const docs = await scene.createEmbeddedDocuments("Wall", walls);
  return docs.map(d => d.id);
}

async function _deleteWalls(scene, wallIds) {
  if (!wallIds?.length) return;
  const existing = wallIds.filter(id => scene.walls.has(id));
  if (existing.length) await scene.deleteEmbeddedDocuments("Wall", existing, { strict: false });
}

// ── Ambient light helpers ─────────────────────────────────────────────────────

async function _createNodeLight(scene, node) {
  const b      = nodeBounds(node);
  // Radius = half of the shorter axis so the light fills but doesn't spill far
  const radius = Math.max(b.w, b.h) / 2;
  try {
    const [light] = await scene.createEmbeddedDocuments("AmbientLight", [{
      x:     b.cx,
      y:     b.cy,
      config: {
        dim:    radius,
        bright: radius * 0.6,
        angle:  360,
        color:  null,
        alpha:  0.5,
        animation: { type: null },
      },
    }]);
    return light?.id ?? null;
  } catch (e) {
    console.warn("[DNM] Failed to create node light:", e);
    return null;
  }
}

async function _deleteLight(scene, lightId) {
  if (!lightId) return;
  try {
    if (scene.lights?.has(lightId)) {
      await scene.deleteEmbeddedDocuments("AmbientLight", [lightId], { strict: false });
    }
  } catch (e) {
    console.warn("[DNM] Failed to delete node light:", e);
  }
}
