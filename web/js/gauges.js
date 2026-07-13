// Instrument cluster coordinator: dials, gear, pedal meters and steering.

import { DialGauge } from "./dial-gauge.js";

export class GaugeCluster {
  constructor(root) {
    this.root = root;
    this.speedGauge = new DialGauge(root.querySelector("#gauge-speed"), {
      label: "Speed",
      unit: "km/h",
      colorVar: "--series-1",
      majorStep: 20,
    });
    this.rpmGauge = new DialGauge(root.querySelector("#gauge-rpm"), {
      label: "Engine",
      unit: "×1000 r/min",
      colorVar: "--series-8",
      majorStep: 1000,
      redlineValue: 6500,
      tickLabel: (v) => `${v / 1000}`,
      valueLabel: (v) => Math.round(v).toLocaleString("en-US"),
    });
    this.gearValue = root.querySelector("#gear-value");
    this.shiftLamp = root.querySelector("#shift-lamp");
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
    this.speedGauge.setMax(Math.max(140, Math.ceil(speedMax / 20) * 20));
    const rpmMeta = colMeta("rpm");
    const rpmMax = rpmMeta?.max ?? 8000;
    this.rpmGauge.setMax(Math.max(8000, Math.ceil(rpmMax / 1000) * 1000));
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
    this.shiftLamp.hidden = !(snap.shift_in_process > 0.5);
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
