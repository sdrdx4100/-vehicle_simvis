// Shared helpers: theme tokens for canvas, formatting, binary search.

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Fixed role -> categorical slot assignment. Color follows the entity:
// a role keeps its hue no matter which charts are visible.
export const ROLE_COLORS = {
  speed: "--series-1",
  accel_x: "--series-2",
  gear: "--series-3",
  throttle: "--series-4",
  steering: "--series-5",
  brake: "--series-6",
  accel_y: "--series-7",
  rpm: "--series-8",
  yaw: "--series-5",
  yaw_rate: "--series-2",
  altitude: "--series-2",
};

export const ROLE_LABELS = {
  speed: "Speed", rpm: "RPM", gear: "Gear", throttle: "Throttle",
  brake: "Brake", steering: "Steering", accel_x: "Long G", accel_y: "Lat G",
  accel_z: "Vert G", yaw: "Heading", yaw_rate: "Yaw rate", altitude: "Altitude",
};

export function fmtTime(s) {
  if (!isFinite(s)) return "0:00.0";
  const sign = s < 0 ? "-" : "";
  const tenths = Math.round(Math.abs(s) * 10); // avoid the 59.96 -> "60.0" carry
  const m = Math.floor(tenths / 600);
  const sec = (tenths % 600) / 10;
  return `${sign}${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

export function fmtNum(v, digits = 1) {
  if (v == null || !isFinite(v)) return "–";
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toLocaleString("en-US");
  if (abs >= 100) return v.toFixed(Math.min(digits, 1));
  return v.toFixed(digits);
}

// Index of the last element <= x in a sorted array (numeric).
export function bisect(arr, x) {
  let lo = 0, hi = arr.length - 1;
  if (x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid; else hi = mid;
  }
  return lo;
}

// Nice rounded tick values covering [min, max].
export function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min || 0];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * mag);
  const step = candidates.find((c) => span / c <= count) || candidates[candidates.length - 1];
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

// HiDPI canvas sizing; returns ctx scaled to CSS pixels.
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(c);
  }
  return node;
}

export class Emitter {
  #handlers = new Map();
  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.#handlers.get(event)?.delete(fn);
  }
  emit(event, payload) {
    this.#handlers.get(event)?.forEach((fn) => fn(payload));
  }
}
