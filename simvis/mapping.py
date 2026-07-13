"""Automatic channel-role detection for vehicle log columns.

Parquet logs come from many loggers (CAN dumps, GPS loggers, sim exports)
with wildly different column names. This module maps columns onto a set of
well-known roles the UI understands (time, position, speed, rpm, ...).
Resolution order per column: SAE J1939 SPN number in the name (strongest,
via the SPN dictionary), then J1939 signal names and generic heuristics.
The detected mapping is returned to the client, which lets the user
override it.
"""

from __future__ import annotations

import re
from typing import Optional

from . import j1939

# Roles the frontend knows how to render specially. Each entry is a list of
# regexes tried in order against the normalized column name; first column to
# match a role wins that role.
ROLE_PATTERNS: dict[str, list[str]] = {
    "time": [
        r"^(time|timestamp|t|time_s|time_sec|sec|seconds|elapsed|datetime|date_time|utc|stamp|time_ms|time_us)$",
        r"time",
    ],
    "lat": [r"^(lat|latitude|gps_lat|gpslat|pos_lat)$", r"lat(itude)?$"],
    "lon": [r"^(lon|lng|longitude|gps_lon|gpslon|pos_lon|long)$", r"(lon(gitude)?|lng)$"],
    "x": [r"^(x|pos_x|position_x|pose_x|utm_x|local_x|east)$"],
    "y": [r"^(y|pos_y|position_y|pose_y|utm_y|local_y|north)$"],
    # Resolve engine speed before generic vehicle speed. Otherwise a column
    # named `EngineSpeed` is swallowed by the broad `speed` fallback below.
    "rpm": [r"^(rpm|engine_rpm|engine_speed|n_engine|eng_rpm|ne)$", r"rpm"],
    "speed": [
        r"^(speed|velocity|vel|v|vx|kph|mph|speed_kmh|speed_kph|speed_mps|vehicle_speed|veh_speed|wheel_speed|gps_speed|spd)$",
        r"^(wheel_based_vehicle_speed|navigation_based_vehicle_speed)$",  # J1939 SPN 84 / 517
        r"speed",
        r"^vel",
    ],
    # Before `gear`: its generic "gear" pattern would swallow names like
    # gear_shift_in_process.
    "shift_in_process": [
        r"^(shift_in_process|shiftinprocess|shift_in_progress|shifting|shift_flag|gear_shift_in_process|transmission_shift_in_process)$",
    ],
    "gear": [
        r"^(gear|gear_pos|current_gear|gear_position|shift)$",
        r"^transmission_(current|selected)_gear$",  # J1939 SPN 523 / 524
        r"gear",
    ],
    "throttle": [
        r"^(throttle|throttle_pos|throttle_pct|accel_pedal|accelerator|aps|tps|pedal|gas)$",
        r"^accelerator_pedal_position_?\d?$",  # J1939 SPN 91
        r"throttle",
    ],
    "brake": [r"^(brake|brake_pressure|brake_pct|brake_pedal|bps)$", r"brake"],
    "steering": [
        r"^(steer|steering|steering_angle|steer_angle|swa|handle|steering_wheel_angle)$",  # incl. J1939 SPN 1807
        r"steer",
    ],
    "accel_x": [
        r"^(ax|acc_x|accel_x|acceleration_x|long_accel|longitudinal_accel(eration)?|imu_ax|a_long)$",  # incl. J1939 SPN 1810
    ],
    "accel_y": [
        r"^(ay|acc_y|accel_y|acceleration_y|lat_accel|lateral_accel(eration)?|imu_ay|a_lat)$",  # incl. J1939 SPN 1809
    ],
    "accel_z": [r"^(az|acc_z|accel_z|acceleration_z|vert_accel|imu_az)$"],
    # yaw = math/ENU convention (CCW); bearing = compass (CW from north).
    "yaw": [r"^(yaw|psi|yaw_angle)$"],
    "bearing": [r"^(heading|course|bearing|azimuth|compass_bearing)$", r"heading"],  # incl. J1939 SPN 165
    "yaw_rate": [r"^(yaw_rate|yawrate|r|gyro_z|omega|angular_velocity_z)$"],  # incl. J1939 SPN 1808
    "altitude": [r"^(alt|altitude|elevation|height|gps_alt)$"],  # incl. J1939 SPN 580
}

# Rough display units per role, used as a fallback label when the column
# name itself doesn't carry a unit suffix.
ROLE_UNITS: dict[str, str] = {
    "speed": "km/h",
    "rpm": "rpm",
    "throttle": "%",
    "brake": "%",
    "steering": "deg",
    "accel_x": "G",
    "accel_y": "G",
    "accel_z": "G",
    "yaw": "deg",
    "bearing": "deg",
    "yaw_rate": "deg/s",
    "altitude": "m",
    "lat": "deg",
    "lon": "deg",
    "x": "m",
    "y": "m",
    "time": "s",
    "gear": "",
    "shift_in_process": "",
}

_UNIT_SUFFIX = re.compile(
    r"[_\[\(\s](kmh|km_h|kph|mph|mps|m_s|rpm|deg|rad|pct|percent|g|ms2|m_s2|bar|kpa|nm)[\]\)]?$"
)


_STRIP_UNITS = re.compile(
    r"_(kmh|km_h|kph|mph|mps|m_s|rpm|deg|rad|pct|percent|g|ms2|m_s2|bar|kpa|nm|m|c|s|ms|us)$"
)


def _split_camel(name: str) -> str:
    # WheelBasedVehicleSpeed -> Wheel_Based_Vehicle_Speed (before lowering)
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name)
    name = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", "_", name)
    return name


def _normalize(name: str) -> tuple[str, str]:
    """Return (raw, unit-stripped) normalized forms of a column name."""
    n = _split_camel(name.strip()).lower()
    n = re.sub(r"[\s\-\.\[\]\(\)/]+", "_", n)
    n = re.sub(r"_+", "_", n).strip("_")
    stripped = _STRIP_UNITS.sub("", n)
    return n, stripped or n


def guess_unit(column: str, role: Optional[str]) -> str:
    n = re.sub(r"[\s\-\.\[\]\(\)/]+", "_", _split_camel(column.strip()).lower())
    entry = j1939.lookup(n)
    if entry is not None:
        return entry[1]
    m = _UNIT_SUFFIX.search(n)
    if m:
        u = m.group(1)
        return {
            "kmh": "km/h", "km_h": "km/h", "kph": "km/h", "mph": "mph",
            "mps": "m/s", "m_s": "m/s", "pct": "%", "percent": "%",
            "ms2": "m/s²", "m_s2": "m/s²", "kpa": "kPa", "nm": "Nm",
        }.get(u, u)
    if role:
        return ROLE_UNITS.get(role, "")
    return ""


def detect_mapping(columns: list[str], dtypes: dict[str, str]) -> dict[str, str]:
    """Return {role: column_name} for every role that could be detected."""
    # Match against both the unit-stripped and raw normalized names:
    # `accel_y_g` needs stripping to hit accel_y, while `engine_rpm`
    # must NOT be stripped down to `engine`.
    normalized = {col: _normalize(col) for col in columns}
    mapping: dict[str, str] = {}
    taken: set[str] = set()

    # A datetime-typed column is the strongest possible time signal.
    for col in columns:
        if dtypes.get(col, "").startswith("timestamp") or dtypes.get(col, "").startswith("datetime"):
            mapping["time"] = col
            taken.add(col)
            break

    # J1939: an SPN number in the column name beats every name heuristic.
    for col in columns:
        if col in taken:
            continue
        entry = j1939.lookup(normalized[col][0])
        if entry is not None:
            role = entry[2]
            if role is not None and role not in mapping:
                mapping[role] = col
                taken.add(col)

    for role, patterns in ROLE_PATTERNS.items():
        if role in mapping:
            continue
        for pattern in patterns:
            rx = re.compile(pattern)
            candidates = [
                c for c in columns
                if c not in taken and (rx.search(normalized[c][0]) or rx.search(normalized[c][1]))
            ]
            if candidates:
                mapping[role] = candidates[0]
                taken.add(candidates[0])
                break

    return mapping
