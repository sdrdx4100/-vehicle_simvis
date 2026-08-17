r"""ETAS INCA / ASAP2 (A2L) measurement-name heuristics.

INCA logs (MDF/DAT/CSV exports) carry ECU-internal signal labels taken from
the project's A2L description, not a public standard — so naming varies by
OEM and supplier. What is fairly consistent is a body of classic Bosch-style
German mnemonics (``nmot`` = engine speed, ``vfzg`` = vehicle speed,
``wped`` = accelerator pedal, ``gang`` = gear …). This module recognizes the
common ones and maps them onto the platform's channel roles.

It is best-effort by design: anything it misses is still reachable through the
manual signal-mapping selector in the UI. Extend ``ALIASES`` to teach it a
project's own labels.

INCA decorations handled during normalization:
  * a ``Device\Signal`` (or ``Device/Signal``) prefix — only the last segment
    is the signal name;
  * a trailing acquisition-raster suffix — ``nmot\10ms``, ``nmot_100ms`` …;
  * a trailing ``.value`` / ``_value`` accessor.
"""

from __future__ import annotations

import re
from typing import Optional

# role -> the exact (normalized) mnemonics that map to it. Kept distinctive on
# purpose: short ambiguous tokens ("v", "n", "a") are avoided so INCA detection
# never fights the generic heuristics in mapping.py.
ALIASES: dict[str, list[str]] = {
    "rpm": ["nmot", "n_mot", "nmot_w", "neng", "n_eng", "epm_neng", "motor_n", "drehzahl"],
    "speed": ["vfzg", "v_fzg", "vfahrzeug", "vfahr", "vehv_v", "vehspd", "v_veh", "car_v", "vsol_fzg"],
    "throttle": ["wped", "w_ped", "wpedf", "apped", "ap_ped", "acc_pedal", "ped_pos", "wdkba", "wdk", "wdkist", "fahrpedal"],
    "brake": ["bls", "br_st", "bremse", "pbrake", "brakepedal", "brems_druck", "bremsdruck"],
    "gear": ["gang", "gangist", "gang_ist", "akt_gang", "getriebe_gang", "gangzahl"],
    "steering": ["lenkwinkel", "lwout", "lw_winkel", "lenkradwinkel"],
    "accel_x": ["along", "alongs", "alaengs", "a_laengs", "laengsbeschl", "along_fzg"],
    "accel_y": ["aquer", "aquerbeschl", "a_quer", "querbeschl"],
    "yaw_rate": ["gierrate", "gier_rate", "psip", "dpsi"],
    "altitude": ["hoehe", "gps_hoehe", "gps_alt", "alt_gps"],
    "coolant": ["tmot", "t_mot"],       # no dashboard role — informational alias
    "intake_temp": ["tans", "t_ans", "tint"],
    "boost": ["pvdks", "plad", "p_lad", "ladedruck"],
    "lambda": ["lamsoni", "lambda", "lam_ist"],
}

# Reverse: normalized-mnemonic -> role. Roles with no dashboard slot resolve to
# None so they are surfaced as extra channels rather than mis-assigned.
_DASHBOARD_ROLES = {
    "rpm", "speed", "throttle", "brake", "gear", "steering",
    "accel_x", "accel_y", "yaw_rate", "altitude",
}
_LOOKUP: dict[str, Optional[str]] = {}
for _role, _names in ALIASES.items():
    for _name in _names:
        _LOOKUP[_name] = _role if _role in _DASHBOARD_ROLES else None

# A trailing acquisition-raster or accessor: `\10ms`, `_100ms`, `.value`, ` 1ms`.
_RASTER_SUFFIX = re.compile(r"[\\/_.\s](?:\d+\s*m?s|value)$")


def normalize(name: str) -> str:
    """Reduce an INCA/A2L label to its bare signal mnemonic."""
    n = name.strip().lower()
    # Peel trailing raster/accessor decorations (e.g. `Sig\100ms.value`).
    for _ in range(3):
        stripped = _RASTER_SUFFIX.sub("", n)
        if stripped == n:
            break
        n = stripped
    # Device\Signal or Device/Signal -> Signal (last path segment).
    n = re.split(r"[\\/]", n)[-1]
    n = re.sub(r"[\s\-\.\[\]\(\)]+", "_", n)
    n = re.sub(r"_+", "_", n).strip("_")
    n = re.sub(r"_w$", "", n)  # Bosch physical-value suffix (Wert)
    return n


def lookup(name: str) -> Optional[str]:
    """Return the channel role for an INCA label, or None if unknown.

    Returns the string sentinel only for known mnemonics; callers should treat
    a ``None`` role (known but not a dashboard signal) distinctly from a miss.
    """
    norm = normalize(name)
    return _LOOKUP.get(norm)


def is_known(name: str) -> bool:
    return normalize(name) in _LOOKUP
