"""Dataset registry: scans a directory of parquet files and serves
numeric channel data as numpy arrays with a normalized time base."""

from __future__ import annotations

import math
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from .mapping import detect_mapping, guess_unit


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_\-]+", "-", name).strip("-").lower()
    return slug or "dataset"


def _json_safe(values: np.ndarray) -> list:
    """float array -> list with NaN/Inf replaced by None (JSON has no NaN)."""
    out = values.tolist()
    return [v if v is not None and math.isfinite(v) else None for v in out]


@dataclass
class Dataset:
    id: str
    path: Path
    name: str
    # Loaded lazily:
    time: Optional[np.ndarray] = None            # seconds from start, sorted
    channels: dict[str, np.ndarray] = field(default_factory=dict)
    columns: list[dict] = field(default_factory=list)
    mapping: dict[str, str] = field(default_factory=dict)
    rows: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # ---- loading -----------------------------------------------------

    def ensure_loaded(self) -> None:
        with self._lock:
            if self.time is not None:
                return
            table = pq.read_table(self.path)
            self._ingest(table)

    def _ingest(self, table: pa.Table) -> None:
        dtypes = {name: str(table.schema.field(name).type) for name in table.column_names}
        self.mapping = detect_mapping(list(table.column_names), dtypes)

        raw_time = self._extract_time(table)
        order = np.argsort(raw_time, kind="stable")
        needs_sort = bool(np.any(np.diff(raw_time) < 0))

        channels: dict[str, np.ndarray] = {}
        columns_meta: list[dict] = []
        for name in table.column_names:
            col_type = table.schema.field(name).type
            arr = self._to_float(table.column(name), col_type)
            meta = {"name": name, "dtype": str(col_type), "numeric": arr is not None}
            if arr is not None:
                if needs_sort:
                    arr = arr[order]
                channels[name] = arr
                finite = arr[np.isfinite(arr)]
                if finite.size:
                    meta["min"] = float(finite.min())
                    meta["max"] = float(finite.max())
                    meta["mean"] = float(finite.mean())
            role = next((r for r, c in self.mapping.items() if c == name), None)
            meta["role"] = role
            meta["unit"] = guess_unit(name, role)
            columns_meta.append(meta)

        if needs_sort:
            raw_time = raw_time[order]
        self.time = raw_time - raw_time[0] if raw_time.size else raw_time
        self.channels = channels
        self.columns = columns_meta
        self.rows = table.num_rows

    def _extract_time(self, table: pa.Table) -> np.ndarray:
        """Seconds as float64. Handles datetime, epoch s/ms/us/ns, or falls
        back to the row index when no usable time column exists."""
        col_name = self.mapping.get("time")
        if col_name is not None:
            col_type = table.schema.field(col_name).type
            arr = self._to_float(table.column(col_name), col_type)
            if arr is not None and np.isfinite(arr).all() and arr.size:
                if pa.types.is_timestamp(col_type):
                    unit = col_type.unit  # to_float yields raw ticks
                    scale = {"s": 1.0, "ms": 1e3, "us": 1e6, "ns": 1e9}[unit]
                    return arr / scale
                span = float(arr[-1] - arr[0]) if arr.size > 1 else 0.0
                magnitude = float(np.nanmedian(np.abs(arr)))
                # Epoch heuristics: numeric epochs are enormous relative to
                # any plausible seconds-from-start value.
                if magnitude > 1e17:
                    return arr / 1e9  # epoch ns
                if magnitude > 1e14:
                    return arr / 1e6  # epoch us
                if magnitude > 1e11:
                    return arr / 1e3  # epoch ms
                if magnitude > 1e8:
                    return arr        # epoch s
                # Relative time: only rescale if the span screams "milliseconds"
                if span > 1e6:
                    return arr / 1e3
                return arr
        self.mapping.pop("time", None)
        return np.arange(table.num_rows, dtype=np.float64)

    @staticmethod
    def _to_float(column: pa.ChunkedArray, col_type: pa.DataType) -> Optional[np.ndarray]:
        try:
            if pa.types.is_timestamp(col_type):
                return column.cast(pa.int64()).to_numpy(zero_copy_only=False).astype(np.float64)
            if pa.types.is_boolean(col_type):
                return column.cast(pa.int8()).to_numpy(zero_copy_only=False).astype(np.float64)
            if pa.types.is_integer(col_type) or pa.types.is_floating(col_type) or pa.types.is_decimal(col_type):
                return column.cast(pa.float64()).to_numpy(zero_copy_only=False).astype(np.float64)
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError):
            return None
        return None

    # ---- queries -----------------------------------------------------

    @property
    def duration(self) -> float:
        self.ensure_loaded()
        return float(self.time[-1]) if self.time is not None and self.time.size else 0.0

    @property
    def sample_rate(self) -> float:
        self.ensure_loaded()
        if self.time is None or self.time.size < 2 or self.duration <= 0:
            return 0.0
        return (self.time.size - 1) / self.duration

    def summary(self) -> dict:
        self.ensure_loaded()
        return {
            "id": self.id,
            "name": self.name,
            "file": self.path.name,
            "rows": self.rows,
            "duration": round(self.duration, 3),
            "sampleRate": round(self.sample_rate, 2),
            "sizeBytes": self.path.stat().st_size if self.path.exists() else 0,
            "mapping": self.mapping,
            "columns": self.columns,
        }

    def playback_payload(self, extra: list[str], max_points: int = 60_000) -> dict:
        """Time-aligned channel arrays for client-side playback. Decimated by
        stride if the log is enormous — playback interpolates anyway."""
        self.ensure_loaded()
        wanted: dict[str, str] = {}
        for role, col in self.mapping.items():
            if role != "time" and col in self.channels:
                wanted[role] = col
        for col in extra:
            if col in self.channels and col not in wanted.values():
                wanted[f"col:{col}"] = col

        n = self.time.size
        stride = max(1, math.ceil(n / max_points))
        t = self.time[::stride]
        series = {key: _json_safe(self.channels[col][::stride]) for key, col in wanted.items()}
        return {
            "t": _json_safe(t),
            "stride": stride,
            "series": series,
            "seriesColumns": wanted,
        }

    def downsampled(self, columns: list[str], t0: float, t1: float, points: int) -> dict:
        """Min/max bucket downsampling so spikes survive decimation."""
        self.ensure_loaded()
        i0, i1 = np.searchsorted(self.time, [t0, t1])
        i1 = min(int(i1) + 1, self.time.size)
        i0 = max(0, int(i0) - 1)
        seg_t = self.time[i0:i1]
        n = seg_t.size
        cols = [c for c in columns if c in self.channels]

        if n <= points * 2:
            return {
                "t": _json_safe(seg_t),
                "series": {c: _json_safe(self.channels[c][i0:i1]) for c in cols},
                "downsampled": False,
            }

        buckets = np.linspace(0, n, points + 1).astype(np.int64)
        out_t: list[float] = []
        out: dict[str, list] = {c: [] for c in cols}
        for b in range(points):
            lo, hi = buckets[b], buckets[b + 1]
            if hi <= lo:
                continue
            mid_t = float(seg_t[(lo + hi) // 2])
            for c in cols:
                seg = self.channels[c][i0 + lo:i0 + hi]
                finite = np.isfinite(seg)
                if not finite.any():
                    out[c].extend([None, None])
                    continue
                vmin_i = int(np.nanargmin(seg))
                vmax_i = int(np.nanargmax(seg))
                first, second = sorted([vmin_i, vmax_i])
                out[c].append(float(seg[first]))
                out[c].append(float(seg[second]))
            out_t.append(float(seg_t[lo + (hi - lo) // 4]))
            out_t.append(mid_t)
        return {"t": out_t, "series": out, "downsampled": True}

    def table_rows(self, offset: int, limit: int) -> dict:
        self.ensure_loaded()
        offset = max(0, offset)
        limit = max(1, min(limit, 500))
        names = [c["name"] for c in self.columns if c["numeric"]]
        rows = []
        end = min(offset + limit, self.time.size)
        for i in range(offset, end):
            row = {"t": round(float(self.time[i]), 4)}
            for nme in names:
                v = float(self.channels[nme][i])
                row[nme] = round(v, 5) if math.isfinite(v) else None
            rows.append(row)
        return {"offset": offset, "total": int(self.time.size), "columns": ["t"] + names, "rows": rows}


class DatasetManager:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._datasets: dict[str, Dataset] = {}
        self.rescan()

    def rescan(self) -> None:
        seen = set()
        for path in sorted(self.data_dir.glob("*.parquet")):
            ds_id = _slugify(path.stem)
            seen.add(ds_id)
            existing = self._datasets.get(ds_id)
            if existing is None or existing.path != path:
                self._datasets[ds_id] = Dataset(id=ds_id, path=path, name=path.stem)
        for ds_id in list(self._datasets):
            if ds_id not in seen:
                del self._datasets[ds_id]

    def list(self) -> list[dict]:
        out = []
        for ds in self._datasets.values():
            try:
                out.append(ds.summary())
            except Exception as exc:  # unreadable file: surface, don't crash the list
                out.append({"id": ds.id, "name": ds.name, "file": ds.path.name, "error": str(exc)})
        return out

    def get(self, ds_id: str) -> Optional[Dataset]:
        return self._datasets.get(ds_id)

    def add_file(self, filename: str, content: bytes) -> Dataset:
        safe = re.sub(r"[^\w\-\. ]+", "_", Path(filename).name)
        if not safe.endswith(".parquet"):
            safe += ".parquet"
        dest = self.data_dir / safe
        dest.write_bytes(content)
        # Validate it parses; delete if not.
        try:
            pq.read_schema(dest)
        except Exception:
            dest.unlink(missing_ok=True)
            raise ValueError(f"{filename} is not a valid parquet file")
        self.rescan()
        return self._datasets[_slugify(dest.stem)]
