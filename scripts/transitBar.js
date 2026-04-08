/**
 * transitBar.js — Chicago L-style fast travel card.
 *
 * A floating glass card that rises above the macro bar.  Clicking the train
 * toggle button shows/hides it; it auto-collapses 3 s after the mouse leaves.
 *
 * Transit line: thick neon rect connecting all hub stations.  Station circles
 * inherit the node's fill / border / label colours.  Labels angle 45° upward.
 * Spacing is adaptive — stations compress when many hubs are present so the
 * whole line always fits on screen without scrolling.
 *
 * Fast travel: fade-to-black → teleport token → pan → fade-in.
 */

import { MODULE_ID, FLAG_DISCOVERED } from "./constants.js";
import { listNodes } from "./flags.js";

// ── Fast-travel enabled setting ────────────────────────────────────────────────

export function isFastTravelEnabled() {
  return game.settings.get(MODULE_ID, "fastTravelEnabled") !== false;
}

async function _setFastTravelEnabled(on) {
  if (!game.user?.isGM) return;
  await game.settings.set(MODULE_ID, "fastTravelEnabled", on);
  _updateLockButton();
  _updateCardState();
}

// ── Local discovery cache ──────────────────────────────────────────────────────
const _localDiscovered = new Set();

export function markLocalDiscovered(nodeId) {
  if (!nodeId || _localDiscovered.has(nodeId)) return;
  _localDiscovered.add(nodeId);
  _drawLine();
}

// ── Layout constants ───────────────────────────────────────────────────────────
const CIRCLE_R      = 14;   // station circle radius px
const LINE_H        = 8;    // transit band height px
const LINE_Y        = 115;  // y-centre of transit band inside SVG
const SVG_H         = 155;  // total SVG height (label space + band + bottom pad)
const LEFT_PAD      = 40;   // px left of first station
const RIGHT_PAD     = 110;  // px right of last station — labels angle 45° so they
                            //   extend well past the circle's right edge
const MAX_SPACING   = 140;  // px max between stations
const MIN_SPACING   = 58;   // px min between stations (compresses for many stops)
const COLLAPSE_MS   = 3000; // auto-collapse delay

// ── DOM refs ───────────────────────────────────────────────────────────────────
let _toggle     = null;
let _card       = null;
let _svg        = null;
let _collapseId = null;
let _bar        = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────────

export function initTransitBar() {
  if (_bar) destroyTransitBar();

  // Seed from persisted discovery flags
  _localDiscovered.clear();
  const userId = game.user?.id;
  if (userId && canvas.scene) {
    const stored = canvas.scene.getFlag(MODULE_ID, FLAG_DISCOVERED)?.[userId] ?? {};
    for (const nodeId of Object.keys(stored)) _localDiscovered.add(nodeId);
  }

  _bar = document.createElement("div");
  _bar.id = "dnm-transit-bar";

  // ── Toggle button ────────────────────────────────────────────────────────────
  _toggle = document.createElement("button");
  _toggle.id = "dnm-transit-toggle";
  _toggle.title = "Transit Map — Fast Travel";
  _toggle.innerHTML = '<i class="fa-solid fa-train-subway"></i>';
  _toggle.addEventListener("click", () => {
    _card.classList.contains("dnm-visible") ? _collapse() : _expand();
  });

  // ── Glass card ───────────────────────────────────────────────────────────────
  _card = document.createElement("div");
  _card.id = "dnm-transit-card";
  _card.innerHTML = `
    <div class="dnm-transit-card-header">
      <i class="fa-solid fa-train-subway"></i>
      <span class="dnm-transit-title">TRANSIT MAP</span>
      <span class="dnm-transit-hint">Select a token · Click a station to fast travel</span>
      <span class="dnm-transit-restricted" style="display:none">— RESTRICTED</span>
      ${game.user?.isGM ? '<button id="dnm-transit-lock" title="Toggle fast travel on/off"></button>' : ""}
    </div>
    <div class="dnm-transit-track-wrap">
      <svg id="dnm-transit-svg" xmlns="http://www.w3.org/2000/svg"></svg>
    </div>
  `;

  _svg = _card.querySelector("#dnm-transit-svg");

  // GM lock button
  const lockBtn = _card.querySelector("#dnm-transit-lock");
  if (lockBtn) {
    _updateLockButton();
    lockBtn.addEventListener("click", e => {
      e.stopPropagation();
      _setFastTravelEnabled(!isFastTravelEnabled());
    });
  }
  _updateCardState();

  // Auto-collapse when mouse leaves the card
  _card.addEventListener("mouseleave", () => {
    _collapseId = setTimeout(_collapse, COLLAPSE_MS);
  });
  _card.addEventListener("mouseenter", () => {
    if (_collapseId) { clearTimeout(_collapseId); _collapseId = null; }
  });

  _bar.appendChild(_toggle);
  _bar.appendChild(_card);
  document.body.appendChild(_bar);

  _drawLine();
}

export function destroyTransitBar() {
  if (_collapseId) { clearTimeout(_collapseId); _collapseId = null; }
  _bar?.remove();
  _bar = null; _toggle = null; _card = null; _svg = null;
}

export function refreshTransitBar() {
  if (!_bar) return;
  const userId = game.user?.id;
  if (userId && canvas.scene) {
    const stored = canvas.scene.getFlag(MODULE_ID, FLAG_DISCOVERED)?.[userId] ?? {};
    for (const nodeId of Object.keys(stored)) _localDiscovered.add(nodeId);
  }
  _updateLockButton();
  _updateCardState();
  _drawLine();
}

// ── Show / hide ────────────────────────────────────────────────────────────────

function _expand() {
  if (_collapseId) { clearTimeout(_collapseId); _collapseId = null; }
  _card.classList.add("dnm-visible");
}

function _collapse() {
  _collapseId = null;
  _card.classList.remove("dnm-visible");
}

// ── Transit line SVG ───────────────────────────────────────────────────────────

function _drawLine() {
  if (!_svg || !canvas.scene) return;

  const isGM    = game.user?.isGM ?? false;
  const allNodes = listNodes(canvas.scene);

  const hubs = Object.values(allNodes)
    .filter(n => n.fastTravelHub)
    .filter(n => isGM || _localDiscovered.has(n.id))
    .sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);

  if (hubs.length === 0) {
    _svg.setAttribute("width",  "320");
    _svg.setAttribute("height", "40");
    _svg.setAttribute("viewBox", "0 0 320 40");
    _svg.innerHTML = `<text x="160" y="26" text-anchor="middle"
      fill="rgba(0,255,255,0.3)" font-size="11"
      font-family="Orbitron,sans-serif" letter-spacing="0.1em">
      NO DISCOVERED HUB STATIONS
    </text>`;
    _resizeCard(320);
    return;
  }

  const n = hubs.length;

  // Adaptive spacing — compresses as more stops are added so all fit on screen
  const viewportW  = window.innerWidth;
  const maxCardW   = Math.min(viewportW * 0.9, 1100);
  const usable     = maxCardW - LEFT_PAD - RIGHT_PAD;
  const spacing    = n <= 1
    ? 0
    : Math.min(MAX_SPACING, Math.max(MIN_SPACING, usable / (n - 1)));

  const lineW  = Math.max(0, (n - 1) * spacing);
  const svgW   = lineW + LEFT_PAD + RIGHT_PAD;
  const x0     = LEFT_PAD;

  _svg.setAttribute("width",   String(svgW));
  _svg.setAttribute("height",  String(SVG_H));
  _svg.setAttribute("viewBox", `0 0 ${svgW} ${SVG_H}`);

  let out = "";

  // ── Main transit band (neon rect — no filters, reliable across all browsers) ─
  if (n > 1) {
    // Soft glow strip behind the band
    out += `<rect x="${x0}" y="${LINE_Y - LINE_H - 4}" width="${lineW}"
      height="${LINE_H * 3}" rx="${LINE_H}"
      fill="#00ffff" opacity="0.08"/>`;
    // Solid band
    out += `<rect x="${x0}" y="${LINE_Y - LINE_H / 2}" width="${lineW}"
      height="${LINE_H}" rx="${LINE_H / 2}"
      fill="#00ffff" opacity="0.85"/>`;
    // Bright inner highlight
    out += `<rect x="${x0 + 4}" y="${LINE_Y - LINE_H / 2 + 1}" width="${lineW - 8}"
      height="${LINE_H / 2 - 1}" rx="${LINE_H / 4}"
      fill="white" opacity="0.18"/>`;
  }

  // ── Stations ──────────────────────────────────────────────────────────────────
  hubs.forEach((node, i) => {
    const cx     = x0 + i * spacing;
    const cy     = LINE_Y;
    const fill   = node.fillColor   ?? "#0a1c27";
    const stroke = node.borderColor ?? "#00ffff";
    const lcolor = node.labelColor  ?? "#e0ffff";
    const label  = _esc(node.label  ?? "Node");

    // Outer glow halo (no filter — plain semi-transparent circle)
    out += `<circle cx="${cx}" cy="${cy}" r="${CIRCLE_R + 7}"
      fill="${stroke}" opacity="0.15"/>`;

    // Station circle
    out += `<circle cx="${cx}" cy="${cy}" r="${CIRCLE_R}"
      fill="${fill}" stroke="${stroke}" stroke-width="3.5"
      class="dnm-station" data-node-id="${node.id}" style="cursor:pointer"/>`;

    // Short tick stem from circle top up to where label starts
    const stemTop = cy - CIRCLE_R - 14;
    out += `<line x1="${cx}" y1="${cy - CIRCLE_R - 2}"
      x2="${cx}" y2="${stemTop}"
      stroke="${stroke}" stroke-width="1.5" opacity="0.55"/>`;

    // Label: pivot at the stem-top, rotate -45° (up-right diagonal, CTA style)
    out += `<text x="0" y="0"
      transform="translate(${cx + 3},${stemTop - 2}) rotate(-45)"
      text-anchor="start"
      fill="${lcolor}"
      font-size="11.5"
      font-family="Orbitron,sans-serif"
      letter-spacing="0.05em"
      font-weight="600"
      class="dnm-station-label" data-node-id="${node.id}"
      style="cursor:pointer"
    >${label}</text>`;
  });

  _svg.innerHTML = out;
  _resizeCard(svgW);

  // Click + hover handlers
  _svg.querySelectorAll("[data-node-id]").forEach(el => {
    el.addEventListener("click", () => {
      const node = allNodes[el.dataset.nodeId];
      if (node) _fastTravelTo(node);
    });
    if (el.tagName.toLowerCase() === "circle" && el.classList.contains("dnm-station")) {
      el.addEventListener("mouseenter", () => el.setAttribute("r", String(CIRCLE_R + 3)));
      el.addEventListener("mouseleave", () => el.setAttribute("r", String(CIRCLE_R)));
    }
  });
}

function _updateLockButton() {
  const btn = _card?.querySelector("#dnm-transit-lock");
  if (!btn) return;
  const on = isFastTravelEnabled();
  btn.innerHTML = on
    ? '<i class="fa-solid fa-lock-open"></i>'
    : '<i class="fa-solid fa-lock"></i>';
  btn.title  = on ? "Fast travel ON — click to restrict" : "Fast travel RESTRICTED — click to enable";
  btn.dataset.state = on ? "on" : "off";
}

function _updateCardState() {
  if (!_card) return;
  const on = isFastTravelEnabled();
  _card.classList.toggle("dnm-travel-restricted", !on);
  const badge = _card.querySelector(".dnm-transit-restricted");
  if (badge) badge.style.display = on ? "none" : "inline";
}

/** Adjust card width to match SVG so it stays a tight card, not a wide band. */
function _resizeCard(svgW) {
  if (!_card) return;
  // Card width = SVG + 2×20px horizontal padding
  const cardW = Math.min(svgW + 40, window.innerWidth * 0.92);
  _card.style.width = `${cardW}px`;
}

function _esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Fast travel ────────────────────────────────────────────────────────────────

async function _fastTravelTo(node) {
  if (!isFastTravelEnabled()) {
    ui.notifications?.warn("[DNM] Fast travel is currently restricted in this area.");
    return;
  }
  const controlled = canvas.tokens?.controlled ?? [];
  const token = controlled.find(t => t.isOwner);
  if (!token) {
    ui.notifications?.warn("[DNM] Select your token first to fast travel.");
    return;
  }
  const tokenDoc = token.document ?? token;

  _collapse();

  const overlay = _makeOverlay();
  await _fadeEl(overlay, 0, 1, 300);

  const gs = canvas.grid?.size ?? 100;
  const tx = node.x - (tokenDoc.width  * gs) / 2;
  const ty = node.y - (tokenDoc.height * gs) / 2;
  await tokenDoc.update({ x: tx, y: ty }, { animate: false, teleport: true });
  canvas.animatePan?.({ x: node.x, y: node.y, duration: 0 });

  await new Promise(r => setTimeout(r, 100));

  await _fadeEl(overlay, 1, 0, 350);
  overlay.remove();
}

function _makeOverlay() {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;inset:0;background:#000;z-index:9100;opacity:0;pointer-events:none";
  document.body.appendChild(el);
  return el;
}

function _fadeEl(el, from, to, ms) {
  return new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      el.style.opacity = String(from + (to - from) * e);
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}
