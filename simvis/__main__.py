"""CLI entry point.

    python -m simvis serve [--data-dir data] [--host 0.0.0.0] [--port 8000]
    python -m simvis demo  [--data-dir data]
"""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(prog="simvis", description="Parquet vehicle playback & visualization")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="start the web server")
    serve.add_argument("--data-dir", default="data")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--demo", action="store_true", help="generate demo data if the data dir is empty")

    demo = sub.add_parser("demo", help="generate demo parquet logs")
    demo.add_argument("--data-dir", default="data")

    args = parser.parse_args()

    if args.command == "demo":
        from .sample_data import generate_all

        paths = generate_all(Path(args.data_dir))
        for p in paths:
            print(f"wrote {p}")
        return

    if args.command == "serve" or args.command is None:
        import uvicorn

        from .server import create_app

        data_dir = Path(getattr(args, "data_dir", "data"))
        if getattr(args, "demo", False) and not any(data_dir.glob("*.parquet")):
            from .sample_data import generate_all

            generate_all(data_dir)
        app = create_app(data_dir)
        uvicorn.run(app, host=getattr(args, "host", "127.0.0.1"), port=getattr(args, "port", 8000))
        return

    parser.print_help()


if __name__ == "__main__":
    main()
