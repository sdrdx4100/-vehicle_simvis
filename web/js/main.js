// simvis frontend bootstrap: wiring between API, playback engine and views.

import { api } from "./api.js";
import { Player } from "./player.js";
import { Tooltip } from "./tooltip.js";
import { TrackMap } from "./trackmap.js";
import { GGDiagram } from "./gg.js";
import { GaugeCluster } from "./gauges.js";
import { ChartSync, TimeChart } from "./charts.js";
import { Timeline } from "./timeline.js";
import { TableView } from "./table.js";
import { ShiftPanel } from "./shiftpanel.js";
import { VehicleView } from "./vehicleview.js";
import { SignalMappingDialog } from "./signal-mapping.js";
import { el, fmtTime, ROLE_COLORS, ROLE_LABELS } from "./util.js";

const $ = (sel) => document.querySelector(sel);

const tooltip = new Tooltip();
const player = new Player();
const sync = new ChartSync(tooltip);
const trackMap = new TrackMap($("#map-canvas"), tooltip);
const gg = new GGDiagram($("#gg-canvas"));
const gauges = new GaugeCluster(document.body);
const timeline = new Timeline($("#timeline"), player);
const tableView = new TableView($("#table-view"));
const shiftPanel = new ShiftPanel(
  $("#shift-card"),
  (t) => player.seek(t),
  (index) => api.shiftDetail(current.id, index),
);
const vehicleView = new VehicleView($("#vehicle-strip"));

let datasets = [];
let current = null;      // dataset summary
let extraChannels = [];  // extra column names shown as charts
let charts = [];

const mappingDialog = new SignalMappingDialog(
  $("#mapping-dialog"),
  $("#mapping-btn"),
  api,
  async (updated) => {
    setCurrent(updated);
    await loadPlayback();
  },
);

sync.onSeek = (t) => player.seek(t);
trackMap.onSeek = (t) => player.seek(t);

// ---------------- theme ----------------

const themeBtn = $("#theme-btn");
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("simvis-theme", next);
  redrawAll();
});
const savedTheme = localStorage.getItem("simvis-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => redrawAll());

function redrawAll() {
  trackMap.draw();
  gg.draw();
  gauges.redraw();
  timeline.draw();
  shiftPanel.drawDetail();
  for (const c of charts) c.draw();
}

// ---------------- dataset loading ----------------

async function refreshList(selectId = null) {
  const res = await api.listDatasets();
  datasets = res.datasets.filter((d) => !d.error);
  const select = $("#dataset-select");
  select.textContent = "";
  for (const d of datasets) {
    const opt = el("option", { value: d.id });
    opt.textContent = `${d.name}  (${d.rows.toLocaleString()} rows, ${fmtTime(d.duration)})`;
    select.append(opt);
  }
  $("#empty-state").classList.toggle("hidden", datasets.length > 0);
  $("#dashboard").style.display = datasets.length ? "" : "none";
  if (datasets.length) {
    const id = selectId && datasets.some((d) => d.id === selectId) ? selectId : datasets[0].id;
    select.value = id;
    await selectDataset(id);
  }
}

async function selectDataset(id) {
  const selected = datasets.find((d) => d.id === id);
  if (!selected) return;
  const restored = await mappingDialog.restore(selected);
  setCurrent(restored);
  extraChannels = [];
  await loadPlayback();
  tableView.setDataset(id);
}

function setCurrent(dataset) {
  current = dataset;
  const index = datasets.findIndex((d) => d.id === dataset.id);
  if (index >= 0) datasets[index] = dataset;
  mappingDialog.setDataset(dataset);
  $("#dataset-meta").textContent =
    `${(current.sizeBytes / 1024 / 1024).toFixed(1)} MB · ${current.sampleRate} Hz · ${Object.keys(current.mapping).length} mapped channels`;
}

async function loadPlayback() {
  const payload = await api.playback(current.id, extraChannels);
  const roleUnits = {};
  for (const [role, col] of Object.entries(current.mapping)) {
    roleUnits[role] = current.columns.find((c) => c.name === col)?.unit || "";
  }
  player.load(payload);
  trackMap.setData(payload, roleUnits);
  gg.setData(payload, roleUnits);
  vehicleView.setData(payload, roleUnits);
  // No position channels -> drop the map card instead of showing a large
  // empty canvas; the other left-column cards absorb the space.
  $("#map-card").classList.toggle("hidden", !trackMap.hasData);
  $("#map-card").parentElement.classList.toggle("no-map", !trackMap.hasData);
  gauges.configure(current.columns, current.mapping);
  buildChannelBar();
  buildCharts(payload);
  sync.setWindow(null);
  updateFrame(0);
  loadShifts();
}

async function loadShifts() {
  try {
    const data = await api.shifts(current.id);
    shiftPanel.render(data);
    const times = (data.events || []).map((e) => e.tStart);
    charts[0]?.setMarkers(times); // ticks on the speed chart (first card)
  } catch (err) {
    shiftPanel.render({ events: [], note: `Shift analysis failed: ${err.message}` });
  }
}

// ---------------- charts ----------------

const CHART_GROUPS = [
  { roles: ["speed"], unit: "km/h" },
  { roles: ["rpm"], unit: "rpm" },
  { roles: ["throttle", "brake"], unit: "%", title: "Pedals" },
  { roles: ["steering"], unit: "deg", symmetric: true },
  { roles: ["accel_x", "accel_y"], unit: "G", title: "Acceleration", symmetric: true },
  { roles: ["yaw_rate"], unit: "", symmetric: true },
  { roles: ["gear"], unit: "", step: true },
];

function chartCard(title, seriesDefs) {
  const legend = el("div", { class: "legend" });
  if (seriesDefs.length >= 2) {
    for (const s of seriesDefs) {
      const key = el("i", {});
      key.style.borderTopColor = `var(${s.color})`;
      const item = el("span", { class: "key" }, key);
      const label = el("span", {});
      label.textContent = s.label;
      item.append(label);
      legend.append(item);
    }
  }
  const h2 = el("h2", {});
  const titleSpan = el("span", {});
  titleSpan.textContent = title;
  h2.append(titleSpan, legend);
  const canvas = el("canvas", {});
  const card = el("div", { class: "card chart-card" }, h2, canvas);
  return { card, canvas };
}

function buildCharts(payload) {
  const container = $("#charts");
  container.textContent = "";
  for (const c of charts) sync.remove(c);
  charts = [];

  const unitOf = (colName, fallback) => {
    const meta = current.columns.find((c) => c.name === colName);
    return meta?.unit || fallback || "";
  };

  for (const group of CHART_GROUPS) {
    const seriesDefs = [];
    for (const role of group.roles) {
      if (!payload.series[role]) continue;
      seriesDefs.push({
        key: role,
        label: ROLE_LABELS[role] || role,
        color: ROLE_COLORS[role] || "--series-1",
        unit: unitOf(current.mapping[role], group.unit),
        values: payload.series[role],
        step: group.step,
      });
    }
    if (!seriesDefs.length) continue;
    const title = group.title || seriesDefs[0].label;
    addChart(title, seriesDefs, group, payload.t, container);
  }

  // Extra (unmapped) channels — each its own single-series chart, slot 1.
  for (const col of extraChannels) {
    const values = payload.series[`col:${col}`];
    if (!values) continue;
    addChart(col, [{ key: `col:${col}`, label: col, color: "--series-1", unit: unitOf(col, ""), values }],
      {}, payload.t, container);
  }
}

function addChart(title, seriesDefs, group, t, container) {
  const { card, canvas } = chartCard(title, seriesDefs);
  container.append(card);
  const chart = new TimeChart(canvas, {
    series: seriesDefs,
    yUnit: group.unit || "",
    symmetric: !!group.symmetric,
  });
  sync.add(chart);
  chart.setData(t);
  chart.setCursor(player.cursor);
  charts.push(chart);
}

// ---------------- channel picker ----------------

function buildChannelBar() {
  const bar = $("#channel-bar");
  bar.textContent = "";
  const mapped = new Set(Object.values(current.mapping));
  const candidates = current.columns.filter((c) => c.numeric && !mapped.has(c.name));
  if (!candidates.length) return;
  const label = el("span", { class: "meta", style: "color:var(--text-muted);font-size:11px" });
  label.textContent = "channels:";
  bar.append(label);
  for (const c of candidates) {
    const active = extraChannels.includes(c.name);
    const chip = el("button", { class: "chip", "aria-pressed": String(active) });
    chip.textContent = c.name;
    chip.addEventListener("click", async () => {
      if (extraChannels.includes(c.name)) {
        extraChannels = extraChannels.filter((n) => n !== c.name);
      } else {
        extraChannels.push(c.name);
      }
      await loadPlayback();
    });
    bar.append(chip);
  }
}

// ---------------- playback wiring ----------------

function updateFrame(time) {
  const snap = player.snapshot(time);
  gauges.update(snap, time, fmtTime);
  trackMap.setCursor(time);
  gg.setCursor(time);
  vehicleView.setCursor(time);
  sync.cursor(time);
  const readout = $("#time-readout");
  readout.textContent = "";
  const cur = el("b", {});
  cur.textContent = fmtTime(time);
  readout.append(cur, ` / ${fmtTime(player.duration)}`);
}

player.on("cursor", (time) => updateFrame(time));
player.on("state", () => {
  $("#play-btn").textContent = player.playing ? "⏸" : "▶";
  $("#play-btn").setAttribute("aria-label", player.playing ? "Pause" : "Play");
});

$("#play-btn").addEventListener("click", () => player.toggle());
$("#back-btn").addEventListener("click", () => player.seek(player.cursor - 10));
$("#fwd-btn").addEventListener("click", () => player.seek(player.cursor + 10));
$("#rate-select").addEventListener("change", (e) => player.setRate(parseFloat(e.target.value)));
$("#loop-btn").addEventListener("click", (e) => {
  player.loop = !player.loop;
  e.target.setAttribute("aria-pressed", String(player.loop));
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.code === "Space") { player.toggle(); e.preventDefault(); }
  if (e.key === "ArrowRight") { player.seek(player.cursor + (e.shiftKey ? 1 : 5)); e.preventDefault(); }
  if (e.key === "ArrowLeft") { player.seek(player.cursor - (e.shiftKey ? 1 : 5)); e.preventDefault(); }
});

// ---------------- header actions ----------------

$("#dataset-select").addEventListener("change", (e) => selectDataset(e.target.value));

$("#upload-btn").addEventListener("click", () => $("#upload-input").click());
$("#upload-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const ds = await api.upload(file);
    await refreshList(ds.id);
  } catch (err) {
    alert(`Upload failed: ${err.message}`);
  }
  e.target.value = "";
});

// Drag & drop upload
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.name.endsWith(".parquet"));
  if (!file) return;
  try {
    const ds = await api.upload(file);
    await refreshList(ds.id);
  } catch (err) {
    alert(`Upload failed: ${err.message}`);
  }
});

async function makeDemo() {
  const btns = [$("#demo-btn"), $("#empty-demo-btn")];
  btns.forEach((b) => (b.disabled = true));
  try {
    await api.makeDemo();
    await refreshList();
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}
$("#demo-btn").addEventListener("click", makeDemo);
$("#empty-demo-btn").addEventListener("click", makeDemo);

// ---------------- view toggle ----------------

function setView(view) {
  const dash = view === "dash";
  $("#dashboard").style.display = dash && datasets.length ? "" : "none";
  $("#table-view").style.display = dash ? "none" : "flex";
  $("#view-dash").setAttribute("aria-pressed", String(dash));
  $("#view-table").setAttribute("aria-pressed", String(!dash));
  if (!dash) tableView.load();
}
$("#view-dash").addEventListener("click", () => setView("dash"));
$("#view-table").addEventListener("click", () => setView("table"));

// ---------------- boot ----------------

refreshList().catch((err) => {
  const empty = $("#empty-state");
  empty.classList.remove("hidden");
  empty.textContent = `Failed to load datasets: ${err.message}`;
  $("#dashboard").style.display = "none";
});
