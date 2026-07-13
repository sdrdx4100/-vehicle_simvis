// Track map: trajectory from GPS (or local x/y), colored by speed using
// the sequential blue ramp, with a heading-aware vehicle marker.

import { cssVar, fitCanvas, fmtNum, bisect } from "./util.js";

const RAMP = ["--seq-150", "--seq-250", "--seq-350", "--seq-450", "--seq-550", "--seq-650"];

export class TrackMap {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.t = [];
    this.xs = [];
    this.ys = [];
    this.speed = null;
    this.yaw = null;
    this.cursor = 0;
    this.hoverIdx = -1;
    this.onSeek = null;
    this.vmin = 0;
    this.vmax = 1;

    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointermove", (e) => this.#hover(e));
    canvas.addEventListener("pointerleave", () => { this.hoverIdx = -1; this.tooltip.hide(); this.draw(); });
    canvas.addEventListener("click", () => {
      if (this.hoverIdx >= 0 && this.onSeek) this.onSeek(this.t[this.hoverIdx]);
    });
  }

  setData(payload) {
    const s = payload.series;
    this.t = payload.t;
    this.speed = s.speed || null;
    this.yaw = s.yaw || null;
    if (s.lat && s.lon) {
      // Equirectangular projection around the mid-latitude.
      const lat = s.lat, lon = s.lon;
      let latSum = 0, cnt = 0;
      for (const v of lat) if (v != null) { latSum += v; cnt++; }
      const lat0 = cnt ? latSum / cnt : 0;
      const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
      const ky = 111320;
      this.xs = lon.map((v) => (v == null ? null : v * kx));
      this.ys = lat.map((v) => (v == null ? null : v * ky));
    } else if (s.x && s.y) {
      this.xs = s.x.slice();
      this.ys = s.y.slice();
    } else {
      this.xs = []; this.ys = [];
    }
    const sp = (this.speed || []).filter((v) => v != null);
    this.vmin = sp.length ? Math.min(...sp) : 0;
    this.vmax = sp.length ? Math.max(...sp) : 1;
    this.#fit();
    this.draw();
  }

  get hasData() { return this.xs.length > 1; }

  #fit() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < this.xs.length; i++) {
      const x = this.xs[i], y = this.ys[i];
      if (x == null || y == null) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    this.bounds = { minX, maxX, minY, maxY };
  }

  #project(w, h) {
    const { minX, maxX, minY, maxY } = this.bounds;
    const pad = 26;
    const sx = (w - pad * 2) / Math.max(1e-9, maxX - minX);
    const sy = (h - pad * 2) / Math.max(1e-9, maxY - minY);
    const s = Math.min(sx, sy);
    const ox = (w - (maxX - minX) * s) / 2;
    const oy = (h - (maxY - minY) * s) / 2;
    return {
      x: (v) => ox + (v - minX) * s,
      y: (v) => h - oy - (v - minY) * s, // north up
      scale: s,
    };
  }

  #rampColor(v) {
    if (v == null || this.vmax <= this.vmin) return cssVar(RAMP[3]);
    const f = (v - this.vmin) / (this.vmax - this.vmin);
    return cssVar(RAMP[Math.min(RAMP.length - 1, Math.floor(f * RAMP.length))]);
  }

  #hover(e) {
    if (!this.hasData) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const p = this.#project(rect.width, rect.height);
    // Nearest-point layer: the whole canvas is the hit target.
    let best = -1, bestD = Infinity;
    const stride = Math.max(1, Math.floor(this.xs.length / 4000));
    for (let i = 0; i < this.xs.length; i += stride) {
      if (this.xs[i] == null) continue;
      const dx = p.x(this.xs[i]) - px, dy = p.y(this.ys[i]) - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.hoverIdx = bestD < 40 * 40 ? best : -1;
    if (this.hoverIdx >= 0) {
      const rows = [];
      if (this.speed) {
        rows.push({ color: cssVar("--series-1"), label: "Speed", value: `${fmtNum(this.speed[this.hoverIdx])} km/h` });
      }
      this.tooltip.show(e.clientX, e.clientY, `t = ${fmtNum(this.t[this.hoverIdx], 2)} s`, rows);
    } else {
      this.tooltip.hide();
    }
    this.draw();
  }

  setCursor(time) {
    this.cursor = time;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    if (!this.hasData) {
      ctx.fillStyle = cssVar("--text-muted");
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No position channels (lat/lon or x/y) detected", w / 2, h / 2);
      return;
    }
    const p = this.#project(w, h);

    // Trajectory, chunked by ramp color so each corner keeps its speed hue.
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    let prev = null, prevColor = null;
    for (let i = 0; i < this.xs.length; i++) {
      if (this.xs[i] == null) { prev = null; continue; }
      const x = p.x(this.xs[i]), y = p.y(this.ys[i]);
      const color = this.#rampColor(this.speed ? this.speed[i] : null);
      if (prev) {
        if (color !== prevColor) {
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.strokeStyle = color;
        }
        ctx.lineTo(x, y);
      } else {
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.strokeStyle = color;
      }
      prev = [x, y];
      prevColor = color;
    }
    ctx.stroke();

    // Start/finish marker
    const sx = p.x(this.xs[0]), sy = p.y(this.ys[0]);
    ctx.fillStyle = cssVar("--text-muted");
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("START", sx + 7, sy + 3);

    // Speed ramp legend (scale legend for the sequential encoding)
    this.#legend(ctx, w, h);

    // Hover marker
    if (this.hoverIdx >= 0) {
      const hx = p.x(this.xs[this.hoverIdx]), hy = p.y(this.ys[this.hoverIdx]);
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.strokeStyle = cssVar("--text-primary");
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Vehicle marker at cursor with 2px surface ring
    const i = bisect(this.t, this.cursor);
    if (this.xs[i] != null) {
      const vx = p.x(this.xs[i]), vy = p.y(this.ys[i]);
      let heading = null;
      if (this.yaw && this.yaw[i] != null) {
        heading = (this.yaw[i] * Math.PI) / 180;
      } else if (i + 1 < this.xs.length && this.xs[i + 1] != null) {
        heading = Math.atan2(this.ys[i + 1] - this.ys[i], this.xs[i + 1] - this.xs[i]);
      }
      ctx.save();
      ctx.translate(vx, vy);
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fillStyle = cssVar("--surface-1");
      ctx.fill();
      if (heading != null) {
        ctx.rotate(-heading); // canvas y is flipped
        ctx.beginPath();
        ctx.moveTo(7, 0);
        ctx.lineTo(-4.5, 4.5);
        ctx.lineTo(-2.5, 0);
        ctx.lineTo(-4.5, -4.5);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
      }
      ctx.fillStyle = cssVar("--series-6");
      ctx.fill();
      ctx.restore();
    }
  }

  #legend(ctx, w, h) {
    if (!this.speed) return;
    const lw = 90, lh = 6, x0 = w - lw - 12, y0 = h - 20;
    const seg = lw / RAMP.length;
    for (let i = 0; i < RAMP.length; i++) {
      ctx.fillStyle = cssVar(RAMP[i]);
      ctx.fillRect(x0 + i * seg, y0, seg - 1, lh);
    }
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${Math.round(this.vmin)}`, x0, y0 - 3);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(this.vmax)} km/h`, x0 + lw, y0 - 3);
  }
}
