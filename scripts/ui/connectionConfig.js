/**
 * ui/connectionConfig.js — Connection creation/edit dialog (ApplicationV2, Foundry v13+)
 */

import { CONNECTION_TYPES, LINE_STYLES, DEFAULT_CONNECTION } from "../constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ConnectionConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(data, callbacks = {}, options = {}) {
    super(options);
    this._formData  = foundry.utils.duplicate(data ?? { ...DEFAULT_CONNECTION });
    this._onSubmit  = callbacks.onSubmit ?? (() => {});
    this._onDelete  = callbacks.onDelete ?? null;
  }

  static DEFAULT_OPTIONS = {
    id:       "dnm-connection-config",
    window:   { title: "Connection Settings", resizable: false },
    position: { width: 420, height: 560 },
    classes:  ["dnm-app", "dnm-connection-config"],
    actions:  {
      submit: ConnectionConfigApp._onClickSubmit,
      delete: ConnectionConfigApp._onClickDelete,
      cancel: ConnectionConfigApp._onClickCancel,
    },
  };

  static PARTS = {
    form: { template: "modules/derelict-node-mapper/templates/connection-config.hbs" },
  };

  async _prepareContext(_options) {
    const stops = this._formData.stops ?? [];
    return {
      ...this._formData,
      connectionTypes:  CONNECTION_TYPES,
      lineStyles:       LINE_STYLES,
      isNew:            !this._formData.id,
      canDelete:        Boolean(this._formData.id && this._onDelete),
      firstStopLocked:  stops[0]?.locked ?? false,
      lastStopLocked:   stops.length > 1 ? (stops[stops.length - 1]?.locked ?? false) : false,
      anyLocked:        (stops[0]?.locked ?? false) || (stops.length > 1 ? (stops[stops.length - 1]?.locked ?? false) : false),
      lockMessage:      this._formData.lockMessage ?? DEFAULT_CONNECTION.lockMessage,
      isToll:           this._formData.type === "toll",
      tollCost:         this._formData.tollCost    ?? DEFAULT_CONNECTION.tollCost,
      tollMessage:      this._formData.tollMessage  ?? DEFAULT_CONNECTION.tollMessage,
      tollOneTime:      this._formData.tollOneTime  ?? DEFAULT_CONNECTION.tollOneTime,
      tollPaid:         this._formData.tollPaid     ?? false,
      firstStopToll:    stops[0]?.toll ?? false,
      lastStopToll:     stops.length > 1 ? (stops[stops.length - 1]?.toll ?? false) : false,
      // "false", "first", or "last" — passed as string so HBS eq helper works
      lockOnTraverse:   String(this._formData.lockOnTraverse ?? false),
    };
  }

  _onRender(_context, _options) {
    const el = this.element;

    // Colour preview swatches
    el.querySelectorAll("input[type=color]").forEach(input => {
      input.addEventListener("input", e => {
        const preview = el.querySelector(`[data-preview="${e.target.name}"]`);
        if (preview) preview.style.background = e.target.value;
      });
    });

    // Show/hide toll section and lock-traverse section when type changes
    const typeSelect      = el.querySelector("select[name=type]");
    const tollSection     = el.querySelector(".dnm-toll-section");
    const lockTraverseGrp = el.querySelector(".dnm-lock-traverse-group");
    const NO_DOOR_TYPES   = new Set(["corridor", "junction"]);
    const syncType = () => {
      const t = typeSelect?.value ?? "";
      if (tollSection)     tollSection.style.display     = t === "toll"           ? "" : "none";
      if (lockTraverseGrp) lockTraverseGrp.style.display = NO_DOOR_TYPES.has(t)  ? "none" : "";
    };
    syncType();
    typeSelect?.addEventListener("change", syncType);

    // Show/hide lock message when either lock checkbox changes
    const firstLocked  = el.querySelector("input[name=firstStopLocked]");
    const lastLocked   = el.querySelector("input[name=lastStopLocked]");
    const lockMsgGroup = el.querySelector("#dnm-lock-message-group");
    const syncLock = () => {
      if (lockMsgGroup) lockMsgGroup.style.display =
        (firstLocked?.checked || lastLocked?.checked) ? "block" : "none";
    };
    syncLock();
    firstLocked?.addEventListener("change", syncLock);
    lastLocked?.addEventListener("change", syncLock);
  }

  // ── Action handlers ─────────────────────────────────────────────────────────

  static async _onClickSubmit(_event, _target) {
    const form = this.element.querySelector("form");
    const fd   = new foundry.applications.ux.FormDataExtended(form);
    const data = foundry.utils.expandObject(fd.object);

    data.lineWidth      = Number(data.lineWidth) || DEFAULT_CONNECTION.lineWidth;
    data.travelable     = Boolean(data.travelable);
    data.oneWay         = Boolean(data.oneWay);
    data.hidden         = Boolean(data.hidden);
    // "false" string → boolean false; "first"/"last" stay as strings
    const lot = data.lockOnTraverse;
    data.lockOnTraverse = (lot === "first" || lot === "last") ? lot : false;
    data.lockMessage  = (data.lockMessage ?? "").trim() || DEFAULT_CONNECTION.lockMessage;
    data.tollCost     = Math.max(0, Number(data.tollCost) || 0);
    data.tollMessage  = (data.tollMessage ?? "").trim() || DEFAULT_CONNECTION.tollMessage;
    data.tollOneTime  = Boolean(data.tollOneTime);
    // Preserve existing paid state — GM can reset it via the checkbox
    if (!data.tollOneTime) data.tollPaid = false;  // recurring resets paid flag
    else data.tollPaid = this._formData.tollPaid ?? false;

    // Preserve routing fields — not in the form
    data.stops = (this._formData.stops ?? []).map((s, i, arr) => {
      if (i === 0)            return { ...s, locked: Boolean(data.firstStopLocked), toll: Boolean(data.firstStopToll) };
      if (i === arr.length-1) return { ...s, locked: Boolean(data.lastStopLocked),  toll: Boolean(data.lastStopToll)  };
      return s;
    });
    delete data.firstStopLocked;
    delete data.lastStopLocked;
    delete data.firstStopToll;
    delete data.lastStopToll;

    await this._onSubmit(data);
    this.close();
  }

  static async _onClickDelete(_event, target) {
    if (!this._onDelete) return;

    // Two-click confirmation — no async dialog needed
    if (!target.dataset.confirming) {
      target.dataset.confirming = "1";
      target.textContent = "⚠ Click again to confirm delete";
      target.style.background = "#8b0000";
      setTimeout(() => {
        if (target.dataset.confirming) {
          delete target.dataset.confirming;
          target.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
          target.style.background = "";
        }
      }, 3000);
      return;
    }

    try {
      await this._onDelete();
      this.close();
    } catch (err) {
      console.error("[DNM] Connection delete failed:", err);
      ui.notifications?.error("Delete failed — see console for details.");
    }
  }

  static _onClickCancel(_event, _target) {
    this.close();
  }
}
