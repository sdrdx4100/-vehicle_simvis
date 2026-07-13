import { el, ROLE_LABELS } from "./util.js";

const ROLES = [
  "speed", "rpm", "gear", "shift_in_process", "throttle", "brake",
  "steering", "accel_x", "accel_y", "yaw_rate", "bearing", "altitude",
  "lat", "lon", "x", "y",
];

const LABELS = {
  ...ROLE_LABELS,
  shift_in_process: "Shift flag",
  lat: "Latitude", lon: "Longitude", x: "Position X", y: "Position Y",
};

const storageKey = (id) => `simvis-mapping:${id}`;

function suspiciousSpeed(dataset) {
  const column = dataset?.mapping?.speed || "";
  return /engine.*speed|speed.*engine|rpm/i.test(column);
}

export class SignalMappingDialog {
  constructor(dialog, button, api, onApplied) {
    this.dialog = dialog;
    this.button = button;
    this.api = api;
    this.onApplied = onApplied;
    this.fields = dialog.querySelector("#mapping-fields");
    this.status = dialog.querySelector("#mapping-status");
    this.dataset = null;

    button.addEventListener("click", () => this.open());
    dialog.querySelector("#mapping-apply").addEventListener("click", () => this.apply());
    dialog.querySelector("#mapping-auto").addEventListener("click", () => this.reset());
  }

  setDataset(dataset) {
    this.dataset = dataset;
    const suspicious = suspiciousSpeed(dataset);
    this.button.classList.toggle("mapping-alert", suspicious);
    this.button.title = suspicious
      ? `Suspicious speed mapping: ${dataset.mapping.speed}. Click to correct it.`
      : "Choose which columns drive each dashboard signal";
  }

  async restore(dataset) {
    const raw = localStorage.getItem(storageKey(dataset.id));
    if (!raw) return dataset;
    try {
      return await this.api.updateMapping(dataset.id, JSON.parse(raw));
    } catch {
      localStorage.removeItem(storageKey(dataset.id));
      return dataset;
    }
  }

  open() {
    if (!this.dataset) return;
    this.render();
    this.dialog.showModal();
  }

  render() {
    this.fields.textContent = "";
    this.status.textContent = suspiciousSpeed(this.dataset)
      ? `Check Speed: currently mapped to ${this.dataset.mapping.speed}`
      : "";
    const columns = this.dataset.columns.filter((column) => column.numeric);

    for (const role of ROLES) {
      const select = el("select", { "data-role": role, "aria-label": LABELS[role] || role });
      const none = el("option", { value: "" });
      none.textContent = "— Not assigned —";
      select.append(none);
      for (const column of columns) {
        const option = el("option", { value: column.name });
        option.textContent = `${column.name}  ·  ${column.dtype}`;
        option.selected = this.dataset.mapping[role] === column.name;
        select.append(option);
      }
      if (role === "speed" && suspiciousSpeed(this.dataset)) select.classList.add("mapping-warning");
      const label = el("label", {});
      label.textContent = LABELS[role] || role;
      this.fields.append(el("div", { class: "mapping-field" }, label, select));
    }
  }

  async apply() {
    const mapping = {};
    for (const select of this.fields.querySelectorAll("select[data-role]")) {
      mapping[select.dataset.role] = select.value || null;
    }
    this.status.textContent = "Applying…";
    try {
      const updated = await this.api.updateMapping(this.dataset.id, mapping);
      localStorage.setItem(storageKey(this.dataset.id), JSON.stringify(mapping));
      this.setDataset(updated);
      this.dialog.close();
      await this.onApplied(updated);
    } catch (error) {
      this.status.textContent = error.message;
    }
  }

  async reset() {
    this.status.textContent = "Detecting…";
    try {
      const updated = await this.api.resetMapping(this.dataset.id);
      localStorage.removeItem(storageKey(this.dataset.id));
      this.setDataset(updated);
      this.dialog.close();
      await this.onApplied(updated);
    } catch (error) {
      this.status.textContent = error.message;
    }
  }
}
