/**
 * ui/nodeConfig.js — Node creation/edit dialog (ApplicationV2, Foundry v13+)
 */

import { NODE_SHAPES, DEFAULT_NODE } from "../constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class NodeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(data, callbacks = {}, options = {}) {
    super(options);
    this._formData  = foundry.utils.duplicate(data ?? { ...DEFAULT_NODE });
    this._onSubmit  = callbacks.onSubmit ?? (() => {});
    this._onDelete  = callbacks.onDelete ?? null;
  }

  static DEFAULT_OPTIONS = {
    id:       "dnm-node-config",
    window:   { title: "Node Settings", resizable: false },
    position: { width: 400, height: 560 },
    classes:  ["dnm-app", "dnm-node-config"],
    actions:  {
      submit: NodeConfigApp._onClickSubmit,
      delete: NodeConfigApp._onClickDelete,
      cancel: NodeConfigApp._onClickCancel,
    },
  };

  static PARTS = {
    form: { template: "modules/derelict-node-mapper/templates/node-config.hbs" },
  };

  async _prepareContext(_options) {
    const fd = this._formData;
    return {
      ...fd,
      description:      fd.description      ?? "",
      descriptionSize:  fd.descriptionSize  ?? 14,
      descriptionColor: fd.descriptionColor ?? "#cccccc",
      fastTravelHub: fd.fastTravelHub ?? false,
      onEnter:   { showImage: false, imageUrl: "", sendToScene: false, sceneId: "", openJournal: false, journalId: "", ...(fd.onEnter ?? {}) },
      encounter: { chance: 0, tableId: "", ...(fd.encounter ?? {}) },
      shapes:    NODE_SHAPES,
      isNew:     !fd.id,
      canDelete: Boolean(fd.id && this._onDelete),
    };
  }

  // Update colour preview swatches live after render; wire onEnter show/hide
  _onRender(_context, _options) {
    const el = this.element;

    // Colour preview swatches
    el.querySelectorAll("input[type=color]").forEach(input => {
      input.addEventListener("input", e => {
        const preview = el.querySelector(`[data-preview="${e.target.name}"]`);
        if (preview) preview.style.background = e.target.value;
      });
    });

    // File picker for image path
    const pickBtn = el.querySelector('[data-action="pickImage"]');
    if (pickBtn) {
      pickBtn.addEventListener("click", () => {
        const imgInput = el.querySelector('input[name="onEnter.imageUrl"]');
        new FilePicker({
          type:     "image",
          current:  imgInput?.value ?? "",
          callback: path => { if (imgInput) imgInput.value = path; },
        }).render(true);
      });
    }

    // Show/hide onEnter sub-fields when checkboxes change
    const pairs = [
      ["onEnter.showImage",   "dnm-oe-image-field"],
      ["onEnter.sendToScene", "dnm-oe-scene-field"],
      ["onEnter.openJournal", "dnm-oe-journal-field"],
    ];
    for (const [cbName, fieldId] of pairs) {
      const cb    = el.querySelector(`input[name="${cbName}"]`);
      const field = el.querySelector(`#${fieldId}`);
      if (!cb || !field) continue;
      const sync = () => { field.style.display = cb.checked ? "block" : "none"; };
      sync();
      cb.addEventListener("change", sync);
    }
  }

  // ── Action handlers ─────────────────────────────────────────────────────────

  static async _onClickSubmit(_event, _target) {
    const form = this.element.querySelector("form");
    const fd   = new foundry.applications.ux.FormDataExtended(form);
    const data = foundry.utils.expandObject(fd.object);

    data.x           = Number(data.x)           || 0;
    data.y           = Number(data.y)           || 0;
    data.width       = Number(data.width)       || DEFAULT_NODE.width;
    data.height      = Number(data.height)      || DEFAULT_NODE.height;
    data.borderWidth = Number(data.borderWidth) || DEFAULT_NODE.borderWidth;
    data.labelSize   = Number(data.labelSize)   || DEFAULT_NODE.labelSize;
    data.labelOffset = Number(data.labelOffset) || 0;
    data.createWalls      = Boolean(data.createWalls);
    data.fastTravelHub    = Boolean(data.fastTravelHub);
    data.description      = String(data.description      ?? "").trim();
    data.descriptionSize  = Number(data.descriptionSize)  || 14;
    data.descriptionColor = String(data.descriptionColor  ?? "#cccccc").trim();

    // Normalise onEnter — expandObject already nests it
    if (!data.onEnter) data.onEnter = {};
    data.onEnter.showImage   = Boolean(data.onEnter.showImage);
    data.onEnter.imageUrl    = String(data.onEnter.imageUrl   ?? "").trim();
    data.onEnter.sendToScene = Boolean(data.onEnter.sendToScene);
    data.onEnter.sceneId     = String(data.onEnter.sceneId    ?? "").trim();
    data.onEnter.openJournal = Boolean(data.onEnter.openJournal);
    data.onEnter.journalId   = String(data.onEnter.journalId  ?? "").trim();

    if (!data.encounter) data.encounter = {};
    data.encounter.chance  = Math.min(100, Math.max(0, Number(data.encounter.chance) || 0));
    data.encounter.tableId = String(data.encounter.tableId ?? "").trim();

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
      console.error("[DNM] Node delete failed:", err);
      ui.notifications?.error("Delete failed — see console for details.");
    }
  }

  static _onClickCancel(_event, _target) {
    this.close();
  }
}
