"""Gearshift event extraction and shift-shock analysis.

Shift windows come from TransmissionShiftInProcess (SPN 574) when it is
available, with gear transitions used as a fallback.  Shock metrics are based
on a lightly smoothed longitudinal acceleration signal so a single noisy
sample does not dominate the result.
"""

from __future__ import annotations

import math

import numpy as np

from .datasets import Dataset

G = 9.80665
SMOOTH_MAX = 10.0
MODERATE_MAX = 25.0
MAX_SHIFT_S = 3.0
SETTLE_S = 0.25
DETAIL_MARGIN_S = 0.6
SMOOTH_WINDOW_S = 0.10


def _channel(ds: Dataset, role: str):
    col = ds.mapping.get(role)
    return ds.channels.get(col) if col else None


def _unit_of(ds: Dataset, role: str) -> str:
    col = ds.mapping.get(role)
    if not col:
        return ""
    for meta in ds.columns:
        if meta["name"] == col:
            return meta.get("unit", "")
    return ""


def _finite(values: np.ndarray) -> np.ndarray:
    """Interpolate non-finite samples without changing array length."""
    values = np.asarray(values, dtype=np.float64)
    ok = np.isfinite(values)
    if ok.all():
        return values.copy()
    if not ok.any():
        return np.zeros_like(values)
    x = np.arange(values.size)
    return np.interp(x, x[ok], values[ok])


def _smooth(values: np.ndarray, t: np.ndarray, window_s: float = SMOOTH_WINDOW_S) -> np.ndarray:
    values = _finite(values)
    if values.size < 3:
        return values
    dt = np.diff(t)
    dt = dt[np.isfinite(dt) & (dt > 0)]
    if not dt.size:
        return values
    samples = max(3, int(round(window_s / float(np.median(dt)))))
    samples += samples % 2 == 0
    samples = min(samples, values.size if values.size % 2 else values.size - 1)
    if samples < 3:
        return values
    pad = samples // 2
    kernel = np.ones(samples, dtype=np.float64) / samples
    return np.convolve(np.pad(values, pad, mode="edge"), kernel, mode="valid")


def _gradient(values: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Gradient that remains finite when a log contains duplicate timestamps."""
    if values.size < 2:
        return np.zeros_like(values)
    dt = np.gradient(t)
    positive = dt[np.isfinite(dt) & (dt > 0)]
    fallback = float(np.median(positive)) if positive.size else 1.0
    dt = np.where(np.isfinite(dt) & (dt > 1e-9), dt, fallback)
    return np.gradient(values) / dt


def _accel_mps2(ds: Dataset) -> tuple[np.ndarray | None, str]:
    accel = _channel(ds, "accel_x")
    if accel is not None:
        unit = _unit_of(ds, "accel_x").lower()
        return (accel * G if unit == "g" else accel), "sensor"
    speed = _channel(ds, "speed")
    if speed is None or ds.time.size < 3:
        return None, "unavailable"
    unit = _unit_of(ds, "speed").lower()
    to_mps = {"km/h": 1 / 3.6, "kmh": 1 / 3.6, "mph": 0.44704, "m/s": 1.0}.get(unit, 1 / 3.6)
    return _gradient(_finite(speed) * to_mps, ds.time), "derived_speed"


def _flag_windows(t: np.ndarray, flag: np.ndarray) -> list[tuple[int, int]]:
    on = np.nan_to_num(flag, nan=0.0) > 0.5
    edges = np.flatnonzero(np.diff(on.astype(np.int8)))
    windows = []
    start = 0 if on[0] else None
    for e in edges:
        if on[e + 1] and start is None:
            start = e + 1
        elif not on[e + 1] and start is not None:
            windows.append((start, e))
            start = None
    if start is not None:
        windows.append((start, len(on) - 1))
    return [(a, b) for a, b in windows if b > a and t[b] - t[a] <= MAX_SHIFT_S]


def _gear_windows(t: np.ndarray, gear: np.ndarray) -> list[tuple[int, int]]:
    changes = np.flatnonzero(np.diff(np.nan_to_num(gear, nan=-1)) != 0) + 1
    windows = []
    for i in changes:
        a = int(np.searchsorted(t, t[i] - 0.15))
        b = int(np.searchsorted(t, t[i] + 0.25))
        windows.append((max(0, a), min(len(t) - 1, b)))
    return windows


def _windows(ds: Dataset) -> tuple[list[tuple[int, int]], str | None]:
    flag = _channel(ds, "shift_in_process")
    gear = _channel(ds, "gear")
    if flag is not None:
        return _flag_windows(ds.time, flag), "shift_in_process"
    if gear is not None:
        return _gear_windows(ds.time, gear), "gear"
    return [], None


def _severity(peak_jerk: float) -> str:
    if peak_jerk < SMOOTH_MAX:
        return "smooth"
    if peak_jerk < MODERATE_MAX:
        return "moderate"
    return "harsh"


def _event_base(ds: Dataset, a: int, b: int) -> dict:
    t, gear, speed = ds.time, _channel(ds, "gear"), _channel(ds, "speed")
    ev: dict = {
        "tStart": round(float(t[a]), 3),
        "tEnd": round(float(t[b]), 3),
        "durationMs": round(float(t[b] - t[a]) * 1000),
    }
    if gear is not None:
        g_from, g_to = gear[max(0, a - 1)], gear[min(len(gear) - 1, b + 1)]
        if math.isfinite(g_from) and math.isfinite(g_to):
            ev["gearFrom"], ev["gearTo"] = int(round(g_from)), int(round(g_to))
            ev["direction"] = "up" if ev["gearTo"] > ev["gearFrom"] else "down" if ev["gearTo"] < ev["gearFrom"] else "none"
        lo, hi = max(0, a - 1), min(len(gear), b + 2)
        changes = np.flatnonzero(np.diff(np.nan_to_num(gear[lo:hi], nan=-1)) != 0)
        if changes.size:
            gi = lo + int(changes[0]) + 1
            ev["gearChangeMs"] = round(float(t[gi] - t[a]) * 1000)
    if speed is not None:
        v_on, v_off = float(speed[a]), float(speed[b])
        if math.isfinite(v_on) and math.isfinite(v_off):
            ev.update(speedOn=round(v_on, 1), speedOff=round(v_off, 1), deltaV=round(v_off - v_on, 2))
    return ev


def _event_metrics(ev: dict, t: np.ndarray, accel: np.ndarray, jerk: np.ndarray, a: int, b: int) -> None:
    end = min(len(t) - 1, int(np.searchsorted(t, t[b] + SETTLE_S)))
    if end - a < 2:
        return
    acc_seg, jerk_seg = accel[a:end + 1], jerk[a:end + 1]
    finite = np.isfinite(jerk_seg)
    if finite.sum() < 3:
        return
    abs_jerk = np.abs(jerk_seg[finite])
    peak_local = int(np.nanargmax(np.abs(jerk_seg)))
    peak = float(np.max(abs_jerk))
    shock_t = float(t[a + peak_local] - t[a])
    ev.update(
        peakJerk=round(peak, 1),
        jerkP95=round(float(np.percentile(abs_jerk, 95)), 1),
        jerkRms=round(float(np.sqrt(np.mean(np.square(jerk_seg[finite])))), 1),
        accelP2P=round(float(np.nanmax(acc_seg) - np.nanmin(acc_seg)), 3),
        shockTimeMs=round(shock_t * 1000),
        shockPhase="during" if shock_t <= float(t[b] - t[a]) else "settle",
        severity=_severity(peak),
    )


def _analysis(ds: Dataset):
    ds.ensure_loaded()
    windows, source = _windows(ds)
    accel_raw, accel_source = _accel_mps2(ds)
    accel = _smooth(accel_raw, ds.time) if accel_raw is not None else None
    jerk = _gradient(accel, ds.time) if accel is not None else None
    events = []
    for index, (a, b) in enumerate(windows):
        ev = _event_base(ds, a, b)
        ev["index"] = index
        if accel is not None:
            _event_metrics(ev, ds.time, accel, jerk, a, b)
        events.append(ev)
    return windows, source, events, accel_raw, accel, jerk, accel_source


def _transition_stats(events: list[dict]) -> list[dict]:
    groups: dict[tuple[int, int], list[dict]] = {}
    for ev in events:
        if "gearFrom" in ev and "gearTo" in ev:
            groups.setdefault((ev["gearFrom"], ev["gearTo"]), []).append(ev)
    out = []
    for (g0, g1), rows in sorted(groups.items()):
        peaks = [r["peakJerk"] for r in rows if "peakJerk" in r]
        out.append({
            "gearFrom": g0,
            "gearTo": g1,
            "count": len(rows),
            "medianPeakJerk": round(float(np.median(peaks)), 1) if peaks else None,
            "p95PeakJerk": round(float(np.percentile(peaks, 95)), 1) if peaks else None,
            "harshRate": round(100 * sum(r.get("severity") == "harsh" for r in rows) / len(rows), 1),
        })
    return out


def analyze(ds: Dataset) -> dict:
    windows, source, events, _raw, _accel, _jerk, accel_source = _analysis(ds)
    if source is None:
        return {"source": None, "events": [], "summary": None,
                "note": "no shift_in_process flag or gear channel detected"}
    shocks = [e["peakJerk"] for e in events if "peakJerk" in e]
    summary = {
        "count": len(events),
        "upshifts": sum(e.get("direction") == "up" for e in events),
        "downshifts": sum(e.get("direction") == "down" for e in events),
        "meanDurationMs": round(float(np.mean([e["durationMs"] for e in events]))) if events else 0,
        "medianPeakJerk": round(float(np.median(shocks)), 1) if shocks else None,
        "maxPeakJerk": round(float(np.max(shocks)), 1) if shocks else None,
        "harshCount": sum(e.get("severity") == "harsh" for e in events),
    }
    return {
        "source": source,
        "speedUnit": _unit_of(ds, "speed") or "km/h",
        "jerkUnit": "m/s³",
        "accelSource": accel_source,
        "filterWindowMs": round(SMOOTH_WINDOW_S * 1000),
        "thresholds": {"smoothMax": SMOOTH_MAX, "moderateMax": MODERATE_MAX},
        "events": events,
        "transitions": _transition_stats(events),
        "summary": summary,
    }


def _safe(values: np.ndarray) -> list:
    return [round(float(v), 5) if math.isfinite(float(v)) else None for v in values]


def detail(ds: Dataset, event_index: int) -> dict:
    """Selected shift waveform plus a same-transition reference envelope."""
    windows, source, events, accel_raw, accel, jerk, accel_source = _analysis(ds)
    if event_index < 0 or event_index >= len(windows):
        raise IndexError(event_index)
    a, b = windows[event_index]
    ev = events[event_index]
    t = ds.time
    i0 = max(0, int(np.searchsorted(t, t[a] - DETAIL_MARGIN_S)))
    i1 = min(len(t), int(np.searchsorted(t, t[b] + DETAIL_MARGIN_S)) + 1)
    rel_t = t[i0:i1] - t[a]
    series: dict[str, list] = {}
    for role in ("speed", "rpm", "gear", "throttle", "brake", "shift_in_process"):
        values = _channel(ds, role)
        if values is not None:
            series[role] = _safe(values[i0:i1])
    if accel_raw is not None:
        series["accel_raw"] = _safe(accel_raw[i0:i1])
        series["accel"] = _safe(accel[i0:i1])
        series["jerk"] = _safe(jerk[i0:i1])

    peer_indexes = [i for i, other in enumerate(events)
                    if other.get("gearFrom") == ev.get("gearFrom") and other.get("gearTo") == ev.get("gearTo")]
    if len(peer_indexes) > 200:
        peer_indexes = np.linspace(0, len(peer_indexes) - 1, 200).astype(int).tolist()
    reference = None
    if accel is not None and peer_indexes:
        grid = np.linspace(float(rel_t[0]), float(rel_t[-1]), min(240, max(80, rel_t.size)))
        acc_rows, jerk_rows = [], []
        for pi in peer_indexes:
            pa, _pb = windows[pi]
            sample_t = t - t[pa]
            acc_rows.append(np.interp(grid, sample_t, accel))
            jerk_rows.append(np.interp(grid, sample_t, jerk))
        acc_stack, jerk_stack = np.asarray(acc_rows), np.asarray(jerk_rows)
        reference = {
            "count": len(peer_indexes),
            "t": _safe(grid),
            "accelMedian": _safe(np.median(acc_stack, axis=0)),
            "accelP10": _safe(np.percentile(acc_stack, 10, axis=0)),
            "accelP90": _safe(np.percentile(acc_stack, 90, axis=0)),
            "jerkMedian": _safe(np.median(jerk_stack, axis=0)),
            "jerkP10": _safe(np.percentile(jerk_stack, 10, axis=0)),
            "jerkP90": _safe(np.percentile(jerk_stack, 90, axis=0)),
        }
    return {
        "source": source,
        "event": ev,
        "t": _safe(rel_t),
        "series": series,
        "reference": reference,
        "accelSource": accel_source,
        "units": {"speed": _unit_of(ds, "speed") or "km/h", "rpm": "rpm", "accel": "m/s²", "jerk": "m/s³"},
    }
