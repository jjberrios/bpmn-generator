#!/usr/bin/env python3
"""Extracción segura de proyectos ZIP (skill project-ingestion).

Garantías:
  * No ejecuta nada del contenido extraído.
  * Previene Zip Slip / rutas absolutas / unidades / ADS / nombres reservados de Windows.
  * Rechaza enlaces simbólicos (no se materializan nunca).
  * Límites configurables de archivos, tamaño individual, tamaño total, ratio de compresión y profundidad.
  * Los tamaños se miden leyendo realmente los bytes (no se confía en las cabeceras del ZIP).
  * Nunca sobrescribe archivos (creación exclusiva); entradas duplicadas se descartan y se reportan.
  * Excluye binarios y directorios irrelevantes; no extrae archivos sensibles (claves, .env, keystores)
    y redacta valores de credenciales en archivos de configuración extraídos.
  * Genera `repository-manifest.json` conforme a schemas/repository-manifest.schema.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import zipfile
from pathlib import PurePosixPath

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

DEFAULT_LIMITS = {
    "max_files": 20000,
    "max_total_bytes": 500 * 1024 * 1024,
    "max_file_bytes": 25 * 1024 * 1024,
    "max_ratio": 200.0,
    "max_depth": 30,
}

IRRELEVANT_DIRS = {
    ".git", ".svn", ".hg", ".idea", ".vscode", ".gradle", "node_modules", "target", "build", "out",
    "__pycache__", ".settings", "bin", "dist", ".mvn_repository", "__macosx", ".DS_Store".lower(),
}
BINARY_EXT = {
    ".class", ".jar", ".war", ".ear", ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".bin", ".png", ".jpg",
    ".jpeg", ".gif", ".bmp", ".ico", ".svgz", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar", ".bz2", ".xz", ".mp3", ".mp4", ".avi", ".mov", ".woff",
    ".woff2", ".ttf", ".eot", ".pyc", ".lock",
}
SENSITIVE_NAME_PATTERNS = [
    (re.compile(r"(^|/)\.env(\..+)?$", re.I), "archivo de variables de entorno"),
    (re.compile(r"\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$", re.I), "clave/certificado/keystore"),
    (re.compile(r"(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$", re.I), "clave SSH"),
    (re.compile(r"(^|/)(credentials?|secrets?)(\.[a-z]+)?$", re.I), "archivo de credenciales"),
    (re.compile(r"(^|/)\.(npmrc|pypirc|netrc|htpasswd)$", re.I), "archivo de credenciales de herramienta"),
]
ENV_EXAMPLE = re.compile(r"\.env\.(example|sample|template)$", re.I)
PRIVATE_KEY_BLOCK = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")
SECRET_LINE = re.compile(
    r"(?im)^(\s*[\w.\-\[\]\"']*(?:password|passwd|pwd|secret|token|api[-_]?key|credential|private[-_]?key|client[-_]?secret)[\w.\-\]\"']*\s*[:=]\s*)(?!\s*$)(?!<REDACTADO>)(\S.*)$"
)
CONFIG_EXT = {".properties", ".yml", ".yaml", ".env", ".conf", ".ini", ".toml"}
WIN_RESERVED = {"con", "prn", "aux", "nul", *{f"com{i}" for i in range(1, 10)}, *{f"lpt{i}" for i in range(1, 10)}}
INVALID_CHARS = set('<>:"|?*\0')

LANG_BY_EXT = {
    ".java": "java", ".kt": "kotlin", ".scala": "scala", ".groovy": "groovy", ".py": "python", ".js": "javascript",
    ".ts": "typescript", ".cs": "csharp", ".go": "go", ".rb": "ruby", ".php": "php", ".sql": "sql",
    ".xml": "xml", ".yml": "yaml", ".yaml": "yaml", ".json": "json", ".properties": "properties",
    ".md": "markdown", ".txt": "text", ".gradle": "gradle", ".wsdl": "xml", ".xsd": "xml", ".html": "html",
    ".adoc": "asciidoc", ".rst": "rst", ".sh": "shell", ".bat": "batch", ".toml": "toml",
}
SOURCE_EXT = {".java", ".kt", ".scala", ".groovy", ".py", ".js", ".ts", ".cs", ".go", ".rb", ".php"}
BUILD_NAMES = {"pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "package.json", "requirements.txt", "go.mod"}
DOC_EXT = {".md", ".txt", ".adoc", ".rst"}


class IngestionError(Exception):
    """Entrada rechazada por validación o seguridad."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return mode != 0 and stat.S_ISLNK(mode)


def check_path(name: str, max_depth: int) -> str:
    """Valida y normaliza el nombre de entrada. Devuelve ruta POSIX relativa o lanza IngestionError."""
    if not name or "\0" in name:
        raise IngestionError("nombre vacío o con byte nulo")
    norm = name.replace("\\", "/")
    if norm.startswith("/") or re.match(r"^[A-Za-z]:", norm):
        raise IngestionError("ruta absoluta o con unidad")
    parts = [p for p in norm.split("/") if p not in ("",)]
    if any(p == ".." for p in parts):
        raise IngestionError("path traversal ('..')")
    parts = [p for p in parts if p != "."]
    if not parts:
        raise IngestionError("ruta vacía tras normalizar")
    if len(parts) > max_depth:
        raise IngestionError(f"profundidad {len(parts)} supera el límite {max_depth}")
    for p in parts:
        if any(c in INVALID_CHARS for c in p):
            raise IngestionError("caracteres no permitidos en Windows (incluye ':' / ADS)")
        if p.endswith(".") or p.endswith(" "):
            raise IngestionError("segmento termina en punto o espacio")
        if p.split(".")[0].lower() in WIN_RESERVED:
            raise IngestionError("nombre reservado de Windows")
    return "/".join(parts)


def classify(path: str) -> tuple[str, str]:
    p = PurePosixPath(path)
    ext = p.suffix.lower()
    name = p.name.lower()
    lang = LANG_BY_EXT.get(ext, "unknown")
    lowered = "/" + path.lower()
    if name in BUILD_NAMES:
        cat = "build"
    elif ext in SOURCE_EXT:
        cat = "test" if ("/src/test/" in lowered or "/tests/" in lowered or "/test/" in lowered or p.stem.endswith(("Test", "Tests", "IT"))) else "source"
    elif ext in DOC_EXT or name in {"readme", "license"}:
        cat = "documentation"
    elif ext in CONFIG_EXT or ext in {".xml", ".json"} or name.startswith(("application", "bootstrap")):
        cat = "config"
    elif ext in {".sql", ".wsdl", ".xsd", ".html"}:
        cat = "resource"
    else:
        cat = "other"
    return lang, cat


def sensitive_reason(path: str) -> str | None:
    if ENV_EXAMPLE.search(path):
        return None
    for pat, reason in SENSITIVE_NAME_PATTERNS:
        if pat.search(path):
            return reason
    return None


def looks_binary(sample: bytes) -> bool:
    return b"\0" in sample


def redact_secrets(text: str) -> tuple[str, int]:
    count = 0

    def sub(m: re.Match) -> str:
        nonlocal count
        count += 1
        return m.group(1) + "<REDACTADO>"

    return SECRET_LINE.sub(sub, text), count


def read_limited(zf: zipfile.ZipFile, info: zipfile.ZipInfo, max_bytes: int) -> bytes:
    """Lee la entrada deteniéndose si supera max_bytes reales (defensa ante cabeceras falsas)."""
    chunks, total = [], 0
    with zf.open(info, "r") as src:
        while True:
            chunk = src.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise IngestionError(f"'{info.filename}' excede {max_bytes} bytes reales al descomprimir")
            chunks.append(chunk)
    return b"".join(chunks)


def ingest(zip_path: str, workspace_root: str, project_id: str | None, limits: dict, force: bool = False) -> dict:
    zip_path = os.path.abspath(zip_path)
    if not os.path.isfile(zip_path):
        raise IngestionError(f"No existe el ZIP: {zip_path}")
    size = os.path.getsize(zip_path)
    if size == 0 or not zipfile.is_zipfile(zip_path):
        raise IngestionError("El archivo no es un ZIP válido (vacío, truncado o formato distinto)")

    base = os.path.splitext(os.path.basename(zip_path))[0]
    pid = project_id or re.sub(r"[^A-Za-z0-9_.-]", "_", base) or "proyecto"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", pid) or pid in {".", ".."}:
        raise IngestionError("project_id inválido")

    workspace_root = os.path.abspath(workspace_root)
    out_dir = os.path.abspath(os.path.join(workspace_root, pid))
    if os.path.commonpath([workspace_root, out_dir]) != workspace_root or out_dir == workspace_root:
        raise IngestionError("El directorio de destino debe estar dentro del workspace")
    if os.path.exists(out_dir):
        marker = os.path.join(out_dir, "repository-manifest.json")
        if force and os.path.isfile(marker):
            shutil.rmtree(out_dir)
        else:
            raise IngestionError(f"El destino ya existe: {out_dir}. Use --force para reemplazar una extracción previa")
    src_root = os.path.join(out_dir, "source")

    try:
        zf = zipfile.ZipFile(zip_path, "r")
    except zipfile.BadZipFile as e:
        raise IngestionError(f"ZIP corrupto: {e}")

    warnings: list[str] = []
    excluded: list[dict] = []
    sensitive: list[dict] = []
    files: list[dict] = []
    seen: set[str] = set()
    total_bytes = 0

    with zf:
        infos = zf.infolist()
        if not infos or all(i.is_dir() for i in infos):
            raise IngestionError("El ZIP está vacío (sin archivos)")
        if len(infos) > limits["max_files"]:
            raise IngestionError(f"El ZIP contiene {len(infos)} entradas; el límite es {limits['max_files']}")
        declared = sum(i.file_size for i in infos)
        if declared > limits["max_total_bytes"]:
            raise IngestionError(f"Tamaño total declarado {declared} supera el límite {limits['max_total_bytes']}")
        for i in infos:
            if i.is_dir():
                continue
            if i.file_size > limits["max_file_bytes"]:
                raise IngestionError(f"'{i.filename}' declara {i.file_size} bytes; límite por archivo {limits['max_file_bytes']}")
            if i.compress_size > 0 and i.file_size / i.compress_size > limits["max_ratio"] and i.file_size > 1024 * 1024:
                raise IngestionError(f"'{i.filename}' tiene ratio de compresión {i.file_size / i.compress_size:.0f}:1 (posible ZIP bomb)")
        bad = zf.testzip()
        if bad is not None:
            raise IngestionError(f"ZIP corrupto: falla la verificación CRC en '{bad}'")

        os.makedirs(src_root, exist_ok=False)
        real_root = os.path.realpath(src_root)

        for info in infos:
            raw_name = info.filename
            if info.is_dir():
                try:
                    check_path(raw_name, limits["max_depth"])
                except IngestionError as e:
                    shutil.rmtree(out_dir, ignore_errors=True)
                    raise IngestionError(f"Entrada peligrosa rechazada '{raw_name}': {e}")
                continue
            try:
                rel = check_path(raw_name, limits["max_depth"])
            except IngestionError as e:
                # Una ruta peligrosa invalida el ZIP completo: no se extrae nada parcialmente.
                shutil.rmtree(out_dir, ignore_errors=True)
                raise IngestionError(f"Entrada peligrosa rechazada '{raw_name}': {e}")
            if is_symlink(info):
                shutil.rmtree(out_dir, ignore_errors=True)
                raise IngestionError(f"Enlace simbólico rechazado: '{raw_name}'")

            key = rel.lower()
            if key in seen:
                excluded.append({"path": rel, "reason": "entrada duplicada en el ZIP (se conserva la primera)", "kind": "duplicado"})
                warnings.append(f"Entrada duplicada descartada: {rel}")
                continue
            seen.add(key)

            parts = [p.lower() for p in rel.split("/")]
            if any(p in IRRELEVANT_DIRS for p in parts[:-1]):
                excluded.append({"path": rel, "reason": "directorio irrelevante", "kind": "irrelevante"})
                continue
            ext = PurePosixPath(rel).suffix.lower()
            if ext in BINARY_EXT:
                excluded.append({"path": rel, "reason": f"binario/no analizable ({ext})", "kind": "binario"})
                continue
            reason = sensitive_reason(rel)
            if reason:
                sensitive.append({"path": rel, "reason": reason, "extracted": False})
                excluded.append({"path": rel, "reason": f"sensible, no extraído: {reason}", "kind": "seguridad"})
                continue

            data = read_limited(zf, info, limits["max_file_bytes"])
            if looks_binary(data[:8192]):
                excluded.append({"path": rel, "reason": "contenido binario detectado", "kind": "binario"})
                continue
            if PRIVATE_KEY_BLOCK.search(data):
                sensitive.append({"path": rel, "reason": "contiene bloque de clave privada", "extracted": False})
                excluded.append({"path": rel, "reason": "sensible, no extraído: clave privada", "kind": "seguridad"})
                continue
            total_bytes += len(data)
            if total_bytes > limits["max_total_bytes"]:
                shutil.rmtree(out_dir, ignore_errors=True)
                raise IngestionError(f"La expansión real supera el límite total de {limits['max_total_bytes']} bytes")

            lang, cat = classify(rel)
            if PurePosixPath(rel).suffix.lower() in CONFIG_EXT or cat == "config":
                text = data.decode("utf-8", errors="replace")
                redacted, n = redact_secrets(text)
                if n:
                    data = redacted.encode("utf-8")
                    sensitive.append({"path": rel, "reason": f"{n} valor(es) de credencial redactados en la copia extraída", "extracted": True})

            dest = os.path.abspath(os.path.join(src_root, *rel.split("/")))
            real_parent = os.path.realpath(os.path.dirname(dest))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            real_parent = os.path.realpath(os.path.dirname(dest))
            if os.path.commonpath([real_root, real_parent]) != real_root:
                shutil.rmtree(out_dir, ignore_errors=True)
                raise IngestionError(f"Escape del directorio de extracción detectado: '{raw_name}'")
            with open(dest, "xb") as f:  # modo exclusivo: nunca sobrescribe
                f.write(data)
            files.append({"path": rel, "size_bytes": len(data), "sha256": sha256_bytes(data), "language": lang, "category": cat})

    if not files:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise IngestionError("El ZIP no contiene archivos analizables tras aplicar las exclusiones")

    files.sort(key=lambda x: x["path"])
    if any(e["kind"] == "binario" and e["path"].lower().endswith((".pdf", ".doc", ".docx")) for e in excluded):
        warnings.append("Se excluyeron documentos binarios (PDF/Office): su contenido no se analiza; inspecciónelos manualmente si contienen documentación funcional.")

    manifest = {
        "schema_version": "1.0",
        "project_id": pid,
        "source": {"name": os.path.basename(zip_path), "sha256": sha256_file(zip_path), "size_bytes": size},
        "extracted_root": os.path.relpath(src_root, REPO_ROOT).replace("\\", "/") if src_root.startswith(REPO_ROOT) else src_root,
        "limits": limits,
        "files": files,
        "excluded": excluded,
        "sensitive_files": sensitive,
        "totals": {
            "entries_in_zip": len(infos),
            "files_extracted": len(files),
            "bytes_extracted": total_bytes,
            "files_excluded": len(excluded),
        },
        "warnings": warnings,
    }
    with open(os.path.join(out_dir, "repository-manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Extracción segura de un ZIP de proyecto en workspace/<project_id>/source")
    ap.add_argument("zip", help="Ruta al archivo ZIP")
    ap.add_argument("--workspace-root", default=os.path.join(REPO_ROOT, "workspace"))
    ap.add_argument("--project-id", default=None)
    ap.add_argument("--force", action="store_true", help="Reemplaza una extracción previa (solo si contiene repository-manifest.json)")
    ap.add_argument("--max-files", type=int, default=DEFAULT_LIMITS["max_files"])
    ap.add_argument("--max-total-bytes", type=int, default=DEFAULT_LIMITS["max_total_bytes"])
    ap.add_argument("--max-file-bytes", type=int, default=DEFAULT_LIMITS["max_file_bytes"])
    ap.add_argument("--max-ratio", type=float, default=DEFAULT_LIMITS["max_ratio"])
    ap.add_argument("--max-depth", type=int, default=DEFAULT_LIMITS["max_depth"])
    args = ap.parse_args(argv)
    limits = {
        "max_files": args.max_files,
        "max_total_bytes": args.max_total_bytes,
        "max_file_bytes": args.max_file_bytes,
        "max_ratio": args.max_ratio,
        "max_depth": args.max_depth,
    }
    try:
        manifest = ingest(args.zip, args.workspace_root, args.project_id, limits, args.force)
    except IngestionError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 2
    print(json.dumps({
        "ok": True,
        "project_id": manifest["project_id"],
        "source_dir": manifest["extracted_root"],
        "manifest": os.path.join(os.path.abspath(args.workspace_root), manifest["project_id"], "repository-manifest.json"),
        "totals": manifest["totals"],
        "sensitive_files": len(manifest["sensitive_files"]),
        "warnings": manifest["warnings"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
