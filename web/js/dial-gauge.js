import { cssVar, fitCanvas, fmtNum } from "./util.js";

const START = (Math.PI * 3) / 4;
const SWEEP = (Math.PI * 3) / 2;

function point(cx, cy, radius, angle) {
  return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
}

/** A classic, needle-driven automotive instrument dial. */
export class DialGauge {
  constructor(canvas, {
    label,
    unit,
    colorVar,
    majorStep,
    redlineValue = null,
    tickLabel = (v) => fmtNum(v, 0),
    valueLabel = (v) => fmtNum(v, 0),
  }) {
    Object.assign(this, { canvas, label, unit, colorVar, majorStep, redlineValue, tickLabel, valueLabel });
    this.max = 100;
    this.value = 0;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setMax(max) {
    this.max = Math.max(this.majorStep, max || this.majorStep);
    this.draw();
  }

  set(value) {
    this.value = value;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.5;
    const r = Math.min(w * 0.47, h * 0.47);
    if (r < 40) return;
    this.#drawFace(ctx, cx, cy, r);
    this.#drawScale(ctx, cx, cy, r);
    this.#drawNeedle(ctx, cx, cy, r);
    this.#drawReadout(ctx, cx, cy, r);
  }

  #drawFace(ctx, cx, cy, r) {
    const face = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.25, r * 0.05, cx, cy, r);
    face.addColorStop(0, "#30343a");
    face.addColorStop(0.72, "#171a1f");
    face.addColorStop(1, "#090b0e");
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(3, r * 0.045);
    ctx.strokeStyle = "#080a0c";
    ctx.stroke();
    ctx.lineWidth = Math.max(1, r * 0.012);
    ctx.strokeStyle = "rgba(255,255,255,.22)";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.955, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = Math.max(3, r * 0.035);
    ctx.strokeStyle = cssVar(this.colorVar);
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.86, START, START + SWEEP);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (this.redlineValue != null) {
      const redStart = START + SWEEP * Math.min(1, this.redlineValue / this.max);
      ctx.lineWidth = Math.max(6, r * 0.075);
      ctx.strokeStyle = cssVar("--status-critical");
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.83, redStart, START + SWEEP);
      ctx.stroke();
    }
  }

  #drawScale(ctx, cx, cy, r) {
    const majorCount = Math.round(this.max / this.majorStep);
    const minorPerMajor = 5;
    const totalMinor = majorCount * minorPerMajor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= totalMinor; i++) {
      const major = i % minorPerMajor === 0;
      const angle = START + SWEEP * (i / totalMinor);
      const outer = point(cx, cy, r * 0.79, angle);
      const inner = point(cx, cy, r * (major ? 0.67 : 0.72), angle);
      ctx.strokeStyle = major ? "rgba(244,247,250,.94)" : "rgba(218,224,230,.62)";
      ctx.lineWidth = major ? Math.max(2, r * 0.018) : Math.max(1, r * 0.009);
      ctx.beginPath();
      ctx.moveTo(...outer);
      ctx.lineTo(...inner);
      ctx.stroke();

      if (major) {
        const value = (i / minorPerMajor) * this.majorStep;
        const pos = point(cx, cy, r * 0.56, angle);
        ctx.fillStyle = "rgba(245,247,250,.92)";
        ctx.font = `600 ${Math.max(10, r * 0.105)}px system-ui, sans-serif`;
        ctx.fillText(this.tickLabel(value), ...pos);
      }
    }
  }

  #drawNeedle(ctx, cx, cy, r) {
    const frac = Math.max(0, Math.min(1, (this.value ?? 0) / this.max));
    const angle = START + SWEEP * frac;
    const tip = point(cx, cy, r * 0.66, angle);
    const tail = point(cx, cy, -r * 0.14, angle);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.7)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
    ctx.strokeStyle = "#ef4b4f";
    ctx.lineWidth = Math.max(3, r * 0.028);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(...tail);
    ctx.lineTo(...tip);
    ctx.stroke();
    ctx.restore();

    const hub = ctx.createRadialGradient(cx - r * 0.03, cy - r * 0.03, 1, cx, cy, r * 0.11);
    hub.addColorStop(0, "#60656c");
    hub.addColorStop(0.55, "#30343a");
    hub.addColorStop(1, "#111419");
    ctx.fillStyle = hub;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.16)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  #drawReadout(ctx, cx, cy, r) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(156,255,118,.76)";
    ctx.font = `600 ${Math.max(9, r * 0.09)}px system-ui, sans-serif`;
    ctx.fillText(this.label.toUpperCase(), cx, cy - r * 0.31);
    ctx.fillStyle = "rgba(156,255,118,.68)";
    ctx.font = `${Math.max(8, r * 0.075)}px system-ui, sans-serif`;
    ctx.fillText(this.unit, cx, cy + r * 0.28);

    const boxW = r * 0.72;
    const boxH = r * 0.19;
    const boxY = cy + r * 0.43;
    ctx.fillStyle = "rgba(2,4,5,.82)";
    ctx.fillRect(cx - boxW / 2, boxY - boxH / 2, boxW, boxH);
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.strokeRect(cx - boxW / 2, boxY - boxH / 2, boxW, boxH);
    ctx.fillStyle = "#9cff76";
    ctx.shadowColor = "rgba(109,255,78,.48)";
    ctx.shadowBlur = 7;
    ctx.font = `600 ${Math.max(10, r * 0.115)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillText(this.value == null ? "–" : this.valueLabel(this.value), cx, boxY + 1);
    ctx.shadowBlur = 0;
  }
}
