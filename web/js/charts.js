// Time-series chart engine. All charts share one time axis, one crosshair,
// one zoom window and one tooltip; the playback cursor rides every chart.
// Marks: 2px lines, hairline solid grid, min/max pixel-bucket decimation.

import { cssVar, fitCanvas, fmtNum, fmtTime, niceTicks, bisect } from "./util.js";

const M = { left: 46, right: 12, top: 8, bottom: 18 };

export class ChartSync {
  constructor(tooltip) {
    this.charts = [];
    this.tooltip = tooltip;
    this.window = null; // [t0, t1] or null = full
    this.onSeek = null;
  }
  add(chart) {
    this.charts.push(chart);
    chart.sync = this;
  }
  remove(chart) {
    this.charts = this.charts.filter((c) => c !== chart);
  }
  hover(time, sourceEvent) {
    for (const c of this.charts) c.setHover(time);
    if (time == null) this.tooltip.hide();
  }
  setWindow(win) {
    this.window = win;
    for (const c of this.charts) c.draw();
  }
  cursor(time) {
    for (const c of this.charts) c.setCursor(time);
  }
}

export class TimeChart {
  /**
   * series: [{key, label, color (css var name), unit, values, step?}]
   * All series in one chart share one y-scale — one axis, always.
   */
  constructor(canvas, { series, yUnit = "", symmetric = false }) {
    this.canvas = canvas;
    this.series = series;
    this.yUnit = yUnit;
    this.symmetric = symmetric;
    this.t = [];
    this.hoverT = null;
    this.cursorT = 0;
    this.sync = null;
    this._drag = null;
    this.markers = []; // event times flagged along the top of the plot

    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointerdown", (e) => this.#down(e));
    canvas.addEventListener("pointermove", (e) => this.#move(e));
    canvas.addEventListener("pointerleave", () => this.sync?.hover(null));
    canvas.addEventListener("pointerup", (e) => this.#up(e));
    canvas.addEventListener("dblclick", () => this.sync?.setWindow(null));
  }

  setData(t) {
    this.t = t;
    this.#computeDomain();
    this.draw();
  }

  setMarkers(times) {
    this.markers = times || [];
    this.draw();
  }

  #computeDomain() {
    let min = Infinity, max = -Infinity;
    for (const s of this.series) {
      for (const v of s.values) {
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!isFinite(min)) { min = 0; max = 1; }
    if (min === max) { min -= 1; max += 1; }
    if (this.symmetric) {
      const m = Math.max(Math.abs(min), Math.abs(max));
      min = -m; max = m;
    }
    const pad = (max - min) * 0.07;
    this.yMin = this.symmetric ? min - pad : (min >= 0 && min < (max - min) * 0.35 ? 0 : min - pad);
    this.yMax = max + pad;
  }

  get win() {
    if (this.sync?.window) return this.sync.window;
    return this.t.length ? [this.t[0], this.t[this.t.length - 1]] : [0, 1];
  }

  #xScale(w) {
    const [t0, t1] = this.win;
    const pw = w - M.left - M.right;
    return { toPx: (t) => M.left + ((t - t0) / (t1 - t0 || 1)) * pw, toT: (px) => t0 + ((px - M.left) / pw) * (t1 - t0) };
  }
  #yScale(h) {
    const ph = h - M.top - M.bottom;
    return (v) => M.top + (1 - (v - this.yMin) / (this.yMax - this.yMin)) * ph;
  }

  // ---- interaction ----

  #eventTime(e) {
    const rect = this.canvas.getBoundingClientRect();
    const { toT } = this.#xScale(rect.width);
    const [t0, t1] = this.win;
    return Math.max(t0, Math.min(t1, toT(e.clientX - rect.left)));
  }

  #down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this._drag = { x0: e.clientX, t0: this.#eventTime(e), moved: false };
  }

  #move(e) {
    if (this._drag && Math.abs(e.clientX - this._drag.x0) > 5) this._drag.moved = true;
    const time = this.#eventTime(e);
    if (this._drag?.moved) {
      this._dragEnd = time;
      this.draw();
      return;
    }
    this.sync?.hover(time);
    this.#tooltip(e, time);
  }

  #up(e) {
    if (this._drag?.moved) {
      const a = this._drag.t0, b = this.#eventTime(e);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (hi - lo > 0.05) this.sync?.setWindow([lo, hi]);
    } else if (this._drag) {
      this.sync?.onSeek?.(this.#eventTime(e));
    }
    this._drag = null;
    this._dragEnd = null;
    this.draw();
  }

  #tooltip(e, time) {
    if (!this.sync || !this.t.length) return;
    const i = bisect(this.t, time);
    const rows = this.series.map((s) => ({
      color: cssVar(s.color),
      value: `${fmtNum(s.values[i], 1)}${s.unit ? " " + s.unit : ""}`,
      label: s.label,
    }));
    this.sync.tooltip.show(e.clientX, e.clientY, `t = ${fmtTime(this.t[i])}`, rows);
  }

  setHover(time) {
    this.hoverT = time;
    this.draw();
  }

  setCursor(time) {
    this.cursorT = time;
    this.draw();
  }

  // ---- rendering ----

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    if (!this.t.length) return;
    const { toPx } = this.#xScale(w);
    const y = this.#yScale(h);
    const [t0, t1] = this.win;

    // Grid: hairline, solid, recessive.
    const yTicks = niceTicks(this.yMin, this.yMax, 4);
    ctx.strokeStyle = cssVar("--grid");
    ctx.lineWidth = 1;
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    for (const tv of yTicks) {
      const py = Math.round(y(tv)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(M.left, py);
      ctx.lineTo(w - M.right, py);
      ctx.stroke();
      ctx.fillText(fmtNum(tv, Math.abs(tv) < 10 ? 1 : 0), M.left - 6, py + 3);
    }
    const xTicks = niceTicks(t0, t1, Math.max(3, Math.floor((w - M.left) / 110)));
    ctx.textAlign = "center";
    for (const tv of xTicks) {
      const px = Math.round(toPx(tv)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, M.top);
      ctx.lineTo(px, h - M.bottom);
      ctx.stroke();
      ctx.fillText(fmtTime(tv), px, h - 5);
    }
    // Baseline
    ctx.strokeStyle = cssVar("--axis");
    ctx.beginPath();
    ctx.moveTo(M.left, h - M.bottom + 0.5);
    ctx.lineTo(w - M.right, h - M.bottom + 0.5);
    ctx.stroke();

    // Series lines with min/max pixel decimation.
    const i0 = Math.max(0, bisect(this.t, t0) - 1);
    const i1 = Math.min(this.t.length - 1, bisect(this.t, t1) + 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(M.left, 0, w - M.left - M.right, h - M.bottom);
    ctx.clip();
    for (const s of this.series) {
      ctx.strokeStyle = cssVar(s.color);
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      const plotW = w - M.left - M.right;
      const dense = i1 - i0 > plotW * 2 && !s.step;
      if (dense) {
        let col = -1, cMin = 0, cMax = 0, started = false;
        for (let i = i0; i <= i1; i++) {
          const v = s.values[i];
          if (v == null) continue;
          const px = Math.round(toPx(this.t[i]));
          if (px !== col) {
            if (col >= 0) {
              if (!started) { ctx.moveTo(col, y(cMin)); started = true; }
              ctx.lineTo(col, y(cMin));
              if (cMax !== cMin) ctx.lineTo(col, y(cMax));
            }
            col = px; cMin = v; cMax = v;
          } else {
            if (v < cMin) cMin = v;
            if (v > cMax) cMax = v;
          }
        }
        if (col >= 0) { ctx.lineTo(col, y(cMin)); if (cMax !== cMin) ctx.lineTo(col, y(cMax)); }
      } else {
        let started = false, prevY = null;
        for (let i = i0; i <= i1; i++) {
          const v = s.values[i];
          if (v == null) { started = false; continue; }
          const px = toPx(this.t[i]), py = y(v);
          if (!started) { ctx.moveTo(px, py); started = true; }
          else if (s.step) { ctx.lineTo(px, prevY); ctx.lineTo(px, py); }
          else ctx.lineTo(px, py);
          prevY = py;
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // Event markers (e.g. gearshifts): small ticks along the top edge.
    if (this.markers.length) {
      ctx.fillStyle = cssVar("--text-muted");
      for (const mt of this.markers) {
        if (mt < t0 || mt > t1) continue;
        const px = toPx(mt);
        ctx.beginPath();
        ctx.moveTo(px - 3, M.top);
        ctx.lineTo(px + 3, M.top);
        ctx.lineTo(px, M.top + 6);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Zoom selection overlay
    if (this._drag?.moved && this._dragEnd != null) {
      const a = toPx(this._drag.t0), b = toPx(this._dragEnd);
      ctx.fillStyle = cssVar("--ghost");
      ctx.fillRect(Math.min(a, b), M.top, Math.abs(b - a), h - M.top - M.bottom);
    }

    // Playback cursor
    if (this.cursorT >= t0 && this.cursorT <= t1) {
      const px = toPx(this.cursorT);
      ctx.strokeStyle = cssVar("--series-6");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, M.top);
      ctx.lineTo(px, h - M.bottom);
      ctx.stroke();
    }

    // Crosshair snapped to nearest sample
    if (this.hoverT != null && this.hoverT >= t0 && this.hoverT <= t1) {
      const i = bisect(this.t, this.hoverT);
      const px = toPx(this.t[i]);
      ctx.strokeStyle = cssVar("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, M.top);
      ctx.lineTo(px + 0.5, h - M.bottom);
      ctx.stroke();
      // Value markers with surface ring
      for (const s of this.series) {
        const v = s.values[i];
        if (v == null) continue;
        const py = y(v);
        ctx.beginPath();
        ctx.arc(px, py, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = cssVar("--surface-1");
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = cssVar(s.color);
        ctx.fill();
      }
    }
  }
}
