/**
 * main.js — module entry point.
 *
 * Only Hooks and tool registration live here.  All logic is in the
 * specialist modules.
 */

import {
  MODULE_ID,
  SOCKET_CHANNEL,
  TOOL_CREATE_NODE,
  TOOL_CONNECT_NODES,
} from "./constants.js";
import { attachLayers, detachLayers } from "./layer.js";
import { redrawMap } from "./renderer.js";
import { NodeManager, activateConnectOverlay, deactivateConnectOverlay, activateTravelOverlay, resetTravelOverlay } from "./nodeManager.js";
import { ConnectionManager } from "./connectionManager.js";
import { TravelManager } from "./travel.js";
import { migrateConnectionsToStops, markDiscovered } from "./flags.js";
import { initTransitBar, destroyTransitBar, refreshTransitBar } from "./transitBar.js";

// ── Init ──────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "debug", {
    scope:  "client",
    config: true,
    type:   Boolean,
    default: false,
    name:   "Derelict Node Mapper: Debug Logging",
    hint:   "Verbose console output for GM troubleshooting.",
  });

  game.settings.register(MODULE_ID, "fastTravelEnabled", {
    scope:   "world",
    config:  false,   // GM toggles via the transit card button, not settings menu
    type:    Boolean,
    default: true,
  });

  // ApplicationV2 PARTS load templates automatically — no pre-load needed.
});

// ── Ready ─────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  if (!game.socket) return;
  game.socket.on(SOCKET_CHANNEL, async payload => {
    // Discovery write — GM persists the flag, players can't write scene flags.
    if (payload?.action === "markDiscovered") {
      if (game.user?.isGM && canvas.scene && payload.userId && payload.nodeId) {
        await markDiscovered(canvas.scene, payload.userId, payload.nodeId).catch(console.warn);
      }
      return;
    }
    // One-time toll paid — GM writes the flag on the connection.
    if (payload?.action === "markTollPaid") {
      if (game.user?.isGM && canvas.scene && payload.connectionId) {
        await ConnectionManager.updateConnection(payload.connectionId, { tollPaid: true }).catch(console.warn);
      }
      return;
    }
    TravelManager.handleSocket(payload);
  });
});

// ── Canvas lifecycle ──────────────────────────────────────────────────────────

Hooks.on("canvasReady", async () => {
  attachLayers();
  await TravelManager.purgeOrphanScouts();
  await migrateConnectionsToStops(canvas.scene);
  await ConnectionManager.purgeOrphanConnections();
  await ConnectionManager.rebuildMissingCaches();
  redrawMap();
  activateTravelOverlay();  // always-on so players can click door icons
  initTransitBar();

  // Expose console helper for GM to force-rebuild all paths (e.g. after routing changes)
  if (game.user?.isGM) {
    game.dnm = game.dnm ?? {};
    game.dnm.rebuildAllPaths = () => ConnectionManager.rebuildAllPaths().then(() => redrawMap());
    game.dnm.centerMap      = ()       => ConnectionManager.translateMap().then(() => redrawMap());
    game.dnm.translateMap   = (dx, dy) => ConnectionManager.translateMap(dx, dy).then(() => redrawMap());
    game.dnm.undoTranslate       = ()       => ConnectionManager.undoTranslate().then(() => redrawMap());
    game.dnm.resyncWallsAndLights = ()       => NodeManager.resyncWallsAndLights();
  }
});

Hooks.on("canvasTearDown", () => {
  TravelManager.cancelAllTravel();
  NodeManager.toggleCreateMode(false);
  ConnectionManager.toggleConnectMode(false);
  deactivateConnectOverlay();
  resetTravelOverlay();
  detachLayers();
  destroyTransitBar();
});

// ── Scout token hooks ─────────────────────────────────────────────────────────

// Force teleport (bypass wall collision) for every scout token update.
// This fires before Foundry's collision check so it cannot be blocked by walls.
Hooks.on("preUpdateToken", (tokenDoc, _changes, options) => {
  if (tokenDoc.getFlag?.(MODULE_ID, "scout")) {
    options.teleport = true;
    options.animate  = false;
  }
});

// When the GM creates a scout token Foundry may auto-select it on owning clients.
// Immediately release everything so no orange selection box appears.
Hooks.on("createToken", (tokenDoc) => {
  if (tokenDoc.getFlag?.(MODULE_ID, "scout")) {
    canvas.tokens?.releaseAll();
  }
});

// ── Scene flag changes → redraw ───────────────────────────────────────────────

Hooks.on("updateScene", (scene, diff) => {
  if (scene.id !== canvas.scene?.id) return;

  // Canvas was resized from scene controls — auto-centre the node map
  if (game.user?.isGM && (diff.width != null || diff.height != null)) {
    ui.notifications?.info("[DNM] Canvas resized — re-centring node map…");
    ConnectionManager.translateMap().then(() => redrawMap());
    return;
  }

  const flags = diff?.flags?.[MODULE_ID];
  if (!flags) return;
  redrawMap();
  refreshTransitBar();
});

// When the GM toggles fast travel the setting update fires on all clients.
Hooks.on("updateSetting", setting => {
  if (setting.key === `${MODULE_ID}.fastTravelEnabled`) refreshTransitBar();
});

// ── Tool registration ─────────────────────────────────────────────────────────

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user?.isGM) return;

  // In v13 controls may be an array or a Map; normalise to array
  const sets = Array.isArray(controls)
    ? controls
    : (controls instanceof Map ? Array.from(controls.values()) : Object.values(controls ?? {}));

  const tilesGroup = sets.find(s => s?.name === "tiles");
  if (!tilesGroup) return;

  const tools = tilesGroup.tools;

  // Plain selectable tools (no toggle) — behave like all other Foundry toolbar tools:
  // orange box when selected, deselects when another tool is picked.
  // onChange fires true on select, false on deselect.
  _upsertTool(tools, {
    name:     TOOL_CREATE_NODE,
    title:    "Place Node",
    icon:     "fa-solid fa-circle-nodes",
    onChange: active => NodeManager.toggleCreateMode(active),
  });

  _upsertTool(tools, {
    name:     TOOL_CONNECT_NODES,
    title:    "Connect Nodes",
    icon:     "fa-solid fa-route",
    onChange: active => {
      ConnectionManager.toggleConnectMode(active);
      if (active) activateConnectOverlay();
      else        deactivateConnectOverlay();
    },
  });
});

// Deactivate our tools when the GM switches away from the tiles group entirely.
// Tool activation within the tiles group is handled by onChange on each tool above.
Hooks.on("renderSceneControls", (controls) => {
  /* eslint-disable no-restricted-syntax */
  const groupName = controls?.activeControl;  // deprecated but reliable in v13
  /* eslint-enable no-restricted-syntax */
  if (groupName === "tiles") return;  // tool onChange handles activation
  NodeManager.toggleCreateMode(false);
  ConnectionManager.toggleConnectMode(false);
  deactivateConnectOverlay();
});

// Upsert: update in-place if the tool already exists, add if not.
// Never deletes — deleting from the Map while a tool is active causes Foundry
// to crash when it later calls onChange on the now-missing entry.
function _upsertTool(tools, tool) {
  if (!tools || !tool) return;
  if (tools instanceof Map) {
    tools.set(tool.name, tool);
  } else if (Array.isArray(tools)) {
    const idx = tools.findIndex(t => t?.name === tool.name);
    if (idx >= 0) tools[idx] = tool;
    else tools.push(tool);
  } else if (typeof tools === "object") {
    tools[tool.name] = tool;
  }
}

