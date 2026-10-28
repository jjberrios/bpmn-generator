#!/usr/bin/env python3
"""Análisis estructural determinista de un proyecto ya ingerido (skill source-code-analysis).

Entrada : workspace/<project_id>/repository-manifest.json + source/
Salida  : workspace/<project_id>/analysis/architecture-map.json y execution-trace.json

Analizadores registrados por lenguaje (extensible): hoy solo Java. Los lenguajes sin analizador se
registran en `unresolved` del mapa de arquitectura (no se adivina nada).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from java_index import ProjectIndex, build_architecture_map  # noqa: E402
from java_trace import TraceBuilder, discover_entry_points, discover_integrations  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ANALYZERS = {"java": "java_index"}  # registro: lenguaje -> módulo (punto de extensión)


def analyze(project_dir: str) -> dict:
    manifest_path = os.path.join(project_dir, "repository-manifest.json")
    if not os.path.isfile(manifest_path):
        raise SystemExit(json.dumps({"ok": False, "error": f"No existe {manifest_path}; ejecute primero la ingesta"}, ensure_ascii=False))
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    pid = manifest["project_id"]
    source_root = os.path.join(project_dir, "source")

    unresolved = []
    langs = {f["language"] for f in manifest["files"] if f["category"] == "source"}
    for lang in sorted(langs - set(ANALYZERS)):
        unresolved.append({"description": f"No hay analizador estructural para el lenguaje '{lang}'; sus archivos no se incluyen en el grafo."})

    idx = ProjectIndex(source_root, manifest["files"])
    for err in idx.parse_errors:
        unresolved.append({"description": f"Error de análisis sintáctico: {err}"})
    entry_points = discover_entry_points(idx)
    integrations = discover_integrations(idx)
    arch = build_architecture_map(idx, pid, manifest, [{k: v for k, v in e.items() if k not in ("class_key", "method_line")} for e in entry_points], integrations, unresolved)

    traces = []
    for ep in entry_points:
        if ep["kind"] == "main":
            continue
        builder = TraceBuilder(idx, ep, f"TR_{ep['id']}")
        traces.append(builder.build())
    trace_doc = {"schema_version": "1.0", "project_id": pid, "generator": "tools/analysis/analyze_project.py (tree-sitter-java)", "traces": traces}

    out_dir = os.path.join(project_dir, "analysis")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "architecture-map.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(arch, f, ensure_ascii=False, indent=2)
        f.write("\n")
    with open(os.path.join(out_dir, "execution-trace.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(trace_doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return {"ok": True, "project_id": pid, "analysis_dir": out_dir, "components": len(arch["components"]), "entry_points": len(entry_points),
            "integrations": len(integrations), "traces": len(traces),
            "paths": {t["id"]: len(t["paths"]) for t in traces}, "unresolved": len(unresolved)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Análisis estructural (AST) de un proyecto ingerido")
    ap.add_argument("project_dir", help="Directorio workspace/<project_id>")
    args = ap.parse_args(argv)
    res = analyze(os.path.abspath(args.project_dir))
    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
