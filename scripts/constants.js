export const MODULE_ID = "derelict-node-mapper";

// ── Flag keys ────────────────────────────────────────────────────────────────
export const FLAG_STATE_NODES       = "nodes";
export const FLAG_STATE_CONNECTIONS = "connections";
export const FLAG_NODE_ID           = "nodeId";
export const FLAG_DISCOVERED        = "discovered"; // {userId: {nodeId: true}}

// ── Socket ───────────────────────────────────────────────────────────────────
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

// ── Tool names (registered in Foundry scene controls) ────────────────────────
export const TOOL_CREATE_NODE    = "dnm-create-node";
export const TOOL_CONNECT_NODES  = "dnm-connect-nodes";

// ── Node shapes ──────────────────────────────────────────────────────────────
export const NODE_SHAPES = [
  { id: "circle",   label: "Circle"            },
  { id: "square",   label: "Square"            },
  { id: "rounded",  label: "Rounded Rectangle" },
  { id: "diamond",  label: "Diamond"           },
  { id: "hex",      label: "Hexagon"           },
];

// ── Connection / door types ───────────────────────────────────────────────────
// doorWallType: the Foundry WALL_DOOR_TYPES value to use for the Foundry wall
export const CONNECTION_TYPES = [
  { id: "corridor",  label: "Open Corridor",     icon: null,         doorWallType: 0  }, // WALL_DOOR_TYPES.NONE
  { id: "door",      label: "Standard Door",      icon: "door",       doorWallType: 1  }, // WALL_DOOR_TYPES.DOOR
  { id: "locked",    label: "Locked Door",         icon: "door",       doorWallType: 1  }, // starts locked
  { id: "sealed",    label: "Sealed Bulkhead",     icon: "sealed",     doorWallType: 1  },
  { id: "airlock",   label: "Airlock",             icon: "airlock",    doorWallType: 1  },
  { id: "hatch",     label: "Maintenance Hatch",   icon: "hatch",      doorWallType: 1  },
  { id: "junction",  label: "Systems Junction",    icon: "junction",   doorWallType: 0  },
  { id: "secret",    label: "Hidden Door",         icon: "secret",     doorWallType: 2  }, // WALL_DOOR_TYPES.SECRET
  { id: "stairs",    label: "Stairs",              icon: "stairs",     doorWallType: 1  },
  { id: "elevator",  label: "Elevator",            icon: "elevator",   doorWallType: 1  },
  { id: "toll",      label: "Toll Door",           icon: "toll",       doorWallType: 1  },
];

// Which connection types block travel and require a dialogue
export const BLOCKING_TYPES = new Set(["sealed", "secret"]);

// Which connection types are hidden from players until revealed by GM
export const HIDDEN_TYPES = new Set(["secret"]);

// ── Line styles ───────────────────────────────────────────────────────────────
export const LINE_STYLES = [
  { id: "solid",  label: "Solid"  },
  { id: "dashed", label: "Dashed" },
  { id: "dotted", label: "Dotted" },
];

// ── Travel states (used by travel.js) ────────────────────────────────────────
export const TRAVEL_STATE = {
  IDLE:       "idle",       // dot not active
  TRAVELING:  "traveling",  // dot moving along a path
  WAITING:    "waiting",    // dot stopped at a junction or outside a door
  BLOCKED:    "blocked",    // dot stopped at a locked/sealed door
};

// ── Sizes & defaults ─────────────────────────────────────────────────────────
export const MIN_NODE_SIZE = 60;
export const DEFAULT_NODE_SIZE = 200;

export const DEFAULT_NODE = Object.freeze({
  shape:        "circle",
  width:        DEFAULT_NODE_SIZE,
  height:       DEFAULT_NODE_SIZE,
  fillColor:    "#0a1c27",
  borderColor:  "#00ffff",
  borderWidth:  5,
  label:           "Node",
  labelColor:      "#ffffff",
  labelSize:       22,
  fontFamily:      "Orbitron, sans-serif",
  description:     "",
  descriptionSize: 14,
  descriptionColor:"#cccccc",
  createWalls:    true,
  fastTravelHub:  false,
  onEnter:      { showImage: false, imageUrl: "", sendToScene: false, sceneId: "", openJournal: false, journalId: "" },
  encounter:    { chance: 0, tableId: "" },
});

export const DEFAULT_CONNECTION = Object.freeze({
  type:         "door",
  lineColor:    "#00ffff",
  lineWidth:    8,
  lineStyle:    "solid",
  accentColor:  "#ff9ff3",
  travelable:   true,
  oneWay:       false,
  hidden:       false,
  lockMessage:  "The way is locked. You need authorisation to proceed.",
  tollCost:     0,
  tollMessage:  "A toll is required to pass.",
  tollOneTime:  false,
  tollPaid:     false,
  stops:        [],
});

// ── Visual constants ──────────────────────────────────────────────────────────
export const DOOR_ICON_RADIUS   = 14;  // px, size of door icon circle on node edge
export const DOT_RADIUS         = 12;  // px, travel dot radius
export const DOT_GLOW_RADIUS    = 28;  // px, outer glow radius
export const TRAVEL_SPEED       = 300; // px per second

// ── Icon SVG paths (inline, drawn with PIXI.Graphics) ────────────────────────
// Icons are drawn procedurally in renderer.js; this maps type id → draw function key
export const ICON_MAP = {
  door:     "door",
  sealed:   "sealed",
  airlock:  "airlock",
  hatch:    "hatch",
  junction: "junction",
  secret:   "secret",
  stairs:   "stairs",
  elevator: "elevator",
  toll:     "toll",
};
