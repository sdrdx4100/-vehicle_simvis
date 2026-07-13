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
      <circle cx="114" cy="10" r="3" opacity=".36"/>
      <circle cx="109" cy="5" r="2.2" opacity=".22"/>
    </g>
    <g id="vv-body">
      <!-- exhaust stack behind the cab -->
      <rect x="113" y="15" width="5" height="21" rx="2" fill="var(--text-muted)"/>
      <!-- cargo box -->
      <rect x="8" y="14" width="104" height="44" rx="6"
            fill="url(#vv-box-gradient)" stroke="var(--series-1)" stroke-width="1.5"/>
      <text x="60" y="40" text-anchor="middle" fill="var(--text-primary)"
            font-family="system-ui, sans-serif" font-size="10" font-weight="700" letter-spacing="1.5">SIMVIS</text>
      <!-- chassis -->
      <rect x="8" y="56" width="160" height="7" rx="2" fill="var(--text-secondary)"/>
      <!-- fuel tank -->
      <rect x="86" y="63" width="26" height="8" rx="4" fill="var(--text-muted)"/>
      <!-- cab-over cab: flat vertical front, high roof -->
      <path d="M120 62 V20 q0 -3 3 -3 h41 q4 0 4 4 v41 z" fill="var(--series-1)"/>
      <!-- roof air deflector (rises toward the box) -->
      <path d="M123 17 L127 9.5 q1 -1.7 3 -1.7 h21 L164 17 z" fill="var(--series-1)" opacity=".85"/>
      <!-- windshield: thin raked sliver on the flat front -->
      <path d="M168 21 v21 l-4.5 2 V22.5 z" fill="var(--seq-150)"/>
      <!-- side window -->
      <path d="M141 22 h18 q3 0 3 3 v14 h-21 z" fill="var(--seq-150)"/>
      <!-- door seam + handle -->
      <line x1="138.5" y1="22" x2="138.5" y2="58" stroke="rgba(255,255,255,.35)" stroke-width="1"/>
      <rect x="142" y="44" width="6" height="2" rx="1" fill="rgba(255,255,255,.7)"/>
      <!-- mirror on a forward arm -->
      <path d="M166 22 l9 -2.5" stroke="var(--text-secondary)" stroke-width="1.5" fill="none"/>
      <rect x="173.5" y="19" width="3.5" height="11" rx="1.5" fill="var(--text-secondary)"/>
      <!-- cab entry step -->
      <rect x="141" y="60" width="13" height="3" rx="1" fill="var(--text-secondary)"/>
      <!-- bumper + headlight -->
      <rect x="161" y="58" width="10" height="9" rx="2" fill="var(--text-secondary)"/>
      <circle cx="166.5" cy="54" r="2.2" fill="var(--series-3)"/>
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
    <g class="vv-wheel" data-cx="144">
      <circle cx="144" cy="69" r="11.5" fill="var(--text-primary)"/>
      <circle cx="144" cy="69" r="6" fill="var(--surface-1)"/>
      <g class="vv-spokes">
        <line x1="144" y1="63.6" x2="144" y2="74.4" stroke="var(--text-primary)" stroke-width="2"/>
        <line x1="138.6" y1="69" x2="149.4" y2="69" stroke="var(--text-primary)" stroke-width="2"/>
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
    // Positive dashoffset shifts the pattern toward the path start (left),
    // which is how the road must flow under a truck driving to the right.
    this.dashes.setAttribute("stroke-dashoffset", `${(d * DASH_PX_PER_M) % DASH_PERIOD}`);

    let pitch = 0;
    if (this.accel && this.accel[i] != null) {
      const g = toG(this.accel[i], this.accelUnit);
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, -g * PITCH_PER_G));
    }
    this.body.setAttribute("transform", `rotate(${pitch.toFixed(2)} 90 63)`);
  }
}
