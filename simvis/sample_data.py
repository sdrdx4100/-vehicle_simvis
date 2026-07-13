"""Synthetic vehicle-log generator, used for demos and tests.

Produces physically plausible circuit-lap telemetry: a closed track built
from straight + corner segments, a speed profile driven by lateral-grip
limits with accel/braking passes, and engine/driver channels derived from
that motion. Channels are named and scaled per SAE J1939: SPN-prefixed
signal names with SLOT engineering units (km/h, rpm, %, rad, m/s², compass
bearing in degrees CW from north) — exactly what a J1939 CAN logger export
would hand the platform.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from .j1939 import SPEED_MAX_KMH, column_name

G = 9.80665
GEAR_RATIOS = [3.6, 2.4, 1.8, 1.4, 1.15, 0.95]
FINAL_DRIVE = 3.7
WHEEL_RADIUS = 0.33  # m
DS = 5.0  # station spacing along the track centerline, meters


def _smooth(x: np.ndarray, window: int) -> np.ndarray:
    window = max(3, window | 1)
    kernel = np.hanning(window)
    kernel /= kernel.sum()
    pad = window
    xp = np.concatenate([x[-pad:], x, x[:pad]])
    return np.convolve(xp, kernel, mode="same")[pad:-pad]


def _segment_track(rng: np.random.Generator, target_len_m: float,
                   r_min: float, r_max: float) -> np.ndarray:
    """Curvature (1/m) sampled every DS meters along a closed circuit made
    of straights and constant-radius corners, with heading closure (sum of
    corner angles scaled to exactly 2*pi)."""
    while True:
        segs: list[tuple[float, float]] = []  # (curvature, length)
        angles: list[float] = []
        length = 0.0
        while length < target_len_m:
            straight = rng.uniform(50, 380)
            segs.append((0.0, straight))
            angles.append(0.0)
            length += straight
            radius = float(np.exp(rng.uniform(np.log(r_min), np.log(r_max))))
            ang = np.radians(rng.uniform(25, 130)) * rng.choice([-1.0, 1.0], p=[0.35, 0.65])
            segs.append((np.sign(ang) / radius, abs(ang) * radius))
            angles.append(ang)
            length += abs(ang) * radius
        total_angle = sum(angles)
        if total_angle > np.pi / 2:  # net direction well-defined -> scalable
            break

    scale = 2 * np.pi / total_angle
    kappa_list: list[np.ndarray] = []
    for (kappa, seg_len), ang in zip(segs, angles):
        if kappa == 0.0:
            n = max(1, round(seg_len / DS))
            kappa_list.append(np.zeros(n))
        else:
            seg_len = abs(ang * scale) / abs(kappa)
            n = max(1, round(seg_len / DS))
            kappa_list.append(np.full(n, kappa))
    kappa_arr = np.concatenate(kappa_list)
    # Soften corner entries/exits so steering is human, then re-normalize
    # the total heading change back to exactly 2*pi.
    kappa_arr = _smooth(kappa_arr, 9)
    kappa_arr *= (2 * np.pi) / np.sum(kappa_arr * DS)
    return kappa_arr


def _speed_profile(kappa: np.ndarray, v_max: float, grip_g: float,
                   a_acc: float = 5.2, a_brk: float = 11.0) -> np.ndarray:
    v = np.sqrt(grip_g * G / np.maximum(np.abs(kappa), 1e-5))
    v = np.minimum(v, v_max)
    n = v.size
    for _ in range(4):  # circular forward/backward passes until stable
        for i in range(n):
            prev = v[i - 1]
            v[i] = min(v[i], np.sqrt(prev**2 + 2 * a_acc * DS))
        for i in range(n - 1, -1, -1):
            nxt = v[(i + 1) % n]
            v[i] = min(v[i], np.sqrt(nxt**2 + 2 * a_brk * DS))
    return v


def generate_lap(
    path: Path,
    seed: int = 7,
    duration_s: float = 300.0,
    hz: float = 25.0,
    track_len_m: float = 5400.0,
    origin: tuple[float, float] = (34.8431, 136.5410),  # Suzuka-ish
    v_max_kmh: float = 250.0,  # stays inside the SPN 84 SLOT range
    grip_g: float = 1.55,
    corner_radius: tuple[float, float] = (28.0, 320.0),
) -> Path:
    rng = np.random.default_rng(seed)
    kappa_track = _segment_track(rng, track_len_m, *corner_radius)
    m = kappa_track.size

    # Closed centerline geometry at the stations.
    yaw_track = np.concatenate([[0.0], np.cumsum(kappa_track * DS)])[:-1]
    x_track = np.cumsum(np.cos(yaw_track) * DS)
    y_track = np.cumsum(np.sin(yaw_track) * DS)
    # Heading closes by construction; distribute the residual position gap
    # linearly so lap N overlays lap 1 exactly.
    frac = np.arange(m) / m
    x_track -= (x_track[-1] - x_track[0] + DS * np.cos(yaw_track[-1])) * frac
    y_track -= (y_track[-1] - y_track[0] + DS * np.sin(yaw_track[-1])) * frac

    v_track = _speed_profile(kappa_track, v_max_kmh / 3.6, grip_g)

    # Time-march around the loop at the profile speed.
    n = int(duration_s * hz)
    dt = 1.0 / hz
    stations = np.arange(m, dtype=np.float64)
    pos = np.empty(n)
    idx = 0.0
    for i in range(n):
        pos[i] = idx
        v_here = np.interp(idx % m, stations, v_track)
        idx += v_here * dt / DS

    si = pos % m
    speed = np.interp(si, stations, v_track)
    kappa = np.interp(si, stations, kappa_track)
    x = np.interp(si, stations, x_track)
    y = np.interp(si, stations, y_track)
    yaw = np.interp(si, stations, yaw_track)

    # Driver / powertrain channels (J1939 SLOT units)
    accel_long = np.gradient(speed, dt)          # m/s²  (SPN 1810)
    accel_lat = kappa * speed**2                 # m/s²  (SPN 1809)
    yaw_rate = kappa * speed                     # rad/s (SPN 1808)
    throttle = np.clip(accel_long / G * 55 + 24 + rng.normal(0, 1.5, n), 0, 100)
    brake = np.clip(-accel_long / G * 58 - 4 + rng.normal(0, 1.0, n), 0, 100)
    throttle[brake > 5] = 0.0
    steering = np.arctan(kappa * 2.7) * 14       # rad   (SPN 1807): wheelbase * steer ratio

    wheel_rps = speed / (2 * np.pi * WHEEL_RADIUS)
    gear = np.ones(n, dtype=np.int32)
    rpm = np.zeros(n)
    cur = 1
    for i in range(n):
        while cur < len(GEAR_RATIOS) and wheel_rps[i] * GEAR_RATIOS[cur - 1] * FINAL_DRIVE * 60 > 7400:
            cur += 1
        while cur > 1 and wheel_rps[i] * GEAR_RATIOS[cur - 2] * FINAL_DRIVE * 60 < 6300:
            cur -= 1
        gear[i] = cur
        rpm[i] = max(950.0, wheel_rps[i] * GEAR_RATIOS[cur - 1] * FINAL_DRIVE * 60)
    rpm += rng.normal(0, 25, n)

    # GPS from local XY (equirectangular around origin)
    lat0, lon0 = origin
    lat = lat0 + (y / 111_320.0)
    lon = lon0 + (x / (111_320.0 * np.cos(np.radians(lat0))))

    t0 = np.datetime64("2026-07-13T09:30:00")
    timestamps = t0 + (np.arange(n) * dt * 1e6).astype("timedelta64[us]")

    # Compass bearing (SPN 165): degrees CW from north; yaw is CCW from east.
    bearing = (90.0 - np.degrees(yaw)) % 360.0
    fuel_rate = np.clip(1.8 + throttle * 0.55 + rng.normal(0, 0.4, n), 0.5, None)  # L/h (SPN 183)

    table = pa.table(
        {
            "timestamp": timestamps,
            column_name(84): np.minimum(speed * 3.6, SPEED_MAX_KMH).astype(np.float32),
            column_name(190): rpm.astype(np.float32),
            column_name(523): gear,
            column_name(91): throttle.astype(np.float32),
            column_name(521): brake.astype(np.float32),
            column_name(1807): steering.astype(np.float32),
            column_name(1810): accel_long.astype(np.float32),
            column_name(1809): accel_lat.astype(np.float32),
            column_name(1808): yaw_rate.astype(np.float32),
            column_name(165): bearing.astype(np.float32),
            column_name(584): lat,
            column_name(585): lon,
            column_name(580): (45 + 8 * np.sin(si / m * 2 * np.pi)).astype(np.float32),
            column_name(110): (82 + 6 * (1 - np.exp(-np.arange(n) / (n / 3))) + rng.normal(0, 0.3, n)).astype(np.float32),
            column_name(96): np.linspace(95.0, 95.0 - 1.4e-3 * speed.sum() * dt, n).astype(np.float32),
            column_name(183): fuel_rate.astype(np.float32),
        }
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)
    return path


def generate_all(data_dir: Path) -> list[Path]:
    data_dir = Path(data_dir)
    return [
        generate_lap(data_dir / "circuit_hotlap.parquet", seed=7, duration_s=300, track_len_m=5400),
        generate_lap(
            data_dir / "mountain_touge.parquet",
            seed=23,
            duration_s=300,
            hz=20,
            track_len_m=7200,
            v_max_kmh=145,
            grip_g=0.95,
            corner_radius=(16.0, 140.0),
            origin=(35.3606, 138.7274),
        ),
    ]
