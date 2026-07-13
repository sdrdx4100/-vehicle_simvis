"""Gearshift event extraction and shift-shock analysis.

Shift windows come from the J1939 TransmissionShiftInProcess flag
(SPN 574, PGN 61442 ETC1) when the log has one: each ON->OFF span is one
shift event, and vehicle speed is captured at both edges. Logs without
the flag fall back to windows around gear-channel transitions.

Shift shock is quantified as the peak longitudinal jerk |da/dt| (m/s³)
inside the window (plus a short settle margin) — the physical quantity a
passenger feels as the "jolt" of a rough engagement. Longitudinal
acceleration is taken from the accel_x channel when present (converted
to m/s² if the log stores G), otherwise derived from vehicle speed.
"""

from __future__ import annotations

import math

import numpy as np

from .datasets import Dataset

G = 9.80665

# Peak-jerk classification thresholds, m/s³.
SMOOTH_MAX = 10.0
MODERATE_MAX = 25.0

# Windows longer than this are treated as flag glitches, not shifts.
MAX_SHIFT_S = 3.0
# Settle margin after the flag drops, where the engagement jolt lands.
SETTLE_S = 0.25


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


def _accel_mps2(ds: Dataset) -> np.ndarray | None:
    """Longitudinal acceleration in m/s², from accel_x or speed."""
    accel = _channel(ds, "accel_x")
    if accel is not None:
        unit = _unit_of(ds, "accel_x").lower()
        return accel * G if unit == "g" else accel
    speed = _channel(ds, "speed")
    if speed is None or ds.time.size < 3:
        return None
    unit = _unit_of(ds, "speed").lower()
    to_mps = {"km/h": 1 / 3.6, "kmh": 1 / 3.6, "mph": 0.44704, "m/s": 1.0}.get(unit, 1 / 3.6)
    return np.gradient(speed * to_mps, ds.time)


def _flag_windows(t: np.ndarray, flag: np.ndarray) -> list[tuple[int, int]]:
    """(start, end) index pairs for each ON span of the flag."""
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
    """Fallback: a nominal window around each gear transition."""
    changes = np.flatnonzero(np.diff(np.nan_to_num(gear, nan=-1)) != 0) + 1
    windows = []
    for i in changes:
        a = int(np.searchsorted(t, t[i] - 0.15))
        b = int(np.searchsorted(t, t[i] + 0.25))
        windows.append((max(0, a), min(len(t) - 1, b)))
    return windows


def _severity(peak_jerk: float) -> str:
    if peak_jerk < SMOOTH_MAX:
        return "smooth"
    if peak_jerk < MODERATE_MAX:
        return "moderate"
    return "harsh"


def analyze(ds: Dataset) -> dict:
    ds.ensure_loaded()
    t = ds.time
    flag = _channel(ds, "shift_in_process")
    gear = _channel(ds, "gear")
    speed = _channel(ds, "speed")
    accel = _accel_mps2(ds)
    speed_unit = _unit_of(ds, "speed") or "km/h"

    if flag is not None:
        windows, source = _flag_windows(t, flag), "shift_in_process"
    elif gear is not None:
        windows, source = _gear_windows(t, gear), "gear"
    else:
        return {"source": None, "events": [], "summary": None,
                "note": "no shift_in_process flag or gear channel detected"}

    events = []
    for a, b in windows:
        ev: dict = {
            "tStart": round(float(t[a]), 3),
            "tEnd": round(float(t[b]), 3),
            "durationMs": round(float(t[b] - t[a]) * 1000),
        }
        if gear is not None:
            g_from = gear[max(0, a - 1)]
            g_to = gear[min(len(gear) - 1, b + 1)]
            if math.isfinite(g_from) and math.isfinite(g_to):
                ev["gearFrom"] = int(round(g_from))
                ev["gearTo"] = int(round(g_to))
                ev["direction"] = ("up" if ev["gearTo"] > ev["gearFrom"]
                                   else "down" if ev["gearTo"] < ev["gearFrom"] else "none")
        if speed is not None:
            v_on, v_off = float(speed[a]), float(speed[b])
            if math.isfinite(v_on) and math.isfinite(v_off):
                ev["speedOn"] = round(v_on, 1)
                ev["speedOff"] = round(v_off, 1)
                ev["deltaV"] = round(v_off - v_on, 2)
        if accel is not None:
            b_pad = int(np.searchsorted(t, t[b] + SETTLE_S))
            seg_a, seg_b = max(0, a - 1), min(len(t) - 1, b_pad)
            if seg_b - seg_a >= 2:
                seg = accel[seg_a:seg_b + 1]
                seg_t = t[seg_a:seg_b + 1]
                finite = np.isfinite(seg)
                if finite.sum() >= 3:
                    jerk = np.gradient(np.nan_to_num(seg, nan=0.0), seg_t)
                    peak = float(np.max(np.abs(jerk[finite])))
                    ev["peakJerk"] = round(peak, 1)
                    ev["severity"] = _severity(peak)
        events.append(ev)

    shocks = [e["peakJerk"] for e in events if "peakJerk" in e]
    ups = sum(1 for e in events if e.get("direction") == "up")
    downs = sum(1 for e in events if e.get("direction") == "down")
    summary = {
        "count": len(events),
        "upshifts": ups,
        "downshifts": downs,
        "meanDurationMs": round(float(np.mean([e["durationMs"] for e in events]))) if events else 0,
        "meanPeakJerk": round(float(np.mean(shocks)), 1) if shocks else None,
        "maxPeakJerk": round(float(np.max(shocks)), 1) if shocks else None,
        "harshCount": sum(1 for e in events if e.get("severity") == "harsh"),
    }
    return {
        "source": source,
        "speedUnit": speed_unit,
        "jerkUnit": "m/s³",
        "thresholds": {"smoothMax": SMOOTH_MAX, "moderateMax": MODERATE_MAX},
        "events": events,
        "summary": summary,
    }
