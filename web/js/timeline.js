// Transport-bar timeline: full-log speed sparkline + played region +
// draggable cursor. Keyboard-operable (role=slider).

import { cssVar, fitCanvas, fmtTime } from "./util.js";

export class Timeline {
  constructor(container, player) {
    this.container = container;
    this.canvas = container.querySelector("canvas");
    this.player = player;
    this.spark = null; // downsampled speed values for the background
    this._scrubbing = false;

    container.setAttribute("role", "slider");
    container.setAttribute("tabindex", "0");
    container.setAttribute("aria-label", "Playback position");

    new ResizeObserver(() => this.draw()).observe(this.canvas);
    container.addEventListener("pointerdown", (e) => {
      this._scrubbing = true;
      container.setPointerCapture(e.pointerId);
      this.#seekTo(e);
    });
    container.addEventListener("pointermove", (e) => { if (this._scrubbing) this.#seekTo(e); });
    container.addEventListener("pointerup", () => { this._scrubbing = false; });
    container.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 5;
      if (e.key === "ArrowRight") { this.player.seek(this.player.cursor + step); e.preventDefault(); }
      if (e.key === "ArrowLeft") { this.player.seek(this.player.cursor - step); e.preventDefault(); }
      if (e.key === "Home") { this.player.seek(0); e.preventDefault(); }
      if (e.key === "End") { this.player.seek(this.player.duration); e.preventDefault(); }
    });

    player.on("cursor", () => this.draw());
    player.on("loaded", () => this.setData());
  }

  setData() {
    const speed = this.player.series.speed;
    const t = this.player.t;
    if (speed && t.length) {
      const buckets = 400;
      const spark = new Array(buckets).fill(null);
      const dur = this.player.duration || 1;
      for (let i = 0; i < t.length; i++) {
        const v = speed[i];
        if (v == null) continue;
        const b = Math.min(buckets - 1, Math.floor((t[i] / dur) * buckets));
        if (spark[b] == null || v > spark[b]) spark[b] = v;
      }
      const max = Math.max(...spark.filter((v) => v != null), 1);
      this.spark = spark.map((v) => (v == null ? 0 : v / max));
    } else {
      this.spark = null;
    }
    this.draw();
  }

  #seekTo(e) {
    const rect = this.canvas.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.player.seek(f * this.player.duration);
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const dur = this.player.duration || 1;
    const frac = this.player.cursor / dur;
    this.container.setAttribute("aria-valuemin", "0");
    this.container.setAttribute("aria-valuemax", `${Math.round(dur)}`);
    this.container.setAttribute("aria-valuenow", `${Math.round(this.player.cursor)}`);
    this.container.setAttribute("aria-valuetext", fmtTime(this.player.cursor));

    // Track
    ctx.fillStyle = cssVar("--ghost");
    ctx.beginPath();
    ctx.roundRect(0, h * 0.2, w, h * 0.6, 5);
    ctx.fill();

    // Speed sparkline silhouette (de-emphasized; played part in accent)
    if (this.spark) {
      const n = this.spark.length;
      const drawSpark = (fromF, toF, color, alpha) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(w * fromF, 0, w * (toF - fromF), h);
        ctx.clip();
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(0, h * 0.8);
        for (let i = 0; i < n; i++) {
          ctx.lineTo((i / (n - 1)) * w, h * 0.8 - this.spark[i] * h * 0.55);
        }
        ctx.lineTo(w, h * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };
      drawSpark(0, 1, cssVar("--text-muted"), 0.25);
      drawSpark(0, frac, cssVar("--series-1"), 0.75);
    } else {
      ctx.fillStyle = cssVar("--series-1");
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.roundRect(0, h * 0.2, w * frac, h * 0.6, 5);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Cursor handle
    const px = w * frac;
    ctx.beginPath();
    ctx.arc(px, h / 2, 8, 0, Math.PI * 2);
    ctx.fillStyle = cssVar("--surface-1");
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, h / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = cssVar("--series-1");
    ctx.fill();
  }
}
