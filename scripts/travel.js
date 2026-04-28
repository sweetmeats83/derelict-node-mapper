/**
 * travel.js — TokenDot travel system with scout token for FoW.
 *
 * Architecture:
 *  - Originating client owns the full travel loop and all decisions.
 *  - GM acts as a privileged service: creates/moves/deletes the scout token
 *    and teleports the real token into the destination node.
 *  - All other clients (spectators) display a visual dot that follows
 *    throttled position broadcasts from the originating client.
 *
 * Socket actions (broadcast to all clients, each handler filters by role):
 *   startTravel  { tokenId, connectionId, startStopIdx, originUserId }
 *   dotMove      { tokenId, x, y, originUserId }   — throttled position update
 *   enterRoom    { tokenId, destNodeId, originUserId }
 *   cancelTravel { tokenId, originUserId }
 *
 * No shadow runner. No junction synchronisation. One travel loop per journey.
 */


import {
  MODULE_ID,
  TRAVEL_STATE,
  DOT_RADIUS,
  DOT_GLOW_RADIUS,
  TRAVEL_SPEED,
  SOCKET_CHANNEL,
  BLOCKING_TYPES,
} from "./constants.js";
import { getDotContainer } from "./layer.js";
import { getConnection, getNode, listConnections } from "./flags.js";
import { pointAtDistance, pathLength } from "./routing.js";
import { ConnectionManager } from "./connectionManager.js";

// ── Module-level state ────────────────────────────────────────────────────────

const activeDots       = new Map();  // tokenId → dot  (all clients)
const _gmScoutMap      = new Map();  // tokenId → scoutId  (GM only)
const _gmScoutPending  = new Map();  // tokenId → bool  (GM throttle)

let _activePanel = null; // the currently-visible direction panel DOM element

const STOP_MATCH_DIST       = 80;   // px — generous to handle node-placed stops
const SCOUT_UPDATE_INTERVAL = 40;  // px between FoW/spectator position broadcasts

// ── Public API ────────────────────────────────────────────────────────────────

export class TravelManager {

  static async startTravel(token, connectionId, startStopIdx = 0) {
    const scene = canvas.scene;
    if (!scene || !token || !connectionId) return;
    if (game.paused && !game.user?.isGM) {
      ui.notifications?.warn("[DNM] Travel is not possible while the game is paused.");
      return;
    }
    const tokenDoc = token.document ?? token;
    const tokenId  = tokenDoc.id;
    if (activeDots.has(tokenId)) return;

    const conn = getConnection(scene, connectionId);
    if (!conn?.stops?.length || !conn.path) return;

    // Non-travelable connections block everyone except GMs
    if (conn.travelable === false && !game.user?.isGM) {
      ui.notifications?.warn("[DNM] This passage cannot be travelled.");
      return;
    }

    // GMs can bypass all locks — only players are blocked
    if (!game.user?.isGM) {
      const startStop = conn.stops[startStopIdx];
      const isBlocked = BLOCKING_TYPES.has(conn.type) || (startStop?.locked ?? false);
      if (isBlocked) {
        new (await import("./doors.js")).DoorBlockedApp(conn, token, {
          onBack: () => {},
        }).render(true);
        return;
      }
      // One-way: only allow entry from stop[0] (forward direction)
      if (conn.oneWay && startStopIdx !== 0) {
        ui.notifications?.warn("[DNM] This passage only allows travel in one direction.");
        return;
      }
    }

    const originUserId = game.user.id;
    _broadcast({ action: "startTravel", tokenId, connectionId, startStopIdx, originUserId });
    await this._runTravel(tokenDoc, conn, startStopIdx, originUserId);
  }

  static cancelAllTravel() {
    document.body.classList.remove("dnm-traveling");
    for (const [tokenId] of activeDots) _restoreTravelBorder(tokenId);
    _removeAllPanels();
    for (const [, dot] of activeDots) _destroyDot(dot);
    activeDots.clear();
    if (game.user.isGM) {
      const scene = canvas.scene;
      for (const [, scoutId] of _gmScoutMap) {
        if (scene) _destroyScoutToken(scene, scoutId);
      }
      _gmScoutMap.clear();
      _gmScoutPending.clear();
    }
  }

  /**
   * GM-only: delete every token in the current scene that carries the scout flag.
   * Called on canvasReady to purge scouts left behind by interrupted travel
   * (browser refresh, scene change, crash, etc.).
   */
  static async purgeOrphanScouts() {
    if (!game.user?.isGM || !canvas.scene) return;
    const orphans = canvas.scene.tokens.filter(t => t.getFlag?.(MODULE_ID, "scout"));
    if (!orphans.length) return;
    console.log(`[DNM] Purging ${orphans.length} orphaned scout token(s).`);
    await canvas.scene.deleteEmbeddedDocuments("Token", orphans.map(t => t.id));
  }

  // ── Socket handler ──────────────────────────────────────────────────────────

  static handleSocket(payload) {
    if (!payload?.action) return;
    const scene    = canvas.scene;
    if (!scene) return;
    const isOrigin = payload.originUserId === game.user.id;

    switch (payload.action) {

      case "startTravel": {
        if (isOrigin) return;
        const conn = getConnection(scene, payload.connectionId);
        if (!conn?.path?.length || !conn?.stops?.length) return;

        // GM: create scout token for the traveling player
        if (game.user.isGM) _gmHandleStartTravel(scene, payload, conn);

        // All non-originators: spawn a visual dot at start position
        const si      = payload.startStopIdx ?? 0;
        const startPi = conn.stops[si]?.pathIdx ?? (si === 0 ? 0 : conn.path.length - 1);
        const startPos = conn.path[Math.min(startPi, conn.path.length - 1)];
        if (!activeDots.has(payload.tokenId)) {
          const dot = _spawnDot(payload.tokenId, conn, payload.originUserId, null, null);
          if (dot) {
            dot.wrapper.position.set(startPos.x, startPos.y);
            activeDots.set(payload.tokenId, dot);
          }
        }
        break;
      }

      case "dotMove": {
        if (isOrigin) return;
        // GM: update scout position
        if (game.user.isGM) _gmHandleMoveScout(payload.tokenId, payload.x, payload.y);
        // All: update spectator dot position
        const moveDot = activeDots.get(payload.tokenId);
        if (moveDot?.wrapper && !moveDot.wrapper.destroyed) {
          moveDot.wrapper.position.set(payload.x, payload.y);
        }
        break;
      }

      case "enterRoom": {
        if (isOrigin) return;
        // GM: teleport token and delete scout
        if (game.user.isGM) _gmHandleEnterRoom(scene, payload);
        // All: destroy spectator dot
        const enterDot = activeDots.get(payload.tokenId);
        if (enterDot) { _destroyDot(enterDot); activeDots.delete(payload.tokenId); }
        break;
      }

      case "cancelTravel": {
        if (isOrigin) return;
        // GM: delete scout
        if (game.user.isGM) _gmHandleCancelTravel(scene, payload);
        // All: destroy spectator dot
        const cancelDot = activeDots.get(payload.tokenId);
        if (cancelDot) { _destroyDot(cancelDot); activeDots.delete(payload.tokenId); }
        break;
      }

      case "rollEncounterTable": {
        if (!game.user.isGM) return;
        const { tableId, tokenName } = payload;
        _rollEncounterTable(tableId, tokenName ?? "Unknown token");
        break;
      }

      case "grantJournalObserver": {
        if (!game.user.isGM) return;
        const { journalId, userId } = payload;
        const entry    = game.journal?.get(journalId);
        if (!entry || !userId) return;
        const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
        const current  = entry.ownership?.[userId] ?? 0;
        if (current < OBSERVER) {
          entry.update({ ownership: { ...entry.ownership, [userId]: OBSERVER } }).catch(console.warn);
        }
        break;
      }

      case "openJournalGm": {
        if (!game.user.isGM) return;
        const entry = game.journal?.get(payload.journalId);
        if (entry) entry.sheet?.render(true);
        break;
      }
    }
  }

  // ── Core travel loop (originating client only) ──────────────────────────────

  // initDir: which direction along the connection to move first (+1 forward, -1 backward).
  // Defaults to +1 if entering at stop 0, -1 otherwise — but callers can override
  // when the player's arrow choice already encodes the direction.
  static async _runTravel(tokenDoc, conn, startStopIdx, originUserId, initDir = null) {
    // Only the originating client runs the travel loop.
    // Any other client that somehow reaches here (e.g. stale updateWall echo) must bail out.
    if (originUserId !== game.user.id) return;

    const scene = canvas.scene;
    const stops = conn.stops;
    const path  = conn.path;
    if (!stops?.length || !path?.length) return;

    if (stops.some(s => s.kind !== "path" && s.pathIdx == null)) {
      console.warn("[DNM] Connection missing direction cache — travel aborted. Load the scene as GM to rebuild.");
      return;
    }

    // Claim the activeDots slot before any await so rapid double-clicks can't
    // pass the activeDots.has() guard in startTravel while we're awaiting the scout.
    activeDots.set(tokenDoc.id, null);

    // GM originating: create scout directly (no socket round-trip needed).
    // Store in _gmScoutMap immediately so any socket echo of our own startTravel
    // broadcast sees the slot occupied and skips duplicate creation.
    let scoutId = null;
    if (game.user.isGM) {
      const si      = startStopIdx;
      const startPi = stops[si]?.pathIdx ?? (si === 0 ? 0 : path.length - 1);
      scoutId = await _createScoutToken(scene, tokenDoc, path[startPi], originUserId);
      if (scoutId) _gmScoutMap.set(tokenDoc.id, scoutId);
    }

    const dot = _spawnDot(tokenDoc.id, conn, originUserId, tokenDoc, scoutId);
    if (!dot) {
      activeDots.delete(tokenDoc.id);
      if (scoutId) _destroyScoutToken(scene, scoutId);
      return;
    }
    activeDots.set(tokenDoc.id, dot);

    // Hide the PIXI selection border (orange box) for the duration of travel.
    // Token stays selected so the camera continues to follow it.
    document.body.classList.add("dnm-traveling");
    _hideTravelBorder(tokenDoc.id);

    // Position dot at starting stop
    const startPi = stops[startStopIdx]?.pathIdx ?? 0;
    dot.wrapper.position.set(path[startPi].x, path[startPi].y);

    let si       = startStopIdx;
    const resolvedDir = initDir ?? (startStopIdx === 0 ? +1 : -1);
    let nextSi   = _nextPauseSi(stops, si, resolvedDir);

    while (activeDots.has(tokenDoc.id)) {
      if (nextSi < 0 || nextSi >= stops.length) break;

      const stop   = stops[nextSi];
      const fromPi = stops[si]?.pathIdx ?? (si === 0 ? 0 : path.length - 1);
      const toPi   = stop.pathIdx ?? (nextSi === stops.length - 1 ? path.length - 1 : 0);

      const subpath = fromPi <= toPi
        ? path.slice(fromPi, toPi + 1)
        : path.slice(toPi, fromPi + 1).reverse();

      if (subpath.length >= 2) {
        dot.state = TRAVEL_STATE.TRAVELING;
        await _animateDot(dot, subpath);
      }
      if (!activeDots.has(tokenDoc.id)) return;

      si = nextSi;
      dot.state = TRAVEL_STATE.WAITING;
      _pulseWaitingDot(dot);

      // Encounter check for junction/path stops — fires before the direction panel.
      // Room node encounters fire after the player commits to entering (in _executeNodeEnterAction).
      if (stop.kind !== "terminal" || !stop.nodeId) {
        await _checkEncounter(stop.encounter, tokenDoc);
      }

      const choices = _buildChoices(scene, conn, stop, si, stops);
      const choice = await _showDirectionPanel(dot, choices) ?? "cancel";

      if (dot.pulseTicket) { PIXI.Ticker.shared.remove(dot.pulseTicket); dot.pulseTicket = null; }
      if (!activeDots.has(tokenDoc.id)) return;

      // ── Handle choice ─────────────────────────────────────────────────────

      if (choice === "locked") {
        _hideDirPanel();
        await new Promise(async resolve => {
          const { DoorBlockedApp } = await import("./doors.js");
          const app = new DoorBlockedApp(conn, tokenDoc, { onBack: resolve });
          const _orig = app.close.bind(app);
          app.close = (...args) => { resolve(); return _orig(...args); };
          app.render(true);
        });
        _restoreDirPanel();
        nextSi = si;
        continue;
      }

      if (choice === "toll") {
        // Show toll dialogue; wait for player to pay or turn back
        let tollPaid = false;
        _hideDirPanel();
        const { TollDoorApp } = await import("./doors.js");
        await new Promise(resolve => {
          const app = new TollDoorApp(conn, tokenDoc, {
            onPay:  () => { tollPaid = true;  resolve(); },
            onBack: () => { tollPaid = false; resolve(); },
          });
          // Also resolve if the window is closed via the X button
          const _origClose = app.close.bind(app);
          app.close = (...args) => { resolve(); return _origClose(...args); };
          app.render(true);
        });
        _restoreDirPanel();
        if (!tollPaid) { nextSi = si; continue; }  // turned back — re-show panel
        // If one-time toll, mark it paid on the connection so future travellers pass free.
        // Only GMs can write scene flags — players request via socket.
        if (conn.tollOneTime) {
          conn.tollPaid = true;  // update local copy so this travel loop sees it immediately
          if (game.user.isGM) {
            await ConnectionManager.updateConnection(conn.id, { tollPaid: true });
          } else {
            _broadcast({ action: "markTollPaid", connectionId: conn.id, originUserId: game.user.id });
          }
        }
        // Paid — fall through to enter logic below
      }

      if (choice === "enter" || choice === "toll") {
        const destNodeId = stop.nodeId ?? null;

        // Lock-on-traverse: lock the designated stop after the token passes through.
        // Players can't write scene flags — they request via socket; GM writes directly.
        if (conn.lockOnTraverse === "first" || conn.lockOnTraverse === "last") {
          const lockIdx = conn.lockOnTraverse === "first" ? 0 : conn.stops.length - 1;
          if (!(conn.stops[lockIdx]?.locked)) {
            if (game.user.isGM) {
              await ConnectionManager.lockConnectionStop(conn.id, lockIdx).catch(console.warn);
            } else {
              _broadcast({ action: "lockStop", connectionId: conn.id, stopIdx: lockIdx, originUserId });
            }
          }
        }

        _broadcast({ action: "enterRoom", tokenId: tokenDoc.id, destNodeId, originUserId });
        _destroyDot(dot);  // GM originator: dot.scoutId is set, scout deleted here
        activeDots.delete(tokenDoc.id);
        if (game.user.isGM) await _teleportTokenToNode(tokenDoc, destNodeId);
        await _executeNodeEnterAction(destNodeId, tokenDoc);
        _reselectToken(tokenDoc.id);
        return;
      }

      if (choice === "cancel") {
        _broadcast({ action: "cancelTravel", tokenId: tokenDoc.id, originUserId });
        _destroyDot(dot);  // GM originator: dot.scoutId is set, scout deleted here
        activeDots.delete(tokenDoc.id);
        _reselectToken(tokenDoc.id);
        return;
      }

      if (choice?.startsWith("goto:")) {
        nextSi = parseInt(choice.slice(5), 10);
        if (isNaN(nextSi) || nextSi < 0 || nextSi >= stops.length) {
          _destroyDot(dot); activeDots.delete(tokenDoc.id); return;
        }
        continue;
      }

      if (choice?.startsWith("branch:")) {
        const parts        = choice.split(":");
        const branchConnId = parts[1];
        const branchStart  = parseInt(parts[2] ?? "0", 10);
        // parts[3] is the explicit direction (+1 or -1), set for middle-stop entries
        const branchDir    = parts[3] !== undefined ? parseInt(parts[3], 10) : null;
        _broadcast({ action: "cancelTravel", tokenId: tokenDoc.id, originUserId });
        _destroyDot(dot);
        activeDots.delete(tokenDoc.id);
        const branchConn = getConnection(scene, branchConnId);
        if (branchConn) {
          _broadcast({ action: "startTravel", tokenId: tokenDoc.id, connectionId: branchConnId, startStopIdx: branchStart, originUserId });
          await this._runTravel(tokenDoc, branchConn, branchStart, originUserId, branchDir);
        }
        return;
      }

      // Unknown choice — clean exit
      _destroyDot(dot); activeDots.delete(tokenDoc.id); return;
    }

    // Fell off end of stops without entering a room
    _destroyDot(dot);
    activeDots.delete(tokenDoc.id);
  }

}

// ── GM Service ────────────────────────────────────────────────────────────────

async function _gmHandleStartTravel(scene, payload, conn) {
  const { tokenId, startStopIdx, originUserId } = payload;
  // Guard: originator already created and registered the scout directly
  if (_gmScoutMap.has(tokenId)) return;
  const tokenDoc = scene.tokens.get(tokenId);
  if (!tokenDoc) return;
  const si      = startStopIdx ?? 0;
  const startPi = conn.stops[si]?.pathIdx ?? (si === 0 ? 0 : conn.path.length - 1);
  const startPos = conn.path[Math.min(startPi, conn.path.length - 1)];
  const scoutId = await _createScoutToken(scene, tokenDoc, startPos, originUserId);
  if (scoutId) _gmScoutMap.set(tokenId, scoutId);
}

function _gmHandleMoveScout(tokenId, x, y) {
  if (_gmScoutPending.get(tokenId)) return;
  const scoutId = _gmScoutMap.get(tokenId);
  if (!scoutId || !canvas.scene) return;
  const scout = canvas.scene.tokens.get(scoutId);
  if (!scout) return;
  const gs = canvas.grid?.size ?? 100;
  const sz = 0.5;
  _gmScoutPending.set(tokenId, true);
  scout.update(
    { x: x - (sz * gs) / 2, y: y - (sz * gs) / 2 },
    { animate: false, teleport: true }
  ).then(() => _gmScoutPending.delete(tokenId))
   .catch(() => _gmScoutPending.delete(tokenId));
}

async function _gmHandleEnterRoom(scene, payload) {
  const { tokenId, destNodeId } = payload;
  const tokenDoc = scene.tokens.get(tokenId);
  await _teleportTokenToNode(tokenDoc, destNodeId);
  const scoutId = _gmScoutMap.get(tokenId);
  if (scoutId) {
    _gmScoutMap.delete(tokenId);
    _gmScoutPending.delete(tokenId);
    await _destroyScoutToken(scene, scoutId);
  }
  const dot = activeDots.get(tokenId);
  if (dot) { _destroyDot(dot); activeDots.delete(tokenId); }
}

async function _gmHandleCancelTravel(scene, payload) {
  const { tokenId } = payload;
  const scoutId = _gmScoutMap.get(tokenId);
  if (scoutId) {
    _gmScoutMap.delete(tokenId);
    _gmScoutPending.delete(tokenId);
    await _destroyScoutToken(scene, scoutId);
  }
  const dot = activeDots.get(tokenId);
  if (dot) { _destroyDot(dot); activeDots.delete(tokenId); }
}

async function _teleportTokenToNode(tokenDoc, destNodeId) {
  if (!tokenDoc || !destNodeId) return;
  const destNode = getNode(canvas.scene, destNodeId);
  if (!destNode) return;
  const gs = canvas.grid?.size ?? 100;
  const tx = destNode.x - (tokenDoc.width  * gs) / 2;
  const ty = destNode.y - (tokenDoc.height * gs) / 2;
  await tokenDoc.update({ x: tx, y: ty }, { animate: false, teleport: true });
}

/**
 * Run all onEnter automations for a node: encounter check, image popout,
 * scene redirect, journal open. Runs on the originating client only.
 */
// ── Encounter check ───────────────────────────────────────────────────────────

async function _checkEncounter(encounter, tokenDoc) {
  if (!encounter?.tableId || !(encounter.chance > 0)) return;
  const roll = Math.random() * 100;
  if (roll > encounter.chance) return;

  const tokenName = (tokenDoc?.document ?? tokenDoc)?.name ?? "Unknown token";
  if (game.user?.isGM) {
    await _rollEncounterTable(encounter.tableId, tokenName);
  } else {
    game.socket?.emit(SOCKET_CHANNEL, {
      action:    "rollEncounterTable",
      tableId:   encounter.tableId,
      tokenName,
    });
  }
}

async function _rollEncounterTable(tableId, tokenName) {
  const table = game.tables?.get(tableId);
  if (!table) {
    console.warn("[DNM] Encounter table not found:", tableId);
    return;
  }
  const blindRoll = CONST.DICE_ROLL_MODES?.BLIND_ROLL ?? "blindroll";
  await table.draw({ rollMode: blindRoll });
  const gmIds = game.users?.filter(u => u.isGM).map(u => u.id) ?? [];
  ChatMessage.create({
    content: `<p><strong>[DNM] Encounter triggered</strong> — <em>${tokenName}</em> passed through a hazard zone.</p>`,
    whisper: gmIds,
  });
}

async function _executeNodeEnterAction(destNodeId, tokenDoc = null) {
  if (!destNodeId || !canvas.scene) return;
  const destNode = getNode(canvas.scene, destNodeId);
  if (!destNode) return;

  // Encounter check — fires on entry, after token teleports in
  await _checkEncounter(destNode.encounter, tokenDoc);

  // ── Discovery tracking (fast travel transit bar) ──────────────────────────
  {
    const { markLocalDiscovered } = await import("./transitBar.js");
    const { markDiscovered }      = await import("./flags.js");

    if (game.user?.isGM) {
      // When the GM travels with a player-owned token, credit that player's
      // discovery — not the GM, who already sees all hubs regardless.
      const td      = tokenDoc?.document ?? tokenDoc;
      const actor   = td?.actorId ? game.actors?.get(td.actorId) : null;
      const playerOwnerIds = actor
        ? (game.users?.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.id) ?? [])
        : [];

      if (playerOwnerIds.length) {
        // Mark locally for each owner (their transit bar updates on their next refresh)
        for (const uid of playerOwnerIds) {
          markDiscovered(canvas.scene, uid, destNodeId).catch(console.warn);
        }
      }
      // Always mark for GM too so their own transit bar stays consistent
      markLocalDiscovered(destNodeId);
      markDiscovered(canvas.scene, game.user.id, destNodeId).catch(console.warn);
    } else {
      markLocalDiscovered(destNodeId);
      game.socket?.emit(SOCKET_CHANNEL, {
        action: "markDiscovered",
        nodeId:  destNodeId,
        userId:  game.user.id,
      });
    }
  }


  const action = destNode.onEnter;
  if (!action) return;

  // Show image
  if (action.showImage && action.imageUrl) {
    new ImagePopout(action.imageUrl, { title: destNode.label ?? "Node", shareable: true }).render(true);
  }

  // Send to scene
  if (action.sendToScene && action.sceneId) {
    const scene = await fromUuid(action.sceneId).catch(() => null);
    if (scene) await scene.view();
    else ui.notifications?.warn(`[DNM] Scene UUID "${action.sceneId}" not found.`);
  }

  // Open journal — respects journalTarget: "both" | "gm" | "player"
  if (action.openJournal && action.journalId) {
    const entry  = game.journal?.get(action.journalId);
    if (!entry) { ui.notifications?.warn(`[DNM] Journal entry "${action.journalId}" not found.`); return; }

    const target = action.journalTarget ?? "both";
    const isGM   = game.user.isGM;

    // Should THIS client open the journal locally?
    const openLocally = (target === "both") || (target === "gm" && isGM) || (target === "player" && !isGM);

    // Should the GM client also be notified to open it (only needed when a player is the origin)?
    const notifyGm = !isGM && (target === "both" || target === "gm");

    if (openLocally) {
      // Grant the originating user at least OBSERVER so they can see it
      if (!isGM) {
        const userId   = game.user.id;
        const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
        const current  = entry.ownership?.[userId] ?? entry.ownership?.default ?? 0;
        if (current < OBSERVER) {
          game.socket?.emit(SOCKET_CHANNEL, {
            action:    "grantJournalObserver",
            journalId: action.journalId,
            userId,
          });
          await new Promise(r => setTimeout(r, 400));
        }
      }
      entry.sheet?.render(true);
    }

    if (notifyGm) {
      game.socket?.emit(SOCKET_CHANNEL, {
        action:    "openJournalGm",
        journalId: action.journalId,
      });
    }
  }

  // Notify other modules that a token has entered this node
  Hooks.callAll('dnmNodeEnter', destNode, tokenDoc);
}

// ── Scout token ───────────────────────────────────────────────────────────────

async function _createScoutToken(scene, tokenDoc, startPos, originUserId) {
  if (!game.user?.isGM || !scene) return null;
  const gs    = canvas.grid?.size ?? 100;
  const sz    = 0.5;
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = { default: 0 };
  if (originUserId) ownership[originUserId] = OWNER;
  const actorId = tokenDoc.actorId || null;

  try {
    const [scout] = await scene.createEmbeddedDocuments("Token", [{
      name:        tokenDoc.name ? `${tokenDoc.name} [travel]` : "•",
      img:         "icons/svg/circle.svg",
      actorId,
      actorLink:   false,
      x:           startPos.x - (sz * gs) / 2,
      y:           startPos.y - (sz * gs) / 2,
      width:       sz,
      height:      sz,
      alpha:       0,
      hidden:      false,
      sight: { enabled: true, range: 1, angle: 360, visionMode: "basic" },
      light: {
        dim: 0.5, bright: 0.5, angle: 360, color: null, alpha: 0.5,
        animation: { type: null, speed: 5, intensity: 5 },
        darkness:  { min: 0, max: 1 },
      },
      displayName: CONST.TOKEN_DISPLAY_MODES?.NONE ?? 0,
      displayBars: CONST.TOKEN_DISPLAY_MODES?.NONE ?? 0,
      ownership,
      flags: { [MODULE_ID]: { scout: true, forTokenId: tokenDoc.id } },
    }]);
    return scout?.id ?? null;
  } catch (e) {
    console.warn("[DNM] Scout token creation failed:", e);
    return null;
  }
}

async function _destroyScoutToken(scene, scoutId) {
  if (!game.user?.isGM || !scoutId || !scene) return;
  try {
    if (scene.tokens.has(scoutId)) {
      await scene.deleteEmbeddedDocuments("Token", [scoutId]);
    }
  } catch (e) {
    console.warn("[DNM] Scout token deletion failed:", e);
  }
}

// ── Stop helpers ──────────────────────────────────────────────────────────────

function _nextPauseSi(stops, fromSi, dir) {
  let si = fromSi + dir;
  while (si >= 0 && si < stops.length && stops[si]?.kind === "path") si += dir;
  if (si < 0 || si >= stops.length) return -1;
  return si;
}

/**
 * Build direction choices for the panel at the current stop.
 *
 * Since every junction arm is forced to 40px cardinal by the router, direction
 * is read directly from path[pi±1] — one step, zero guessing.
 *
 * Current connection's own nav is added last so it overwrites any branch at
 * the same direction (staying on the main corridor takes priority).
 */
function _buildChoices(scene, conn, stop, si, stops) {
  const isGM = game.user?.isGM ?? false;

  // Node terminal: enter (or locked) + optional corridor nav (turn-around).
  if (stop.kind === "terminal" && stop.nodeId) {
    const isLocked = !isGM && (stop.locked ?? false);
    const isToll   = conn.type === "toll" && (conn.tollCost ?? 0) > 0
                    && (stop.toll ?? false)
                    && !(conn.tollOneTime && conn.tollPaid);
    const centerChoice = isLocked
      ? { direction: "center", action: "locked", icon: "fa-lock" }
      : isToll
        ? { direction: "center", action: "toll",   icon: "fa-coins" }
        : { direction: "center", action: "enter",  icon: "fa-door-open" };
    const choices = [centerChoice];
    const pi     = stop.pathIdx ?? (si === 0 ? 0 : conn.path.length - 1);
    const fwdSi  = _nextPauseSi(stops, si, +1);
    const backSi = _nextPauseSi(stops, si, -1);
    // On a one-way connection players can only go forward (stop[0]→end).
    // Suppress the turn-around arrow at the first stop; suppress forward at last.
    const blockBack = !isGM && conn.oneWay && si === 0;
    const blockFwd  = !isGM && conn.oneWay && si === stops.length - 1;
    if (fwdSi  >= 0 && !blockFwd)  { const d = _armCardinal(conn.path, pi, true);  if (d) choices.push({ direction: d, action: `goto:${fwdSi}`  }); }
    if (backSi >= 0 && !blockBack) { const d = _armCardinal(conn.path, pi, false); if (d) choices.push({ direction: d, action: `goto:${backSi}` }); }
    return choices;
  }

  // Junction / floating terminal: read the arm direction off each connected path.
  const dirMap = new Map();
  for (const other of Object.values(listConnections(scene))) {
    if (other.id === conn.id) continue;
    // Hidden/secret connections are invisible to players at junctions
    if (!isGM && (other.hidden || other.type === "secret")) continue;
    const os = other.stops ?? [];
    for (let osi = 0; osi < os.length; osi++) {
      const s = os[osi];
      if (s.kind === "path") continue;
      if (Math.hypot(s.x - stop.x, s.y - stop.y) > STOP_MATCH_DIST) continue;
      if (!other.path?.length) continue;

      if (osi === 0) {
        // Entering from the first stop — always allowed
        const d = _armCardinal(other.path, 0, true);
        if (d) dirMap.set(d, { direction: d, action: `branch:${other.id}:0` });
      } else if (osi === os.length - 1) {
        // Entering from the last stop — blocked on one-way connections for players
        if (!isGM && other.oneWay) continue;
        const d = _armCardinal(other.path, other.path.length - 1, false);
        if (d) dirMap.set(d, { direction: d, action: `branch:${other.id}:${osi}` });
      } else {
        const spi    = s.pathIdx ?? 0;
        const fwdSi  = _nextPauseSi(os, osi, +1);
        const backSi = _nextPauseSi(os, osi, -1);
        if (fwdSi  >= 0) { const d = _armCardinal(other.path, spi, true);  if (d) dirMap.set(d, { direction: d, action: `branch:${other.id}:${osi}:1`  }); }
        // Backward from a mid-junction into a one-way is also blocked
        if (backSi >= 0 && !((!isGM) && other.oneWay)) { const d = _armCardinal(other.path, spi, false); if (d) dirMap.set(d, { direction: d, action: `branch:${other.id}:${osi}:-1` }); }
      }
    }
  }

  // ── Current connection nav (overwrites branch at same direction) ────────────
  // Hidden connections are not shown to players — they can only travel them if
  // the GM explicitly starts travel on that connection.
  if (!isGM && (conn.hidden || conn.type === "secret")) return [...dirMap.values()];
  if (stop.kind !== "terminal") {
    const pi     = stop.pathIdx ?? 0;
    const fwdSi  = _nextPauseSi(stops, si, +1);
    const backSi = _nextPauseSi(stops, si, -1);
    if (fwdSi  >= 0) { const d = _armCardinal(conn.path, pi, true);  if (d) dirMap.set(d, { direction: d, action: `goto:${fwdSi}`  }); }
    if (backSi >= 0) { const d = _armCardinal(conn.path, pi, false); if (d) dirMap.set(d, { direction: d, action: `goto:${backSi}` }); }
  }

  return [...dirMap.values()];
}

/**
 * Read the cardinal direction of the 40px junction arm.
 * path[pi] is the junction point; forward=true reads path[pi+1], false reads path[pi-1].
 * Works because the router guarantees a cardinal arm before any turns.
 */
function _armCardinal(path, pi, forward) {
  const ni = forward ? pi + 1 : pi - 1;
  if (ni < 0 || ni >= path.length) return null;
  const dx = path[ni].x - path[pi].x;
  const dy = path[ni].y - path[pi].y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "east" : "west") : (dy > 0 ? "south" : "north");
}

// ── Dot lifecycle ─────────────────────────────────────────────────────────────

function _spawnDot(tokenId, conn, originUserId, tokenDoc = null, scoutId = null) {
  const container = getDotContainer();
  if (!container || container.destroyed) return null;

  const wrapper = new PIXI.Container();
  wrapper.position.set(0, 0);

  const glow = new PIXI.Graphics();
  glow.beginFill(0x00ffff, 0.18);
  glow.drawCircle(0, 0, DOT_GLOW_RADIUS);
  glow.endFill();
  wrapper.addChild(glow);

  const core = new PIXI.Graphics();
  core.beginFill(0x00ffff, 1);
  core.drawCircle(0, 0, DOT_RADIUS);
  core.endFill();
  wrapper.addChild(core);

  const BlurFilter = PIXI?.BlurFilter ?? PIXI?.filters?.BlurFilter ?? null;
  if (BlurFilter) glow.filters = [new BlurFilter(6)];

  container.addChild(wrapper);

  return {
    tokenId,
    tokenDoc,
    scoutId,
    connectionId:       conn.id,
    state:              TRAVEL_STATE.TRAVELING,
    originUserId,
    scoutUpdatePending: false,
    _destroyed:         false,
    wrapper,
    core,
    glow,
    pulseTicket: null,
    ticker:      null,
  };
}

function _destroyDot(dot) {
  if (!dot || dot._destroyed) return;
  dot._destroyed = true;
  if (dot.ticker)      PIXI.Ticker.shared.remove(dot.ticker);
  if (dot.pulseTicket) PIXI.Ticker.shared.remove(dot.pulseTicket);
  if (dot.wrapper && !dot.wrapper.destroyed) dot.wrapper.destroy({ children: true });
  // GM originator: scoutId is set on the dot — delete the scout here and clear the map slot.
  // Player originator: scoutId is null — GM deletes scout via _gmScoutMap on receipt of enterRoom/cancelTravel.
  if (dot.scoutId && canvas.scene) {
    _gmScoutMap.delete(dot.tokenId);
    _gmScoutPending.delete(dot.tokenId);
    _destroyScoutToken(canvas.scene, dot.scoutId);
  }
}

// ── Animation ─────────────────────────────────────────────────────────────────

function _animateDot(dot, subpath) {
  return new Promise(resolve => {
    if (!dot?.wrapper || dot.wrapper.destroyed || subpath.length < 2) {
      resolve(); return;
    }

    const total     = pathLength(subpath);
    if (total < 0.5) { resolve(); return; }

    const isOwner    = dot.originUserId === game.user.id;
    const pxPerTick  = TRAVEL_SPEED / 60;
    let distTraveled = 0;
    let lastBroadcast = -SCOUT_UPDATE_INTERVAL;

    dot.wrapper.position.set(subpath[0].x, subpath[0].y);

    const tick = (ticker) => {
      // Freeze dot in place while game is paused (GMs are exempt)
      if (game.paused && !game.user?.isGM) return;
      // PIXI v7 passes a number; PIXI v8 passes the Ticker object — handle both
      const delta = typeof ticker === "number" ? ticker : (ticker?.deltaTime ?? 1);
      distTraveled += pxPerTick * delta;
      const done = distTraveled >= total;
      const pos  = done ? subpath[subpath.length - 1] : pointAtDistance(subpath, distTraveled);

      dot.wrapper.position.set(pos.x, pos.y);

      if (isOwner) {
        _panCamera(pos.x, pos.y);
        if (distTraveled - lastBroadcast >= SCOUT_UPDATE_INTERVAL || done) {
          lastBroadcast = distTraveled;
          // Broadcast position for spectators and (if player) for GM scout movement
          _broadcast({ action: "dotMove", tokenId: dot.tokenId, x: pos.x, y: pos.y, originUserId: dot.originUserId });
          // GM originator: can't receive own broadcast, so move scout directly
          if (game.user.isGM && dot.scoutId) _moveScoutDirect(dot, pos);
        }
      }

      if (done) {
        PIXI.Ticker.shared.remove(tick);
        if (dot.ticker === tick) dot.ticker = null;
        resolve();
      }
    };

    dot.ticker = tick;
    PIXI.Ticker.shared.add(tick);
  });
}

function _moveScoutDirect(dot, pos) {
  if (!dot.scoutId || dot.scoutUpdatePending || !canvas.scene) return;
  const scout = canvas.scene.tokens.get(dot.scoutId);
  if (!scout) return;
  const gs = canvas.grid?.size ?? 100;
  const sz = 0.5;
  dot.scoutUpdatePending = true;
  scout.update(
    { x: pos.x - (sz * gs) / 2, y: pos.y - (sz * gs) / 2 },
    { animate: false, teleport: true }
  ).then(() => { dot.scoutUpdatePending = false; })
   .catch(() => { dot.scoutUpdatePending = false; });
}

function _pulseWaitingDot(dot) {
  if (!dot?.glow) return;
  let t = 0;
  const tick = (ticker) => {
    const delta = typeof ticker === "number" ? ticker : (ticker?.deltaTime ?? 1);
    t += delta * 0.06;
    dot.glow.alpha = 0.12 + Math.sin(t) * 0.12;
    dot.core.alpha = 0.7  + Math.sin(t) * 0.3;
  };
  dot.pulseTicket = tick;
  PIXI.Ticker.shared.add(tick);
}

// ── Direction panel ───────────────────────────────────────────────────────────

const _ARROW_ICONS = { north:"fa-arrow-up", south:"fa-arrow-down", east:"fa-arrow-right", west:"fa-arrow-left" };
const _GRID_POS    = { north:[1,2], west:[2,1], center:[2,2], east:[2,3], south:[3,2] };

/** Hide the direction panel while a dialog is on top, restore it after. */
function _hideDirPanel()    { if (_activePanel) _activePanel.style.visibility = "hidden"; }
function _restoreDirPanel() { if (_activePanel) _activePanel.style.visibility = ""; }

function _showDirectionPanel(dot, choices) {
  return new Promise(resolve => {
    const el = canvas.app?.view ?? canvas.app?.canvas;
    if (!el || !canvas.stage?.worldTransform) { resolve("cancel"); return; }

    const t      = canvas.stage.worldTransform;
    const rect   = el.getBoundingClientRect();
    const scaleX = rect.width  / (el.width  || 1);
    const scaleY = rect.height / (el.height || 1);
    const sx     = (t.a * dot.wrapper.x + t.tx) * scaleX + rect.left;
    const sy     = (t.d * dot.wrapper.y + t.ty) * scaleY + rect.top;

    const panel = document.createElement("div");
    panel.className = "dnm-dir-panel";
    _activePanel = panel;
    // Panel size: 3×44px buttons + 2×3px gaps + 2×6px padding ≈ 156px wide
    const PANEL_W  = 156;
    const PANEL_H  = 156;
    const GAP      = 20;  // px gap between dot and panel edge
    const viewW    = window.innerWidth;
    // Prefer right side; flip left if it would overflow
    const fitsRight = sx + GAP + PANEL_W < viewW;
    const px = fitsRight ? sx + GAP : sx - GAP - PANEL_W;
    const py = sy - PANEL_H / 2;
    panel.style.left = `${px}px`;
    panel.style.top  = `${py}px`;

    // Deduplicate by direction — last entry wins so main-nav overrides branches
    const seen = new Map();
    for (const c of choices) seen.set(c.direction, c);

    let html = '<div class="dnm-dir-grid">';
    for (const c of seen.values()) {
      const [row, col] = _GRID_POS[c.direction] ?? [2, 2];
      const icon = c.icon ?? _ARROW_ICONS[c.direction] ?? "fa-circle";
      const cls  = c.direction === "center" ? "dnm-dir-btn dnm-dir-enter" : "dnm-dir-btn";
      html += `<button class="${cls}" data-action="${c.action}"
                 style="grid-row:${row};grid-column:${col}">
                 <i class="fa-solid ${icon}"></i>
               </button>`;
    }
    html += "</div>";
    panel.innerHTML = html;
    document.body.appendChild(panel);

    const cleanup = (action) => {
      _activePanel = null;
      panel.remove();
      document.removeEventListener("keydown", onKey);
      resolve(action);
    };

    panel.addEventListener("pointerdown", e => {
      e.stopPropagation();
      if (game.paused && !game.user?.isGM) {
        ui.notifications?.warn("[DNM] Travel is not possible while the game is paused.");
        return;
      }
      const btn = e.target.closest("[data-action]");
      if (btn) cleanup(btn.dataset.action);
    });

    const onKey = e => { if (e.key === "Escape") cleanup("cancel"); };
    document.addEventListener("keydown", onKey);
  });
}

function _removeAllPanels() {
  document.querySelectorAll(".dnm-dir-panel").forEach(el => el.remove());
  _activePanel = null;
}


// ── Token selection ───────────────────────────────────────────────────────────

// Hide the PIXI selection border (orange highlight) on the controlled token.
// Foundry v13 renders this via token.border (a PIXI Graphics child), not DOM.
function _hideTravelBorder(tokenId) {
  const ct = canvas.tokens?.get(tokenId);
  if (!ct) return;
  const border = ct.border ?? ct.children?.find(c => c.name === "border" || c.name === "selection");
  if (border) border.visible = false;
}

function _restoreTravelBorder(tokenId) {
  const ct = canvas.tokens?.get(tokenId);
  if (!ct) return;
  const border = ct.border ?? ct.children?.find(c => c.name === "border" || c.name === "selection");
  if (border) border.visible = true;
}

function _reselectToken(tokenId) {
  document.body.classList.remove("dnm-traveling");
  if (!tokenId) return;
  _restoreTravelBorder(tokenId);
  const ct = canvas.tokens?.get(tokenId);
  if (ct && ct.isOwner) ct.control({ releaseOthers: true });
}

// ── Camera + socket ───────────────────────────────────────────────────────────

// Pan at most 10 times/second — calling animatePan every PIXI tick (60/s) causes
// the camera animation to restart before it finishes, creating visible jitter.
let _lastPanAt = 0;
function _panCamera(x, y) {
  const now = performance.now();
  if (now - _lastPanAt < 60) return;
  _lastPanAt = now;
  canvas.animatePan?.({ x, y, duration: 200 });
}

function _broadcast(payload) {
  game.socket?.emit(SOCKET_CHANNEL, payload);
}
