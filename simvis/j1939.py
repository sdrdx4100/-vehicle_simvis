"""SAE J1939 signal dictionary.

Well-known SPNs (Suspect Parameter Numbers) mapped to the platform's
channel roles and their J1939 engineering units. Columns named with an
SPN — `SPN84_WheelBasedVehicleSpeed`, `spn_190`, … — are resolved
through this table, which takes priority over name heuristics.
"""

from __future__ import annotations

import re
from typing import Optional

# spn -> (signal name, unit, role or None)
# Units are the J1939 SLOT engineering units.
SPN_TABLE: dict[int, tuple[str, str, Optional[str]]] = {
    84:   ("WheelBasedVehicleSpeed", "km/h", "speed"),        # PGN 65265 CCVS
    190:  ("EngineSpeed", "rpm", "rpm"),                      # PGN 61444 EEC1
    91:   ("AcceleratorPedalPosition1", "%", "throttle"),     # PGN 61443 EEC2
    92:   ("EnginePercentLoadAtCurrentSpeed", "%", None),     # PGN 61443 EEC2
    521:  ("BrakePedalPosition", "%", "brake"),               # PGN 61441 EBC1
    523:  ("TransmissionCurrentGear", "", "gear"),            # PGN 61445 ETC2
    524:  ("TransmissionSelectedGear", "", None),             # PGN 61445 ETC2
    574:  ("TransmissionShiftInProcess", "", "shift_in_process"),  # PGN 61442 ETC1
    161:  ("TransmissionInputShaftSpeed", "rpm", None),       # PGN 61442 ETC1
    191:  ("TransmissionOutputShaftSpeed", "rpm", None),      # PGN 61442 ETC1
    1807: ("SteeringWheelAngle", "rad", "steering"),          # PGN 61449 VDC2
    1808: ("YawRate", "rad/s", "yaw_rate"),                   # PGN 61449 VDC2
    1809: ("LateralAcceleration", "m/s²", "accel_y"),         # PGN 61449 VDC2
    1810: ("LongitudinalAcceleration", "m/s²", "accel_x"),    # PGN 61449 VDC2
    584:  ("Latitude", "deg", "lat"),                         # PGN 65267 VP
    585:  ("Longitude", "deg", "lon"),                        # PGN 65267 VP
    165:  ("CompassBearing", "deg", "bearing"),               # PGN 65256 VDHR
    580:  ("Altitude", "m", "altitude"),                      # PGN 65256 VDHR
    517:  ("NavigationBasedVehicleSpeed", "km/h", None),      # PGN 65256 VDHR
    110:  ("EngineCoolantTemperature", "°C", None),           # PGN 65262 ET1
    96:   ("FuelLevel1", "%", None),                          # PGN 65276 DD
    183:  ("EngineFuelRate", "L/h", None),                    # PGN 65266 LFE1
    100:  ("EngineOilPressure", "kPa", None),                 # PGN 65263 EFL/P1
    102:  ("BoostPressure", "kPa", None),                     # PGN 65270 IC1
    168:  ("BatteryPotential", "V", None),                    # PGN 65271 VEP1
}

# J1939 SLOT valid ranges for the demo generator (value clamps).
SPEED_MAX_KMH = 250.996          # SPN 84, SAEvl01

_SPN_IN_NAME = re.compile(r"(?:^|_)spn_?(\d{1,5})(?:_|$)")


def spn_of(normalized_name: str) -> Optional[int]:
    """Extract an SPN number from a normalized column name, if present."""
    m = _SPN_IN_NAME.search(normalized_name)
    return int(m.group(1)) if m else None


def lookup(normalized_name: str) -> Optional[tuple[str, str, Optional[str]]]:
    spn = spn_of(normalized_name)
    if spn is not None and spn in SPN_TABLE:
        return SPN_TABLE[spn]
    return None


def column_name(spn: int) -> str:
    """Canonical J1939 column name for a SPN, e.g. SPN84_WheelBasedVehicleSpeed."""
    name, _, _ = SPN_TABLE[spn]
    return f"SPN{spn}_{name}"
