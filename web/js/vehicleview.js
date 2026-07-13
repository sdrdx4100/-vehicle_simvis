// Side-view vehicle strip: a hand-drawn SVG truck that "drives" in sync
// with playback. Wheels rotate with integrated travel distance, the road
// dashes scroll at vehicle speed, and the body pitches with longitudinal
// acceleration (nose up under power, dive under braking). Needs only a
// speed channel, so it works on logs without GPS.

import { bisect, toG } from "./util.js";

const WHEEL_DEG_PER_M = 28;   // stylized wheel rotation
const DASH_PX_PER_M = 2.2;    // road-line scroll
const DASH_PERIOD = 34;       // dasharray 16+18
const PITCH_PER_G = 3.2;      // deg of body pitch per longitudinal G
const MAX_PITCH = 5;

export const TRUCK_SVG = `
<svg viewBox="0 0 300 96" width="100%" height="100%" role="img" aria-label="Cute side view of a truck driving">
  <defs>
    <linearGradient id="vv-box-gradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--series-1)" stop-opacity=".78"/>
      <stop offset="1" stop-color="var(--series-1)" stop-opacity=".28"/>
    </linearGradient>
  </defs>
  <line x1="0" y1="80.5" x2="300" y2="80.5" stroke="var(--axis)" stroke-width="1"/>
  <line id="vv-dashes" x1="0" y1="87" x2="300" y2="87"
        stroke="var(--grid)" stroke-width="3" stroke-dasharray="16 18"/>
  <g id="vv-truck" transform="translate(52 0)">
    <g class="vv-smoke" fill="var(--text-muted)">
      <circle cx="113" cy="10" r="3" opacity=".36"/>
      <circle cx="108" cy="5" r="2.2" opacity=".22"/>
    </g>
    <g id="vv-body">
      <!-- exhaust stack -->
      <rect x="112" y="14" width="5" height="22" rx="2" fill="var(--text-muted)"/>
      <!-- cargo box -->
      <rect x="8" y="18" width="102" height="40" rx="8"
            fill="url(#vv-box-gradient)" stroke="var(--series-1)" stroke-width="1.5"/>
      <text x="59" y="42" text-anchor="middle" fill="var(--text-primary)"
            font-family="system-ui, sans-serif" font-size="10" font-weight="700" letter-spacing="1.5">SIMVIS</text>
      <!-- chassis -->
      <rect x="8" y="56" width="164" height="7" rx="2" fill="var(--text-secondary)"/>
      <!-- cab -->
      <path d="M118 62 V32 q0 -4 4 -4 h28 q4 0 6 3 l12 18 q2 3 2 6 v7 z" fill="var(--series-1)"/>
      <!-- windshield -->
      <path d="M140 33 h9 q2 0 3.4 1.8 L162 48 h-22 z" fill="var(--seq-150)"/>
      <path d="M123 34 h13 v23 h-13" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1"/>
      <rect x="129" y="45" width="4" height="1.5" rx=".7" fill="rgba(255,255,255,.7)"/>
      <!-- bumper + headlight -->
      <rect x="164" y="58" width="8" height="9" rx="2" fill="var(--text-secondary)"/>
      <circle cx="168" cy="52" r="2.4" fill="var(--series-3)"/>
    </g>
    <g class="vv-wheel" data-cx="34">
      <circle cx="34" cy="69" r="11.5" fill="var(--text-primary)"/>
      <circle cx="34" cy="69" r="6" fill="var(--surface-1)"/>
      <g class="vv-spokes">
        <line x1="34" y1="63.6" x2="34" y2="74.4" stroke="var(--text-primary)" stroke-width="2"/>
        <line x1="28.6" y1="69" x2="39.4" y2="69" stroke="var(--text-primary)" stroke-width="2"/>
      </g>
    </g>
    <g class="vv-wheel" data-cx="62">
      <circle cx="62" cy="69" r="11.5" fill="var(--text-primary)"/>
      <circle cx="62" cy="69" r="6" fill="var(--surface-1)"/>
      <g class="vv-spokes">
        <line x1="62" y1="63.6" x2="62" y2="74.4" stroke="var(--text-primary)" stroke-width="2"/>
        <line x1="56.6" y1="69" x2="67.4" y2="69" stroke="var(--text-primary)" stroke-width="2"/>
      </g>
    </g>
    <g class="vv-wheel" data-cx="146">
      <circle cx="146" cy="69" r="11.5" fill="var(--text-primary)"/>
      <circle cx="146" cy="69" r="6" fill="var(--surface-1)"/>
      <g class="vv-spokes">
        <line x1="146" y1="63.6" x2="146" y2="74.4" stroke="var(--text-primary)" stroke-width="2"/>
        <line x1="140.6" y1="69" x2="151.4" y2="69" stroke="var(--text-primary)" stroke-width="2"/>
      </g>
    </g>
  </g>
</svg>`;

export class VehicleView {
  constructor(container) {
    container.innerHTML = TRUCK_SVG;
    this.dashes = container.querySelector("#vv-dashes");
    this.body = container.querySelector("#vv-body");
    this.wheels = [...container.querySelectorAll(".vv-wheel")].map((g) => ({
      spokes: g.querySelector(".vv-spokes"),
      cx: parseFloat(g.dataset.cx),
    }));
    this.t = [];
    this.dist = [];
    this.accel = null;
    this.accelUnit = "";
  }

  setData(payload, units = {}) {
    this.t = payload.t;
    this.accel = payload.series.accel_x || null;
    this.accelUnit = units.accel_x || "";
    const speed = payload.series.speed;
    const toMps = { "km/h": 1 / 3.6, kmh: 1 / 3.6, mph: 0.44704, "m/s": 1 }[units.speed] ?? 1 / 3.6;
    // Cumulative travel distance (m) so wheels/road stay exact across seeks.
    this.dist = new Array(this.t.length).fill(0);
    if (speed) {
      for (let i = 1; i < this.t.length; i++) {
        const v0 = (speed[i - 1] ?? 0) * toMps;
        const v1 = (speed[i] ?? 0) * toMps;
        this.dist[i] = this.dist[i - 1] + ((v0 + v1) / 2) * (this.t[i] - this.t[i - 1]);
      }
    }
    this.setCursor(0);
  }

  setCursor(time) {
    if (!this.t.length) return;
    const i = bisect(this.t, time);
    let d = this.dist[i];
    if (i < this.t.length - 1) {
      const f = (time - this.t[i]) / (this.t[i + 1] - this.t[i] || 1);
      d += (this.dist[i + 1] - this.dist[i]) * Math.max(0, Math.min(1, f));
    }
    const wheelDeg = (d * WHEEL_DEG_PER_M) % 360;
    for (const w of this.wheels) {
      w.spokes.setAttribute("transform", `rotate(${wheelDeg} ${w.cx} 69)`);
    }
    this.dashes.setAttribute("stroke-dashoffset", `${-((d * DASH_PX_PER_M) % DASH_PERIOD)}`);

    let pitch = 0;
    if (this.accel && this.accel[i] != null) {
      const g = toG(this.accel[i], this.accelUnit);
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, -g * PITCH_PER_G));
    }
    this.body.setAttribute("transform", `rotate(${pitch.toFixed(2)} 90 63)`);
  }
}
