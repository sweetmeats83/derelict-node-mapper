you/**
 * layer.js — manages three PIXI containers:
 *
 *  mapContainer     → canvas.primary (PrimaryCanvasGroup)
 *                     FoW-masked automatically. Holds node shapes,
 *                     connection lines, door icons (visual only).
 *
 *  handleContainer  → canvas.interface (InterfaceCanvasGroup)
 *                     Above FoW, always interactive. Holds invisible
 *                     drag handles for each node (GM only) and door
 *                     icon click targets (players).
 *
 *  dotContainer     → canvas.interface
 *                     Holds the animated travel dot — intentionally
 *                     above FoW so players see it move into the dark.
 */

let mapContainer    = null;
let handleContainer = null;
let dotContainer    = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function getMapContainer()    { return mapContainer;    }
export function getHandleContainer() { return handleContainer; }
export function getDotContainer()    { return dotContainer;    }

export function attachLayers() {
  // ── Visuals in canvas.primary (FoW-masked) ────────────────────────────────
  if (!mapContainer || mapContainer.destroyed) {
    mapContainer = new PIXI.Container();
    mapContainer.name             = "derelict-node-map";
    mapContainer.eventMode        = "passive";  // visual only — interaction handled on handleContainer
    mapContainer.sortableChildren = true;
  }
  const primary = canvas?.primary;
  if (primary && !primary.children.includes(mapContainer)) {
    primary.addChild(mapContainer);
  }

  // ── Interaction handles + dots in canvas.interface (above FoW) ───────────
  const iface = canvas?.interface;

  if (!handleContainer || handleContainer.destroyed) {
    handleContainer = new PIXI.Container();
    handleContainer.name           = "derelict-node-handles";
    handleContainer.sortableChildren = true;
    handleContainer.eventMode      = "static";  // must be static so hit circles receive pointer events
  }
  if (iface && !iface.children.includes(handleContainer)) {
    iface.addChild(handleContainer);
  }

  if (!dotContainer || dotContainer.destroyed) {
    dotContainer = new PIXI.Container();
    dotContainer.name      = "derelict-travel-dots";
    dotContainer.eventMode = "none";
    dotContainer.sortableChildren = true;
  }
  if (iface && !iface.children.includes(dotContainer)) {
    iface.addChild(dotContainer);
  }
}

export function detachLayers() {
  for (const c of [mapContainer, handleContainer, dotContainer]) {
    if (c && !c.destroyed) {
      c.removeChildren().forEach(ch => ch.destroy({ children: true }));
      c.parent?.removeChild(c);
    }
  }
  mapContainer    = null;
  handleContainer = null;
  dotContainer    = null;
}

export function clearMap() {
  if (mapContainer && !mapContainer.destroyed) {
    mapContainer.removeChildren().forEach(c => c.destroy({ children: true }));
  }
  if (handleContainer && !handleContainer.destroyed) {
    handleContainer.removeChildren().forEach(c => c.destroy({ children: true }));
  }
}
