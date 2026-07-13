// Shared singleton tooltip. Labels are untrusted data — everything goes
// in via textContent, never innerHTML.

import { el } from "./util.js";

export class Tooltip {
  constructor() {
    this.node = el("div", { class: "viz-tooltip", role: "status" });
    document.body.append(this.node);
  }

  show(clientX, clientY, timeText, rows) {
    this.node.textContent = "";
    const head = el("div", { class: "tt-time" });
    head.textContent = timeText;
    this.node.append(head);
    for (const row of rows) {
      const key = el("i", {});
      key.style.borderTopColor = row.color;
      const value = el("b", {});
      value.textContent = row.value;
      const label = el("span", {});
      label.textContent = row.label;
      this.node.append(el("div", { class: "tt-row" }, key, value, label));
    }
    this.node.style.display = "block";
    const rect = this.node.getBoundingClientRect();
    let x = clientX + 14, y = clientY + 12;
    if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight - 8) y = clientY - rect.height - 12;
    this.node.style.left = `${x}px`;
    this.node.style.top = `${y}px`;
  }

  hide() {
    this.node.style.display = "none";
  }
}
