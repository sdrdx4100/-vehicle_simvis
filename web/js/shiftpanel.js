// Event-centred shift analysis: transition overview, sortable event list and
// a selected shift waveform compared with same-gear reference behaviour.

import { el, fmtTime, fmtNum } from "./util.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class ShiftPanel {
  constructor(root, onSeek, loadDetail) {
    this.root = root;
    this.sub = root.querySelector("#shift-sub");
    this.summaryBox = root.querySelector("#shift-summary");
    this.matrix = root.querySelector("#shift-matrix");
    this.wrap = root.querySelector("#shift-table-wrap");
    this.canvas = root.querySelector("#shift-detail-canvas");
    this.detailTitle = root.querySelector("#shift-detail-title");
    this.detailNote = root.querySelector("#shift-detail-note");
    this.detailStats = root.querySelector("#shift-detail-stats");
    this.onSeek = onSeek;
    this.loadDetail = loadDetail;
    this.data = null;
    this.detail = null;
    this.selectedIndex = null;
    this.filter = null;
    this.requestToken = 0;
    this.resizeObserver = new ResizeObserver(() => this.drawDetail());
    this.resizeObserver.observe(this.canvas);
  }

  render(data) {
    this.data = data;
    this.detail = null;
    this.selectedIndex = null;
    this.filter = null;
    this.summaryBox.textContent = "";
    this.matrix.textContent = "";
    this.wrap.textContent = "";
    const events = data.events || [];
    if (!events.length) {
      this.sub.textContent = "";
      this.detailTitle.textContent = "No shift selected";
      this.detailNote.textContent = data.note || "No shift events detected in this log.";
      this.detailStats.textContent = "";
      this.drawDetail();
      return;
    }
    this.sub.textContent = data.source === "shift_in_process"
      ? `SPN 574 · ${data.filterWindowMs} ms filtered jerk`
      : `gear-transition fallback · ${data.filterWindowMs} ms filtered jerk`;

    const s = data.summary;
    const stats = [
      ["shifts", s.count], ["up / down", `${s.upshifts} / ${s.downshifts}`],
      ["avg duration", `${s.meanDurationMs} ms`],
      ["median shock", s.medianPeakJerk == null ? "–" : `${s.medianPeakJerk} m/s³`],
      ["max shock", s.maxPeakJerk == null ? "–" : `${s.maxPeakJerk} m/s³`],
      ["harsh", s.harshCount],
    ];
    for (const [label, value] of stats) {
      const item = el("span", {});
      item.append(el("b", {}, document.createTextNode(String(value))), document.createTextNode(` ${label}`));
      this.summaryBox.append(item);
    }
    this.renderTransitions();
    this.renderTable();
    const worst = events.reduce((best, ev) => (ev.peakJerk ?? -1) > (best.peakJerk ?? -1) ? ev : best, events[0]);
    this.selectEvent(worst.index, false);
  }

  renderTransitions() {
    const all = el("button", { class: "shift-transition is-active", type: "button" });
    all.textContent = "All";
    all.addEventListener("click", () => this.setFilter(null));
    this.matrix.append(all);
    for (const tr of this.data.transitions || []) {
      const btn = el("button", { class: "shift-transition", type: "button" });
      btn.dataset.pair = `${tr.gearFrom}:${tr.gearTo}`;
      const value = tr.medianPeakJerk == null ? "–" : `${tr.medianPeakJerk}`;
      btn.innerHTML = `<b>${tr.gearFrom}→${tr.gearTo}</b><span>${value} m/s³ · n=${tr.count}</span>`;
      btn.setAttribute("aria-label", `${tr.gearFrom} to ${tr.gearTo}, median shock ${value} meters per second cubed, ${tr.count} shifts`);
      btn.addEventListener("click", () => this.setFilter([tr.gearFrom, tr.gearTo]));
      this.matrix.append(btn);
    }
  }

  setFilter(pair) {
    this.filter = pair;
    for (const btn of this.matrix.querySelectorAll("button")) {
      const active = pair ? btn.dataset.pair === `${pair[0]}:${pair[1]}` : !btn.dataset.pair;
      btn.classList.toggle("is-active", active);
    }
    this.renderTable();
  }

  renderTable() {
    this.wrap.textContent = "";
    const events = (this.data.events || []).filter((ev) => !this.filter
      || (ev.gearFrom === this.filter[0] && ev.gearTo === this.filter[1]));
    const table = el("table", {});
    const head = el("tr", {});
    for (const h of ["t", "shift", "speed on→off", "dur", "peak", "P95", "phase", ""]) {
      const th = el("th", {}); th.textContent = h; head.append(th);
    }
    table.append(el("thead", {}, head));
    const tbody = el("tbody", {});
    for (const ev of events) {
      const tr = el("tr", { tabindex: "0", role: "button", "aria-selected": String(ev.index === this.selectedIndex) });
      tr.dataset.eventIndex = ev.index;
      const cells = [
        fmtTime(ev.tStart),
        ev.gearFrom != null ? `${ev.gearFrom} → ${ev.gearTo}` : "–",
        ev.speedOn != null ? `${fmtNum(ev.speedOn)} → ${fmtNum(ev.speedOff)}` : "–",
        `${ev.durationMs} ms`,
        ev.peakJerk != null ? fmtNum(ev.peakJerk) : "–",
        ev.jerkP95 != null ? fmtNum(ev.jerkP95) : "–",
        ev.shockPhase || "–",
      ];
      for (const c of cells) { const td = el("td", {}); td.textContent = c; tr.append(td); }
      const sevTd = el("td", {});
      if (ev.severity) {
        const chip = el("span", { class: `sev ${ev.severity}` }, el("i", {}));
        chip.append(el("span", {}, document.createTextNode(ev.severity))); sevTd.append(chip);
      }
      tr.append(sevTd);
      const select = () => this.selectEvent(ev.index, true);
      tr.addEventListener("click", select);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { select(); e.preventDefault(); } });
      tbody.append(tr);
    }
    table.append(tbody); this.wrap.append(table);
  }

  async selectEvent(index, seek) {
    const ev = this.data.events.find((item) => item.index === index);
    if (!ev) return;
    this.selectedIndex = index;
    for (const row of this.wrap.querySelectorAll("tbody tr")) {
      row.setAttribute("aria-selected", String(Number(row.dataset.eventIndex) === index));
    }
    this.detailTitle.textContent = `${ev.gearFrom ?? "?"} → ${ev.gearTo ?? "?"} at ${fmtTime(ev.tStart)}`;
    this.detailNote.textContent = "Loading waveform…";
    this.detailStats.textContent = "";
    if (seek) this.onSeek?.(ev.tStart);
    const token = ++this.requestToken;
    try {
      const detail = await this.loadDetail(index);
      if (token !== this.requestToken) return;
      this.detail = detail;
      this.renderDetailStats();
      this.drawDetail();
    } catch (err) {
      if (token !== this.requestToken) return;
      this.detailNote.textContent = `Waveform unavailable: ${err.message}`;
    }
  }

  renderDetailStats() {
    const d = this.detail, ev = d.event;
    const reference = d.reference?.count ? `same shift median + 10–90% band · n=${d.reference.count}` : "no peer reference";
    const source = d.accelSource === "sensor" ? "longitudinal acceleration sensor" : "acceleration derived from speed";
    this.detailNote.textContent = `${reference} · ${source}`;
    this.detailStats.textContent = "";
    const values = [
      ["Peak jerk", ev.peakJerk == null ? "–" : `${ev.peakJerk} m/s³`],
      ["Jerk P95", ev.jerkP95 == null ? "–" : `${ev.jerkP95} m/s³`],
      ["Jerk RMS", ev.jerkRms == null ? "–" : `${ev.jerkRms} m/s³`],
      ["Accel P–P", ev.accelP2P == null ? "–" : `${ev.accelP2P} m/s²`],
      ["Shock timing", ev.shockTimeMs == null ? "–" : `${ev.shockTimeMs} ms · ${ev.shockPhase}`],
    ];
    for (const [label, value] of values) {
      const box = el("div", { class: "shift-stat" });
      box.append(el("span", {}, document.createTextNode(label)), el("b", {}, document.createTextNode(value)));
      this.detailStats.append(box);
    }
  }

  drawDetail() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.detail?.t?.length) {
      ctx.fillStyle = css("--text-muted"); ctx.font = "12px system-ui"; ctx.textAlign = "center";
      ctx.fillText("Select a shift to inspect its waveform", w / 2, h / 2); return;
    }
    const d = this.detail, t = d.t, s = d.series, ref = d.reference;
    const lanes = [];
    if (s.rpm) lanes.push({ key: "rpm", label: "Engine RPM", unit: "rpm", color: "--series-8", values: s.rpm });
    if (s.accel) lanes.push({ key: "accel", label: "Longitudinal accel", unit: "m/s²", color: "--series-2", values: s.accel, raw: s.accel_raw, ref: ref && [ref.accelP10, ref.accelP90, ref.accelMedian] });
    if (s.jerk) lanes.push({ key: "jerk", label: "Jerk", unit: "m/s³", color: "--series-1", values: s.jerk, ref: ref && [ref.jerkP10, ref.jerkP90, ref.jerkMedian] });
    if (!lanes.length) return;
    const left = 76, right = 12, top = 18, bottom = 22, gap = 12;
    const laneH = (h - top - bottom - gap * (lanes.length - 1)) / lanes.length;
    const x0 = t[0], x1 = t[t.length - 1], x = (v) => left + (v - x0) / (x1 - x0 || 1) * (w - left - right);
    const duration = d.event.durationMs / 1000;
    ctx.fillStyle = css("--ghost"); ctx.fillRect(x(0), top, Math.max(1, x(duration) - x(0)), h - top - bottom);
    const path = (xs, ys, y, color, width = 1.5, dash = []) => {
      ctx.beginPath(); let started = false;
      for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
        if (ys[i] == null || !Number.isFinite(ys[i])) { started = false; continue; }
        const px = x(xs[i]), py = y(ys[i]); if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    };
    lanes.forEach((lane, li) => {
      const yTop = top + li * (laneH + gap), yBottom = yTop + laneH;
      const all = lane.values.filter(Number.isFinite);
      if (lane.ref) all.push(...lane.ref[0].filter(Number.isFinite), ...lane.ref[1].filter(Number.isFinite));
      let min = Math.min(...all), max = Math.max(...all); if (!Number.isFinite(min) || min === max) { min = (min || 0) - 1; max = (max || 0) + 1; }
      const pad = (max - min) * 0.08; min -= pad; max += pad;
      const y = (v) => yBottom - (v - min) / (max - min) * laneH;
      ctx.strokeStyle = css("--grid"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, yBottom); ctx.lineTo(w - right, yBottom); ctx.stroke();
      if (min < 0 && max > 0) { ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(w - right, y(0)); ctx.stroke(); }
      ctx.fillStyle = css("--text-secondary"); ctx.font = "11px system-ui"; ctx.textAlign = "left"; ctx.fillText(lane.label, 2, yTop + 11);
      ctx.fillStyle = css("--text-muted"); ctx.font = "10px system-ui"; ctx.fillText(`${fmtNum(max, 1)}`, 2, yTop + 24); ctx.fillText(`${fmtNum(min, 1)}`, 2, yBottom);
      if (lane.ref) {
        const [lo, hi, med] = lane.ref, rt = ref.t;
        ctx.beginPath();
        for (let i = 0; i < rt.length; i++) { const cmd = i ? "lineTo" : "moveTo"; ctx[cmd](x(rt[i]), y(hi[i])); }
        for (let i = rt.length - 1; i >= 0; i--) ctx.lineTo(x(rt[i]), y(lo[i]));
        ctx.closePath(); ctx.fillStyle = css(lane.color); ctx.globalAlpha = 0.13; ctx.fill(); ctx.globalAlpha = 1;
        path(rt, med, y, css(lane.color), 1, [4, 3]);
      }
      if (lane.raw && lane.raw !== lane.values) path(t, lane.raw, y, css("--axis"), 1);
      path(t, lane.values, y, css(lane.color), 2);
    });
    const marker = (value, label, align = "center") => {
      const px = x(value); ctx.strokeStyle = css("--axis"); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, h - bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css("--text-muted"); ctx.font = "10px system-ui"; ctx.textAlign = align; ctx.fillText(label, px, 10);
    };
    marker(0, "SHIFT ON", "left"); marker(duration, "OFF", "right");
    if (d.event.gearChangeMs != null) marker(d.event.gearChangeMs / 1000, "GEAR", "center");
    ctx.fillStyle = css("--text-muted"); ctx.font = "10px system-ui"; ctx.textAlign = "center";
    for (let tick = Math.ceil(x0 * 2) / 2; tick <= x1; tick += 0.5) ctx.fillText(`${tick >= 0 ? "+" : ""}${tick.toFixed(1)}s`, x(tick), h - 4);
  }
}
