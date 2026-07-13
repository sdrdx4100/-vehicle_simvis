"""FastAPI application: REST API + static frontend."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .datasets import DatasetManager
from .sample_data import generate_all
from .shifts import analyze as analyze_shifts, detail as shift_detail

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def create_app(data_dir: str | Path | None = None) -> FastAPI:
    data_dir = Path(data_dir or os.environ.get("SIMVIS_DATA_DIR", "data"))
    manager = DatasetManager(data_dir)

    app = FastAPI(title="simvis", version=__version__)
    app.state.manager = manager

    def _dataset(ds_id: str):
        ds = manager.get(ds_id)
        if ds is None:
            raise HTTPException(404, f"dataset '{ds_id}' not found")
        try:
            ds.ensure_loaded()
        except Exception as exc:
            raise HTTPException(422, f"failed to read parquet: {exc}") from exc
        return ds

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__, "dataDir": str(manager.data_dir)}

    @app.get("/api/datasets")
    def list_datasets():
        manager.rescan()
        return {"datasets": manager.list()}

    @app.post("/api/datasets/upload")
    async def upload(file: UploadFile):
        content = await file.read()
        if len(content) > 512 * 1024 * 1024:
            raise HTTPException(413, "file too large (512MB limit)")
        try:
            ds = manager.add_file(file.filename or "upload.parquet", content)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return ds.summary()

    @app.post("/api/demo")
    def make_demo():
        generate_all(manager.data_dir)
        manager.rescan()
        return {"datasets": manager.list()}

    @app.get("/api/datasets/{ds_id}")
    def dataset_meta(ds_id: str):
        return _dataset(ds_id).summary()

    @app.get("/api/datasets/{ds_id}/playback")
    def playback(ds_id: str, extra: str = Query("", description="comma-separated extra columns")):
        cols = [c for c in extra.split(",") if c]
        return _dataset(ds_id).playback_payload(cols)

    @app.get("/api/datasets/{ds_id}/signals")
    def signals(
        ds_id: str,
        columns: str = Query(..., description="comma-separated column names"),
        t0: float = 0.0,
        t1: float = 1e18,
        points: int = Query(1500, ge=10, le=20000),
    ):
        cols = [c for c in columns.split(",") if c]
        return _dataset(ds_id).downsampled(cols, t0, t1, points)

    @app.get("/api/datasets/{ds_id}/shifts")
    def shifts(ds_id: str):
        return analyze_shifts(_dataset(ds_id))

    @app.get("/api/datasets/{ds_id}/shifts/{event_index}")
    def shift_waveform(ds_id: str, event_index: int):
        try:
            return shift_detail(_dataset(ds_id), event_index)
        except IndexError as exc:
            raise HTTPException(404, f"shift event {event_index} not found") from exc

    @app.get("/api/datasets/{ds_id}/table")
    def table(ds_id: str, offset: int = 0, limit: int = 100):
        return _dataset(ds_id).table_rows(offset, limit)

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app
