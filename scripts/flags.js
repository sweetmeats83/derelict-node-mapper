/**
 * flags.js — scene flag read/write helpers.
 * All node and connection data lives in scene flags so it persists with the
 * scene document and syncs automatically to all connected clients via Foundry's
 * normal document update channel.
 */

import { MODULE_ID, FLAG_STATE_NODES, FLAG_STATE_CONNECTIONS, FLAG_DISCOVERED } from "./constants.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

function scene(s = canvas?.scene) {
  if (!s) throw new Error("[DNM] No active scene.");
  return s;
}

function clone(v) {
  return foundry.utils.duplicate(v ?? {});
}

function readNodes(s) {
  return clone(s.getFlag(MODULE_ID, FLAG_STATE_NODES) ?? {});
}

function readConnections(s) {
  return clone(s.getFlag(MODULE_ID, FLAG_STATE_CONNECTIONS) ?? {});
}


// ── Node API ──────────────────────────────────────────────────────────────────

export function listNodes(s = canvas?.scene) {
  return readNodes(scene(s));
}

export function getNode(s, nodeId) {
  if (!nodeId) return null;
  return listNodes(s)[nodeId] ?? null;
}

export async function upsertNode(s, node) {
  s = scene(s);
  const id = node.id ?? foundry.utils.randomID();
  const entry = { ...node, id };
  // Write only this key — avoids deep-merge clobbering other nodes
  await s.update({ [`flags.${MODULE_ID}.${FLAG_STATE_NODES}.${id}`]: entry });
  return entry;
}

export async function deleteNode(s, nodeId) {
  if (!nodeId) return;
  s = scene(s);
  // Use -=key syntax so Foundry actually removes the key instead of merging
  return s.update({ [`flags.${MODULE_ID}.${FLAG_STATE_NODES}.-=${nodeId}`]: null });
}

// ── Connection API ────────────────────────────────────────────────────────────

export function listConnections(s = canvas?.scene) {
  return readConnections(scene(s));
}

export function getConnection(s, connectionId) {
  if (!connectionId) return null;
  return listConnections(s)[connectionId] ?? null;
}

export async function upsertConnection(s, connection) {
  s = scene(s);
  const id = connection.id ?? foundry.utils.randomID();
  const entry = { ...connection, id };
  // Write only this key — avoids deep-merge clobbering other connections
  await s.update({ [`flags.${MODULE_ID}.${FLAG_STATE_CONNECTIONS}.${id}`]: entry });
  return entry;
}

export async function deleteConnection(s, connectionId) {
  if (!connectionId) return;
  s = scene(s);
  // Use -=key syntax so Foundry actually removes the key instead of merging
  return s.update({ [`flags.${MODULE_ID}.${FLAG_STATE_CONNECTIONS}.-=${connectionId}`]: null });
}

export function connectionsForNode(s, nodeId) {
  if (!nodeId) return [];
  return Object.values(listConnections(s)).filter(c =>
    c.stops?.some(stop => stop.nodeId === nodeId) ||
    c.from === nodeId || c.to === nodeId   // legacy fallback
  );
}

// ── Discovery API ─────────────────────────────────────────────────────────────

/** Returns a Set of nodeIds this user has entered (persisted to scene flags). */
export function getDiscovered(s, userId) {
  s = scene(s);
  const all = s.getFlag(MODULE_ID, FLAG_DISCOVERED) ?? {};
  return new Set(Object.keys(all[userId] ?? {}));
}

/** GM only — writes a discovery entry to scene flags. */
export async function markDiscovered(s, userId, nodeId) {
  if (!game.user?.isGM || !userId || !nodeId) return;
  s = scene(s);
  await s.update({ [`flags.${MODULE_ID}.${FLAG_DISCOVERED}.${userId}.${nodeId}`]: true });
}

// ── Migration ──────────────────────────────────────────────────────────────────

/**
 * One-time migration: adds `stops` array to connections that don't have one yet.
 * Safe to call repeatedly — skips connections that already have stops.
 * Only runs on the GM client.
 */
export async function migrateConnectionsToStops(s) {
  s = scene(s);
  if (!game.user?.isGM) return;
  const conns = readConnections(s);
  const toMigrate = Object.values(conns).filter(c => !c.stops?.length);
  if (!toMigrate.length) return;
  console.log(`[DNM] Migrating ${toMigrate.length} connection(s) to stop-based format`);
  for (const conn of toMigrate) {
    const migrated = _migrateConnToStops(conn, conns);
    await s.update({ [`flags.${MODULE_ID}.${FLAG_STATE_CONNECTIONS}.${conn.id}`]: migrated });
  }
  console.log("[DNM] Migration complete");
}

function _migrateConnToStops(conn, allConns) {
  const stops = [];
  const path  = conn.path ?? [];

  // First endpoint
  if (conn.from) {
    const pos = path[0];
    stops.push({ kind: "terminal", nodeId: conn.from, x: pos?.x ?? 0, y: pos?.y ?? 0 });
  } else if (conn.fromWaypoint) {
    const src = allConns[conn.fromWaypoint.connId];
    const wpt = src?.waypoints?.[conn.fromWaypoint.wpIdx];
    stops.push({ kind: "terminal", x: wpt?.x ?? path[0]?.x ?? 0, y: wpt?.y ?? path[0]?.y ?? 0 });
  } else if (path[0]) {
    stops.push({ kind: "terminal", x: path[0].x, y: path[0].y });
  }

  // Intermediate waypoints
  for (const wpt of (conn.waypoints ?? [])) {
    stops.push({ kind: wpt.isJunction ? "junction" : "path", x: wpt.x, y: wpt.y });
  }

  // Last endpoint
  const last = path[path.length - 1];
  if (conn.to) {
    stops.push({ kind: "terminal", nodeId: conn.to, x: last?.x ?? 0, y: last?.y ?? 0 });
  } else if (conn.toWaypoint) {
    const src = allConns[conn.toWaypoint.connId];
    const wpt = src?.waypoints?.[conn.toWaypoint.wpIdx];
    stops.push({ kind: "terminal", x: wpt?.x ?? last?.x ?? 0, y: wpt?.y ?? last?.y ?? 0 });
  } else if (last) {
    stops.push({ kind: "terminal", x: last.x, y: last.y });
  }

  return { ...conn, stops };
}

