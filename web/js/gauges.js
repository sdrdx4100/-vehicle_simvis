// Instrument cluster: arc gauges (speed, rpm), gear tile, pedal meters,
// steering indicator. Meter fills carry the value; tracks are a lighter
// step of the same hue so state reads across the whole bar.

import { cssVar, fitCanvas, fmtNum } from "./util.js";

const ARC_START = (Math.PI * 3) / 4;       // 135°
const ARC_SWEEP = (Math.PI * 3) / 2;       // 270°

class ArcGauge {
  constructor(canvas, { label, unit, colorVar, redlineFrac = null, fmt = (v) => fmtNum(v, 0) }) {
    this.canvas = canvas;
    this.label = label;
    this.unit = unit;
    this.colorVar = colorVar;
    this.redlineFrac = redlineFrac;
    this.fmt = fmt;
    this.max = 100;
    this.value = 0;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setMax(max) { this.max = max || 1; }
  set(value) { this.value = value; this.draw(); }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.58;
    const r = Math.min(w, h * 1.1) / 2 - 8;
    if (r < 20) return;
    const accent = cssVar(this.colorVar);
    const frac = Math.max(0, Math.min(1, (this.value ?? 0) / this.max));

    // Track: lighter step of the same hue.
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.strokeStyle = cssVar("--ghost");
    ctx.beginPath();
    ctx.arc(cx, cy, r, ARC_START, ARC_START + ARC_SWEEP);
    ctx.stroke();

    // Redline zone marker on the track (rpm).
    if (this.redlineFrac != null) {
      ctx.strokeStyle = cssVar("--status-critical");
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(cx, cy, r, ARC_START + ARC_SWEEP * this.redlineFrac, ARC_START + ARC_SWEEP);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Value arc.
    if (frac > 0.002) {
      ctx.strokeStyle =
        this.redlineFrac != null && frac >= this.redlineFrac ? cssVar("--status-critical") : accent;
      ctx.beginPath();
      ctx.arc(cx, cy, r, ARC_START, ARC_START + ARC_SWEEP * frac);
      ctx.stroke();
    }

    // Label on top, value + unit in the middle, max scale at the arc gap.
    // Text wears text tokens, never the series color.
    ctx.textAlign = "center";
    ctx.fillStyle = cssVar("--text-secondary");
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(this.label, cx, 12);
    ctx.fillStyle = cssVar("--text-primary");
    ctx.font = `600 ${Math.max(17, r * 0.4)}px system-ui, sans-serif`;
    ctx.fillText(this.value == null ? "–" : this.fmt(this.value), cx, cy + 5);
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(this.unit, cx, cy + 21);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(`0 – ${Math.round(this.max).toLocaleString("en-US")}`, cx, h - 4);
  }
}

export class GaugeCluster {
  constructor(root) {
    this.root = root;
    this.speedGauge = new ArcGauge(root.querySelector("#gauge-speed"), {
      label: "Speed", unit: "km/h", colorVar: "--series-1",
    });
    this.rpmGauge = new ArcGauge(root.querySelector("#gauge-rpm"), {
      label: "Engine", unit: "rpm", colorVar: "--series-8", redlineFrac: 0.88,
      fmt: (v) => `${(v / 1000).toFixed(1)}k`,
    });
    this.gearValue = root.querySelector("#gear-value");
    this.timeValue = root.querySelector("#lap-time");
    this.throttleFill = root.querySelector(".meter.throttle .fillbar");
    this.throttleVal = root.querySelector(".meter.throttle b");
    this.brakeFill = root.querySelector(".meter.brake .fillbar");
    this.brakeVal = root.querySelector(".meter.brake b");
    this.steerIcon = root.querySelector("#steer-icon");
    this.steerVal = root.querySelector("#steer-val");
  }

  configure(columnsMeta, mapping) {
    const colMeta = (role) => columnsMeta.find((c) => c.name === mapping[role]);
    const speedMeta = colMeta("speed");
    const speedMax = speedMeta?.max ?? 100;
    this.speedGauge.setMax(Math.ceil(speedMax / 20) * 20);
    const rpmMeta = colMeta("rpm");
    const rpmMax = rpmMeta?.max ?? 8000;
    this.rpmGauge.setMax(Math.ceil(rpmMax / 500) * 500);
    // J1939 SPN 1807 is radians; display in degrees either way.
    this.steerScale = colMeta("steering")?.unit === "rad" ? 180 / Math.PI : 1;
    this.available = {
      speed: !!speedMeta, rpm: !!rpmMeta,
      gear: !!colMeta("gear"), throttle: !!colMeta("throttle"),
      brake: !!colMeta("brake"), steering: !!colMeta("steering"),
    };
  }

  update(snap, cursorTime, fmtTime) {
    this.speedGauge.set(snap.speed ?? null);
    this.rpmGauge.set(snap.rpm ?? null);
    this.gearValue.textContent = snap.gear == null ? "–" : `${Math.round(snap.gear)}`;
    this.timeValue.textContent = fmtTime(cursorTime);

    const thr = snap.throttle;
    this.throttleFill.style.width = `${Math.max(0, Math.min(100, thr ?? 0))}%`;
    this.throttleVal.textContent = thr == null ? "–" : `${Math.round(thr)}%`;
    const brk = snap.brake;
    this.brakeFill.style.width = `${Math.max(0, Math.min(100, brk ?? 0))}%`;
    this.brakeVal.textContent = brk == null ? "–" : `${Math.round(brk)}%`;

    const steer = snap.steering == null ? null : snap.steering * (this.steerScale ?? 1);
    this.steerIcon.style.transform = `rotate(${steer ?? 0}deg)`;
    this.steerVal.textContent = steer == null ? "–" : `${steer.toFixed(0)}°`;
  }

  redraw() {
    this.speedGauge.draw();
    this.rpmGauge.draw();
  }
}
