// G-G diagram: lateral vs longitudinal acceleration with a fading trail
// and grip-circle reference rings.

import { cssVar, fitCanvas, bisect } from "./util.js";

export class GGDiagram {
  constructor(canvas) {
    this.canvas = canvas;
    this.t = [];
    this.ax = null;
    this.ay = null;
    this.cursor = 0;
    this.maxG = 2;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setData(payload) {
    this.t = payload.t;
    this.ax = payload.series.accel_x || null;
    this.ay = payload.series.accel_y || null;
    let m = 0.5;
    for (const arr of [this.ax, this.ay]) {
      if (!arr) continue;
      for (const v of arr) if (v != null && Math.abs(v) > m) m = Math.abs(v);
    }
    this.maxG = Math.ceil(m * 2) / 2 + 0.5;
    this.draw();
  }

  get hasData() { return !!(this.ax && this.ay); }

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
      ctx.fillText("No accel_x / accel_y channels detected", w / 2, h / 2);
      return;
    }
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) / 2 - 18;
    if (r < 24) return;
    const scale = r / this.maxG;

    // Reference rings every 0.5 G — hairline, recessive.
    ctx.strokeStyle = cssVar("--grid");
    ctx.lineWidth = 1;
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    for (let g = 0.5; g <= this.maxG + 1e-9; g += 0.5) {
      ctx.beginPath();
      ctx.arc(cx, cy, g * scale, 0, Math.PI * 2);
      ctx.stroke();
      if (g === Math.round(g)) {
        ctx.fillText(`${g}G`, cx + g * scale * 0.7071 + 2, cy - g * scale * 0.7071 - 2);
      }
    }
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.strokeStyle = cssVar("--axis");
    ctx.stroke();

    // Axis captions
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("brake", cx, cy + r + 12);
    ctx.fillText("accel", cx, cy - r - 4);
    ctx.textAlign = "left";
    ctx.fillText("left", cx - r - 2, cy - 6);
    ctx.textAlign = "right";
    ctx.fillText("right", cx + r + 2, cy - 6);

    // Trail: last 4 seconds, fading. x = lateral (accel_y), y = longitudinal.
    const i1 = bisect(this.t, this.cursor);
    const i0 = bisect(this.t, this.cursor - 4);
    const accent = cssVar("--series-2");
    for (let i = i0; i <= i1; i++) {
      const ax = this.ax[i], ay = this.ay[i];
      if (ax == null || ay == null) continue;
      const age = (this.t[i1] - this.t[i]) / 4;
      ctx.globalAlpha = Math.max(0.05, 0.55 * (1 - age));
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx + ay * scale, cy - ax * scale, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Current point: ≥8px marker with 2px surface ring.
    const ax = this.ax[i1], ay = this.ay[i1];
    if (ax != null && ay != null) {
      const px = cx + ay * scale, py = cy - ax * scale;
      ctx.beginPath();
      ctx.arc(px, py, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = cssVar("--surface-1");
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }
  }
}
