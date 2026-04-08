/**
 * doors.js — locked / blocked door dialogue and toll door dialogue (ApplicationV2, Foundry v13+)
 */

import { CONNECTION_TYPES } from "./constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DoorBlockedApp extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(connection, token, callbacks = {}, options = {}) {
    super(options);
    this._connection = connection;
    this._token      = token;
    this._cbBack     = callbacks.onBack ?? (() => {});
  }

  static DEFAULT_OPTIONS = {
    id:       "dnm-door-blocked",
    window:   { title: "Blocked Passage", resizable: false },
    position: { width: 360, height: "auto" },
    classes:  ["dnm-app", "dnm-door-blocked"],
    actions:  {
      back: DoorBlockedApp._onBack,
    },
  };

  static PARTS = {
    body: { template: "modules/derelict-node-mapper/templates/door-blocked.hbs" },
  };

  async _prepareContext(_options) {
    const typeInfo  = CONNECTION_TYPES.find(t => t.id === this._connection.type) ?? { label: "Blocked Door" };
    const tokenName = (this._token?.document ?? this._token)?.name ?? "Your token";
    const lockMessage = this._connection.lockMessage?.trim()
      || "The way is locked. You need authorisation to proceed.";
    return {
      typeName:    typeInfo.label,
      tokenName,
      lockMessage,
    };
  }

  static _onBack(_event, _target) {
    this._cbBack();
    this.close();
  }
}

// ── Toll door dialogue ────────────────────────────────────────────────────────

export class TollDoorApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /**
   * @param {object}   connection  — the connection data (tollCost, tollMessage)
   * @param {Token}    token       — the travelling token
   * @param {object}   callbacks   — { onPay, onBack }
   */
  constructor(connection, token, callbacks = {}, options = {}) {
    super(options);
    this._connection = connection;
    this._token      = token;
    this._cbPay      = callbacks.onPay  ?? (() => {});
    this._cbBack     = callbacks.onBack ?? (() => {});
  }

  static DEFAULT_OPTIONS = {
    id:       "dnm-toll-door",
    window:   { title: "Toll Door", resizable: false },
    position: { width: 360, height: "auto" },
    classes:  ["dnm-app", "dnm-door-blocked"],
    actions:  {
      pay:  TollDoorApp._onPay,
      back: TollDoorApp._onBack,
    },
  };

  static PARTS = {
    body: { template: "modules/derelict-node-mapper/templates/toll-door.hbs" },
  };

  async _prepareContext(_options) {
    const tollCost      = Number(this._connection.tollCost) || 0;
    const tollMessage   = this._connection.tollMessage?.trim() || "A toll is required to pass.";
    const tokenDoc      = this._token?.document ?? this._token;
    const actor         = tokenDoc?.actor;
    const rawCredits    = actor?.system?.credits?.value ?? "0";
    const currentCredits = _parseCredits(rawCredits);
    return {
      tollCost,
      tollMessage,
      currentCredits,
      canAfford: currentCredits >= tollCost,
    };
  }

  static async _onPay(_event, _target) {
    const tollCost    = Number(this._connection.tollCost) || 0;
    const tokenDoc    = this._token?.document ?? this._token;
    const actor       = tokenDoc?.actor;
    if (!actor) { ui.notifications?.error("No actor found for this token."); return; }

    const rawCredits    = actor.system?.credits?.value ?? "0";
    const currentCredits = _parseCredits(rawCredits);
    if (currentCredits < tollCost) {
      ui.notifications?.warn("Insufficient credits.");
      return;
    }

    const newCredits = currentCredits - tollCost;
    await actor.update({ "system.credits.value": String(newCredits) });
    ui.notifications?.info(`Paid ${tollCost} cr. Remaining balance: ${newCredits} cr.`);
    await this._cbPay();
    this.close();
  }

  static _onBack(_event, _target) {
    this._cbBack();
    this.close();
  }
}

/** Parse credits from whatever the system stores — string or number. */
function _parseCredits(raw) {
  const n = parseInt(String(raw).replace(/[^0-9\-]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}
