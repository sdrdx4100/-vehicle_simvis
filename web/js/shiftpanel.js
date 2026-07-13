// Shift analysis panel: table of gearshift events (speed captured at the
// ShiftInProcess flag's on/off edges, duration, jerk-based shock) with
// click-to-seek. The severity chip pairs a status color with a text label,
// so severity is never color-alone.

import { el, fmtTime, fmtNum } from "./util.js";

export class ShiftPanel {
  constructor(root, onSeek) {
    this.root = root;
    this.sub = root.querySelector("#shift-sub");
    this.summaryBox = root.querySelector("#shift-summary");
    this.wrap = root.querySelector("#shift-table-wrap");
    this.onSeek = onSeek;
  }

  render(data) {
    this.summaryBox.textContent = "";
    this.wrap.textContent = "";
    const events = data.events || [];
    if (!events.length) {
      this.sub.textContent = "";
      const note = el("div", { class: "meta", style: "color:var(--text-muted);font-size:12px;padding:8px 0" });
      note.textContent = data.note || "No shift events detected in this log.";
      this.wrap.append(note);
      return;
    }
    this.sub.textContent = data.source === "shift_in_process"
      ? "from ShiftInProcess flag (SPN 574)"
      : "from gear transitions (no shift flag in log)";

    const s = data.summary;
    const stats = [
      ["shifts", `${s.count}`],
      ["up / down", `${s.upshifts} / ${s.downshifts}`],
      ["avg duration", `${s.meanDurationMs} ms`],
      ["avg shock", s.meanPeakJerk == null ? "–" : `${s.meanPeakJerk} m/s³`],
      ["max shock", s.maxPeakJerk == null ? "–" : `${s.maxPeakJerk} m/s³`],
      ["harsh", `${s.harshCount}`],
    ];
    for (const [label, value] of stats) {
      const item = el("span", {});
      const b = el("b", {});
      b.textContent = value;
      const lbl = document.createTextNode(` ${label}`);
      item.append(b, lbl);
      this.summaryBox.append(item);
    }

    const table = el("table", {});
    const head = el("tr", {});
    for (const h of ["t", "shift", `v on→off (${data.speedUnit})`, "Δv", "dur (ms)", "shock (m/s³)", ""]) {
      const th = el("th", {});
      th.textContent = h;
      head.append(th);
    }
    table.append(el("thead", {}, head));
    const tbody = el("tbody", {});
    for (const ev of events) {
      const tr = el("tr", { tabindex: "0", role: "button" });
      const cells = [
        fmtTime(ev.tStart),
        ev.gearFrom != null ? `${ev.gearFrom} → ${ev.gearTo}` : "–",
        ev.speedOn != null ? `${fmtNum(ev.speedOn)} → ${fmtNum(ev.speedOff)}` : "–",
        ev.deltaV != null ? `${ev.deltaV > 0 ? "+" : ""}${fmtNum(ev.deltaV, 2)}` : "–",
        `${ev.durationMs}`,
        ev.peakJerk != null ? `${fmtNum(ev.peakJerk)}` : "–",
      ];
      for (const c of cells) {
        const td = el("td", {});
        td.textContent = c;
        tr.append(td);
      }
      const sevTd = el("td", {});
      if (ev.severity) {
        const chip = el("span", { class: `sev ${ev.severity}` }, el("i", {}));
        const lbl = el("span", {});
        lbl.textContent = ev.severity;
        chip.append(lbl);
        sevTd.append(chip);
      }
      tr.append(sevTd);
      const seek = () => this.onSeek?.(ev.tStart);
      tr.addEventListener("click", seek);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { seek(); e.preventDefault(); }
      });
      tbody.append(tr);
    }
    table.append(tbody);
    this.wrap.append(table);
  }
}
