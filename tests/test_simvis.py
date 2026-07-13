import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

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
    assert ds["mapping"]["speed"] == "speed_kmh"
    assert 19 < ds["duration"] <= 20


def test_playback_payload(client):
    p = client.get("/api/datasets/lap/playback").json()
    assert len(p["t"]) == 200
    assert "speed" in p["series"]
    assert "rpm" in p["series"]
    assert p["t"][0] == 0
    assert all(a <= b for a, b in zip(p["t"], p["t"][1:]))


def test_signals_downsampling(client):
    s = client.get("/api/datasets/lap/signals",
                   params={"columns": "speed_kmh", "points": 20}).json()
    assert s["downsampled"] is True
    assert len(s["t"]) <= 42
    assert len(s["series"]["speed_kmh"]) == len(s["t"])


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
