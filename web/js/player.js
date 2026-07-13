// Playback engine: owns the time cursor, play state and rate, and
// interpolates any loaded channel at the cursor time.

import { Emitter, bisect } from "./util.js";

const STEP_KEYS = new Set(["gear"]); // integer channels: hold, don't interpolate

export class Player extends Emitter {
  constructor() {
    super();
    this.t = [];
    this.series = {};
    this.duration = 0;
    this.cursor = 0;
    this.rate = 1;
    this.playing = false;
    this.loop = true;
    this._raf = null;
    this._lastTick = 0;
  }

  load(payload) {
    this.pause();
    this.t = payload.t;
    this.series = payload.series;
    this.duration = this.t.length ? this.t[this.t.length - 1] : 0;
    this.cursor = 0;
    this.emit("loaded");
    this.emit("cursor", 0);
  }

  valueAt(key, time = this.cursor) {
    const vals = this.series[key];
    if (!vals || !this.t.length) return null;
    const i = bisect(this.t, time);
    const a = vals[i];
    if (i >= this.t.length - 1 || STEP_KEYS.has(key)) return a;
    const b = vals[i + 1];
    if (a == null || b == null) return a ?? b;
    const t0 = this.t[i], t1 = this.t[i + 1];
    const f = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
    return a + (b - a) * f;
  }

  snapshot(time = this.cursor) {
    const out = {};
    for (const key of Object.keys(this.series)) out[key] = this.valueAt(key, time);
    return out;
  }

  play() {
    if (this.playing || !this.t.length) return;
    if (this.cursor >= this.duration - 1e-6) this.cursor = 0;
    this.playing = true;
    this._lastTick = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      const dt = (now - this._lastTick) / 1000;
      this._lastTick = now;
      this.cursor += dt * this.rate;
      if (this.cursor >= this.duration) {
        if (this.loop) {
          this.cursor = this.cursor % this.duration;
        } else {
          this.cursor = this.duration;
          this.pause();
        }
      }
      this.emit("cursor", this.cursor);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    this.emit("state");
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.emit("state");
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(time) {
    this.cursor = Math.max(0, Math.min(this.duration, time));
    this.emit("cursor", this.cursor);
  }

  setRate(rate) {
    this.rate = rate;
    this.emit("state");
  }
}
