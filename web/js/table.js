// Table view — the WCAG-clean twin of the dashboard: every channel value
// is reachable without hovering anything.

import { api } from "./api.js";
import { el } from "./util.js";

const PAGE = 100;

export class TableView {
  constructor(root) {
    this.root = root;
    this.scroll = root.querySelector("#table-scroll");
    this.info = root.querySelector("#table-info");
    this.prevBtn = root.querySelector("#table-prev");
    this.nextBtn = root.querySelector("#table-next");
    this.datasetId = null;
    this.offset = 0;
    this.total = 0;
    this.prevBtn.addEventListener("click", () => this.go(this.offset - PAGE));
    this.nextBtn.addEventListener("click", () => this.go(this.offset + PAGE));
  }

  setDataset(id) {
    this.datasetId = id;
    this.offset = 0;
    if (this.root.style.display !== "none") this.load();
  }

  async go(offset) {
    this.offset = Math.max(0, Math.min(offset, Math.max(0, this.total - 1)));
    await this.load();
  }

  async load() {
    if (!this.datasetId) return;
    this.scroll.style.opacity = "0.5"; // hold previous render during refetch
    try {
      const data = await api.table(this.datasetId, this.offset, PAGE);
      this.total = data.total;
      const table = el("table", {});
      const headRow = el("tr", {});
      headRow.append(el("th", {}, "#"));
      for (const c of data.columns) {
        const th = el("th", {});
        th.textContent = c;
        headRow.append(th);
      }
      table.append(el("thead", {}, headRow));
      const tbody = el("tbody", {});
      data.rows.forEach((row, i) => {
        const tr = el("tr", {});
        tr.append(el("td", {}, `${this.offset + i}`));
        for (const c of data.columns) {
          const td = el("td", {});
          td.textContent = row[c] == null ? "–" : `${row[c]}`;
          tr.append(td);
        }
        tbody.append(tr);
      });
      table.append(tbody);
      this.scroll.textContent = "";
      this.scroll.append(table);
      this.info.textContent = `rows ${this.offset.toLocaleString()}–${Math.min(this.offset + PAGE, this.total).toLocaleString()} of ${this.total.toLocaleString()}`;
      this.prevBtn.disabled = this.offset === 0;
      this.nextBtn.disabled = this.offset + PAGE >= this.total;
    } finally {
      this.scroll.style.opacity = "1";
    }
  }
}
