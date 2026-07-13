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


def test_unsorted_numeric_time(tmp_path):
    # Rows out of order; server must sort by time.
    t = np.array([2.0, 0.0, 1.0, 3.0])
    v = np.array([20.0, 0.0, 10.0, 30.0])
    pq.write_table(pa.table({"time_s": t, "speed": v}), tmp_path / "x.parquet")
    c = TestClient(create_app(tmp_path))
    p = c.get("/api/datasets/x/playback").json()
    assert p["t"] == [0.0, 1.0, 2.0, 3.0]
    assert p["series"]["speed"] == [0.0, 10.0, 20.0, 30.0]
