#!/usr/bin/env python3
"""Construye de forma determinista tests/fixtures/orders-service.zip a partir del directorio del fixture."""
from __future__ import annotations

import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.join(HERE, "orders-service")
DEFAULT_OUT = os.path.join(HERE, "orders-service.zip")
FIXED_TIME = (2024, 1, 1, 0, 0, 0)


def build(out_path: str = DEFAULT_OUT) -> str:
    entries = []
    for root, _dirs, files in os.walk(FIXTURE_DIR):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, FIXTURE_DIR).replace(os.sep, "/")
            entries.append((rel, full))
    entries.sort()
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, full in entries:
            info = zipfile.ZipInfo(rel, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            with open(full, "rb") as f:
                zf.writestr(info, f.read())
    return out_path


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    print(build(out))
