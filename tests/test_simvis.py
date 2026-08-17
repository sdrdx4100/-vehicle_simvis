import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from simvis.j1939 import SPEED_MAX_KMH, column_name
from simvis.mapping import detect_mapping, guess_unit
from simvis.sample_data import generate_lap
from simvis.server import create_app


# ---------- mapping ----------

def test_detect_mapping_common_names():
    cols = ["timestamp", "speed_kmh", "engine_rpm", "gear", "throttle_pct",
            "brake_pct", "steering_angle_deg", "accel_x_g", "accel_y_g",
            "latitude", "longitude"]
    m = detect_mapping(cols, {"timestamp": "timestamp[us]"})
    assert m["time"] == "timestamp"
    assert m["speed"] == "speed_kmh"
    assert m["rpm"] == "engine_rpm"
    assert m["accel_y"] == "accel_y_g"
    assert m["lat"] == "latitude"
    assert m["lon"] == "longitude"


def test_detect_mapping_alt_names():
    cols = ["Time (s)", "VehicleSpeed", "Ne", "APS", "SWA", "GPS_Lat", "GPS_Lon"]
    m = detect_mapping(cols, {})
    assert m["time"] == "Time (s)"
    assert m["speed"] == "VehicleSpeed"
    assert m["lat"] == "GPS_Lat"
    assert m["lon"] == "GPS_Lon"


def test_engine_speed_is_not_mistaken_for_vehicle_speed():
    m = detect_mapping(["timestamp", "EngineSpeed", "VehicleSpeed"], {})
    assert m["rpm"] == "EngineSpeed"
    assert m["speed"] == "VehicleSpeed"


def test_guess_unit():
    assert guess_unit("speed_kmh", "speed") == "km/h"
    assert guess_unit("mystery", None) == ""
    assert guess_unit("velocity", "speed") == "km/h"


# ---------- J1939 ----------

def test_detect_mapping_j1939_spn_names():
    cols = [
        "timestamp",
        "SPN84_WheelBasedVehicleSpeed",
        "SPN190_EngineSpeed",
        "SPN523_TransmissionCurrentGear",
        "SPN91_AcceleratorPedalPosition1",
        "SPN521_BrakePedalPosition",
        "SPN1807_SteeringWheelAngle",
        "SPN1810_LongitudinalAcceleration",
        "SPN1809_LateralAcceleration",
        "SPN1808_YawRate",
        "SPN165_CompassBearing",
        "SPN584_Latitude",
        "SPN585_Longitude",
        "SPN110_EngineCoolantTemperature",
    ]
    m = detect_mapping(cols, {"timestamp": "timestamp[us]"})
    assert m["speed"] == "SPN84_WheelBasedVehicleSpeed"
    assert m["rpm"] == "SPN190_EngineSpeed"
    assert m["gear"] == "SPN523_TransmissionCurrentGear"
    assert m["throttle"] == "SPN91_AcceleratorPedalPosition1"
    assert m["brake"] == "SPN521_BrakePedalPosition"
    assert m["steering"] == "SPN1807_SteeringWheelAngle"
    assert m["accel_x"] == "SPN1810_LongitudinalAcceleration"
    assert m["accel_y"] == "SPN1809_LateralAcceleration"
    assert m["yaw_rate"] == "SPN1808_YawRate"
    assert m["bearing"] == "SPN165_CompassBearing"
    assert m["lat"] == "SPN584_Latitude"
    assert m["lon"] == "SPN585_Longitude"
    # SPN 110 has no dashboard role — stays an extra channel
    assert "SPN110_EngineCoolantTemperature" not in m.values()


def test_detect_mapping_spn_numbers_only():
    m = detect_mapping(["spn_84", "spn190", "SPN_1807"], {})
    assert m["speed"] == "spn_84"
    assert m["rpm"] == "spn190"
    assert m["steering"] == "SPN_1807"


def test_detect_mapping_j1939_signal_names_without_spn():
    cols = ["WheelBasedVehicleSpeed", "AcceleratorPedalPosition1", "CompassBearing"]
    m = detect_mapping(cols, {})
    assert m["speed"] == "WheelBasedVehicleSpeed"
    assert m["throttle"] == "AcceleratorPedalPosition1"
    assert m["bearing"] == "CompassBearing"


def test_detect_mapping_inca_mnemonics():
    cols = ["time", "nmot", "vfzg", "wped", "gang", "bls",
            "along", "aquer", "lenkwinkel", "gierrate"]
    m = detect_mapping(cols, {})
    assert m["rpm"] == "nmot"
    assert m["speed"] == "vfzg"
    assert m["throttle"] == "wped"
    assert m["gear"] == "gang"
    assert m["brake"] == "bls"
    assert m["accel_x"] == "along"
    assert m["accel_y"] == "aquer"
    assert m["steering"] == "lenkwinkel"
    assert m["yaw_rate"] == "gierrate"


def test_detect_mapping_inca_decorations():
    # Device\Signal\raster and unit-word suffixes must all resolve.
    cols = ["Time (s)", "ETKC:1\\nmot\\10ms", "vfzg_100ms", "wPed_w"]
    m = detect_mapping(cols, {})
    assert m["rpm"] == "ETKC:1\\nmot\\10ms"
    assert m["speed"] == "vfzg_100ms"
    assert m["throttle"] == "wPed_w"


def test_inca_informational_alias_has_no_dashboard_role():
    from simvis import inca
    assert inca.lookup("tmot") is None      # known, but no dashboard slot
    assert inca.is_known("tmot") is True
    assert inca.lookup("totally_unknown") is None
    assert inca.is_known("totally_unknown") is False


def test_j1939_units():
    assert guess_unit("SPN1807_SteeringWheelAngle", "steering") == "rad"
    assert guess_unit("SPN1809_LateralAcceleration", "accel_y") == "m/s²"
    assert guess_unit("SPN84_WheelBasedVehicleSpeed", "speed") == "km/h"
    assert guess_unit("SPN110_EngineCoolantTemperature", None) == "°C"


def test_demo_speed_within_j1939_slot_range(tmp_path):
    path = generate_lap(tmp_path / "lap.parquet", seed=5, duration_s=30, hz=10)
    t = pq.read_table(path)
    speed = t[column_name(84)].to_numpy()
    assert float(speed.max()) <= SPEED_MAX_KMH
    assert float(speed.max()) <= 160.0  # demo should not look like a 250 km/h race replay
    bearing = t[column_name(165)].to_numpy()
    assert 0.0 <= float(bearing.min()) and float(bearing.max()) < 360.0


# ---------- API ----------

@pytest.fixture()
def client(tmp_path):
    generate_lap(tmp_path / "lap.parquet", seed=3, duration_s=20, hz=10)
    return TestClient(create_app(tmp_path))


def test_list_and_meta(client):
    data = client.get("/api/datasets").json()
    assert len(data["datasets"]) == 1
    ds = data["datasets"][0]
    assert ds["id"] == "lap"
    assert ds["rows"] == 200
    assert ds["mapping"]["speed"] == column_name(84)
    assert 19 < ds["duration"] <= 20


def test_playback_payload(client):
    p = client.get("/api/datasets/lap/playback").json()
    assert len(p["t"]) == 200
    assert "speed" in p["series"]
    assert "rpm" in p["series"]
    assert p["t"][0] == 0
    assert all(a <= b for a, b in zip(p["t"], p["t"][1:]))


def test_mapping_override_and_reset(client):
    ds = client.get("/api/datasets/lap").json()
    speed_col = ds["mapping"]["speed"]
    rpm_col = ds["mapping"]["rpm"]

    changed = client.put("/api/datasets/lap/mapping", json={"speed": rpm_col})
    assert changed.status_code == 200
    assert changed.json()["mapping"]["speed"] == rpm_col
    playback = client.get("/api/datasets/lap/playback").json()
    assert playback["seriesColumns"]["speed"] == rpm_col

    reset = client.delete("/api/datasets/lap/mapping")
    assert reset.status_code == 200
    assert reset.json()["mapping"]["speed"] == speed_col


def test_signals_downsampling(client):
    col = column_name(84)
    s = client.get("/api/datasets/lap/signals",
                   params={"columns": col, "points": 20}).json()
    assert s["downsampled"] is True
    assert len(s["t"]) <= 42
    assert len(s["series"][col]) == len(s["t"])


def test_table(client):
    t = client.get("/api/datasets/lap/table", params={"offset": 10, "limit": 5}).json()
    assert t["total"] == 200
    assert len(t["rows"]) == 5
    assert t["rows"][0]["t"] == pytest.approx(1.0)


def test_unknown_dataset_404(client):
    assert client.get("/api/datasets/nope").status_code == 404


def test_upload_roundtrip(client, tmp_path):
    table = pa.table({
        "t_ms": np.arange(0, 5000, 100, dtype=np.int64),
        "spd": np.linspace(0, 30, 50),
    })
    buf = tmp_path / "u.parquet"
    pq.write_table(table, buf)
    res = client.post("/api/datasets/upload",
                      files={"file": ("mylog.parquet", buf.read_bytes())})
    assert res.status_code == 200
    ds = res.json()
    assert ds["rows"] == 50
    assert ds["mapping"]["speed"] == "spd"


def test_upload_rejects_garbage(client):
    res = client.post("/api/datasets/upload",
                      files={"file": ("bad.parquet", b"not parquet at all")})
    assert res.status_code == 422


# ---------- shift analysis ----------

def _make_shift_log(tmp_path, with_flag=True):
    hz, dur = 50, 10.0
    n = int(hz * dur)
    t = np.arange(n) / hz
    speed = np.full(n, 50.0)                      # km/h, steady
    gear = np.full(n, 3, dtype=np.int32)
    flag = np.zeros(n, dtype=np.int32)
    i0, i1 = int(5.0 * hz), int(5.3 * hz)         # shift at t=5.0..5.3s
    gear[i0:] = 4
    flag[i0:i1] = 1
    speed[i0:i1] -= 3.0 * np.hanning(i1 - i0)     # torque-interruption dip
    cols = {
        "time_s": t,
        "SPN84_WheelBasedVehicleSpeed": speed,
        "SPN523_TransmissionCurrentGear": gear,
    }
    if with_flag:
        cols["SPN574_TransmissionShiftInProcess"] = flag
    path = tmp_path / ("flagged.parquet" if with_flag else "flagless.parquet")
    pq.write_table(pa.table(cols), path)
    return path


def test_shift_events_from_flag(tmp_path):
    _make_shift_log(tmp_path, with_flag=True)
    c = TestClient(create_app(tmp_path))
    r = c.get("/api/datasets/flagged/shifts").json()
    assert r["source"] == "shift_in_process"
    assert r["summary"]["count"] == 1
    ev = r["events"][0]
    assert ev["gearFrom"] == 3 and ev["gearTo"] == 4
    assert ev["direction"] == "up"
    assert ev["tStart"] == pytest.approx(5.0, abs=0.05)
    assert ev["speedOn"] == pytest.approx(50.0, abs=0.5)   # v at flag ON
    assert ev["speedOff"] == pytest.approx(50.0, abs=0.5)  # v at flag OFF
    assert 250 <= ev["durationMs"] <= 320
    assert ev["peakJerk"] > 0
    assert ev["jerkP95"] > 0
    assert ev["jerkRms"] > 0
    assert ev["accelP2P"] > 0
    assert ev["shockPhase"] in ("during", "settle")
    assert ev["severity"] in ("smooth", "moderate", "harsh")
    assert r["transitions"][0]["gearFrom"] == 3
    assert r["transitions"][0]["gearTo"] == 4


def test_shift_detail_waveform_and_reference(tmp_path):
    _make_shift_log(tmp_path, with_flag=True)
    c = TestClient(create_app(tmp_path))
    r = c.get("/api/datasets/flagged/shifts/0")
    assert r.status_code == 200
    detail = r.json()
    assert detail["event"]["index"] == 0
    assert detail["t"][0] < 0 < detail["t"][-1]
    assert len(detail["series"]["jerk"]) == len(detail["t"])
    assert detail["reference"]["count"] == 1
    assert len(detail["reference"]["accelMedian"]) == len(detail["reference"]["t"])
    assert c.get("/api/datasets/flagged/shifts/99").status_code == 404


def test_shift_events_fallback_to_gear(tmp_path):
    _make_shift_log(tmp_path, with_flag=False)
    c = TestClient(create_app(tmp_path))
    r = c.get("/api/datasets/flagless/shifts").json()
    assert r["source"] == "gear"
    assert r["summary"]["count"] == 1
    assert r["events"][0]["gearFrom"] == 3
    assert r["events"][0]["gearTo"] == 4


def test_shift_flag_mapping():
    m = detect_mapping(["shiftinprocess", "gear", "speed"], {})
    assert m["shift_in_process"] == "shiftinprocess"
    m2 = detect_mapping(["SPN574_TransmissionShiftInProcess"], {})
    assert m2["shift_in_process"] == "SPN574_TransmissionShiftInProcess"


def test_demo_has_shift_events(client):
    r = client.get("/api/datasets/lap/shifts").json()
    assert r["source"] == "shift_in_process"
    assert r["summary"]["count"] >= 1
    for ev in r["events"]:
        assert "speedOn" in ev and "speedOff" in ev
        assert 0 < ev["durationMs"] <= 600


def test_unsorted_numeric_time(tmp_path):
    # Rows out of order; server must sort by time.
    t = np.array([2.0, 0.0, 1.0, 3.0])
    v = np.array([20.0, 0.0, 10.0, 30.0])
    pq.write_table(pa.table({"time_s": t, "speed": v}), tmp_path / "x.parquet")
    c = TestClient(create_app(tmp_path))
    p = c.get("/api/datasets/x/playback").json()
    assert p["t"] == [0.0, 1.0, 2.0, 3.0]
    assert p["series"]["speed"] == [0.0, 10.0, 20.0, 30.0]
