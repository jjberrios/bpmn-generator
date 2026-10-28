"""Indexación estructural de código Java con tree-sitter (AST). No ejecuta ni compila el proyecto.

Produce un `ProjectIndex` con clases, métodos, campos, anotaciones, dependencias inyectadas y configuración,
más el mapa de arquitectura (architecture-map.json).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Optional

import tree_sitter_java as tsj
from tree_sitter import Language, Parser

JAVA_LANGUAGE = Language(tsj.language())

HTTP_MAPPINGS = {
    "GetMapping": "GET", "PostMapping": "POST", "PutMapping": "PUT", "DeleteMapping": "DELETE",
    "PatchMapping": "PATCH", "RequestMapping": None,
}
STEREOTYPES = {
    "RestController": "controller", "Controller": "controller", "Service": "service", "Repository": "repository",
    "Component": "other", "Configuration": "configuration", "Entity": "entity", "ControllerAdvice": "handler",
    "RestControllerAdvice": "handler", "FeignClient": "client", "Mapper": "other",
}
SPRING_DATA_BASES = {
    "JpaRepository", "CrudRepository", "PagingAndSortingRepository", "ListCrudRepository", "MongoRepository",
    "ReactiveCrudRepository", "R2dbcRepository", "JpaSpecificationExecutor", "Repository",
}
LISTENER_ANNOTATIONS = {
    "Scheduled": "scheduled", "KafkaListener": "listener", "JmsListener": "listener", "RabbitListener": "listener",
    "SqsListener": "listener", "EventListener": "event", "StreamListener": "listener",
}
HTTP_STATUS_CODES = {
    "OK": 200, "CREATED": 201, "ACCEPTED": 202, "NO_CONTENT": 204, "BAD_REQUEST": 400, "UNAUTHORIZED": 401,
    "FORBIDDEN": 403, "NOT_FOUND": 404, "METHOD_NOT_ALLOWED": 405, "CONFLICT": 409, "GONE": 410,
    "UNPROCESSABLE_ENTITY": 422, "TOO_MANY_REQUESTS": 429, "INTERNAL_SERVER_ERROR": 500, "NOT_IMPLEMENTED": 501,
    "BAD_GATEWAY": 502, "SERVICE_UNAVAILABLE": 503, "GATEWAY_TIMEOUT": 504,
}


def make_parser() -> Parser:
    return Parser(JAVA_LANGUAGE)


@dataclass
class Annotation:
    name: str
    args: dict  # clave -> texto literal ("" para valor posicional)
    raw: str
    line: int


@dataclass
class FieldInfo:
    name: str
    type: str
    annotations: list
    line: int
    initializer: str = ""


@dataclass
class MethodInfo:
    name: str
    params: list  # [(tipo, nombre)]
    return_type: str
    annotations: list
    line_start: int
    line_end: int
    node: object
    cls: "ClassInfo" = None
    is_constructor: bool = False

    @property
    def signature(self) -> str:
        return f"{self.name}({', '.join(t + ' ' + n for t, n in self.params)})"


@dataclass
class ClassInfo:
    name: str
    kind_decl: str  # class | interface | enum | record
    package: str
    file: str
    line: int
    annotations: list
    extends: Optional[str]
    implements: list
    fields: dict = field(default_factory=dict)
    methods: list = field(default_factory=list)
    source: bytes = b""
    kind: str = "other"
    imports: list = field(default_factory=list)
    node: object = None

    @property
    def ann_names(self) -> set:
        return {a.name for a in self.annotations}


def simple_type(text: str) -> str:
    """'Optional<Order>' -> 'Optional'; 'a.b.C' -> 'C'; arrays se simplifican."""
    t = re.sub(r"<.*>", "", text or "").replace("[]", "").strip()
    return t.split(".")[-1]


def node_text(src: bytes, n) -> str:
    return src[n.start_byte:n.end_byte].decode("utf-8", errors="replace") if n is not None else ""


def strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1]
    return s


def parse_annotations(src: bytes, modifiers) -> list:
    out = []
    if modifiers is None:
        return out
    for ch in modifiers.children:
        if ch.type == "marker_annotation":
            out.append(Annotation(simple_type(node_text(src, ch.child_by_field_name("name"))), {}, node_text(src, ch), ch.start_point[0] + 1))
        elif ch.type == "annotation":
            name = simple_type(node_text(src, ch.child_by_field_name("name")))
            args = {}
            arglist = ch.child_by_field_name("arguments")
            if arglist is not None:
                for a in arglist.named_children:
                    if a.type == "element_value_pair":
                        args[node_text(src, a.child_by_field_name("key"))] = node_text(src, a.child_by_field_name("value"))
                    else:
                        args[""] = node_text(src, a)
            out.append(Annotation(name, args, node_text(src, ch), ch.start_point[0] + 1))
    return out


def get_ann(annotations: list, *names: str) -> Optional[Annotation]:
    for a in annotations:
        if a.name in names:
            return a
    return None


def _modifiers(n):
    for ch in n.children:
        if ch.type == "modifiers":
            return ch
    return None


def _type_list(src: bytes, n) -> list:
    out = []
    if n is None:
        return out
    for ch in n.named_children:
        if ch.type == "type_list":
            out += [simple_type(node_text(src, t)) for t in ch.named_children]
        else:
            out.append(simple_type(node_text(src, ch)))
    return out


def parse_class(src: bytes, n, package: str, file: str, imports: list, parent: str = "") -> list:
    kind_map = {"class_declaration": "class", "interface_declaration": "interface", "enum_declaration": "enum", "record_declaration": "record"}
    if n.type not in kind_map:
        return []
    name = node_text(src, n.child_by_field_name("name"))
    anns = parse_annotations(src, _modifiers(n))
    extends, implements = None, []
    for ch in n.children:
        if ch.type == "superclass":
            extends = simple_type(node_text(src, ch).replace("extends", "", 1))
        elif ch.type == "super_interfaces":
            implements = _type_list(src, ch)
        elif ch.type == "extends_interfaces":
            implements = _type_list(src, ch)
    ci = ClassInfo(
        name=name if not parent else f"{parent}.{name}", kind_decl=kind_map[n.type], package=package, file=file,
        line=n.start_point[0] + 1, annotations=anns, extends=extends, implements=implements, source=src, imports=imports, node=n,
    )
    result = [ci]
    body = n.child_by_field_name("body")
    if body is None:
        return result
    for m in body.named_children:
        if m.type == "field_declaration":
            fanns = parse_annotations(src, _modifiers(m))
            ftype = node_text(src, m.child_by_field_name("type"))
            for d in m.children:
                if d.type == "variable_declarator":
                    fname = node_text(src, d.child_by_field_name("name"))
                    ci.fields[fname] = FieldInfo(fname, ftype, fanns, m.start_point[0] + 1,
                                               node_text(src, d.child_by_field_name("value")))
        elif m.type in ("method_declaration", "constructor_declaration"):
            mname = node_text(src, m.child_by_field_name("name"))
            params = []
            pl = m.child_by_field_name("parameters")
            if pl is not None:
                for p in pl.named_children:
                    if p.type in ("formal_parameter", "spread_parameter"):
                        tnode = p.child_by_field_name("type")
                        nnode = p.child_by_field_name("name")
                        if nnode is None:  # spread_parameter: nombre dentro de variable_declarator
                            for c in p.children:
                                if c.type == "variable_declarator":
                                    nnode = c.child_by_field_name("name")
                        params.append((node_text(src, tnode) if tnode is not None else "?", node_text(src, nnode)))
            rt = m.child_by_field_name("type")
            mi = MethodInfo(
                name=mname, params=params, return_type=node_text(src, rt) if rt is not None else "",
                annotations=parse_annotations(src, _modifiers(m)), line_start=m.start_point[0] + 1,
                line_end=m.end_point[0] + 1, node=m, cls=ci, is_constructor=m.type == "constructor_declaration",
            )
            ci.methods.append(mi)
        elif m.type in kind_map:
            result += parse_class(src, m, package, file, imports, ci.name)
    return result


def parse_java_file(parser: Parser, path: str, rel: str) -> list:
    with open(path, "rb") as f:
        src = f.read()
    tree = parser.parse(src)
    root = tree.root_node
    package, imports = "", []
    classes = []
    for ch in root.children:
        if ch.type == "package_declaration":
            package = node_text(src, ch).replace("package", "", 1).strip().rstrip(";").strip()
        elif ch.type == "import_declaration":
            imports.append(node_text(src, ch).replace("import", "", 1).strip().rstrip(";").strip())
    for ch in root.children:
        classes += parse_class(src, ch, package, rel, imports)
    return classes


def flatten_yaml(text: str) -> dict:
    """Aplanador mínimo de YAML por indentación (solo `clave: valor` anidados; sin listas ni anclas)."""
    out, stack = {}, []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if ":" not in line or line.startswith("- "):
            continue
        key, _, val = line.partition(":")
        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = [k for _, k in stack] + [key.strip()]
        val = val.strip()
        if val:
            out[".".join(path)] = val.strip("'\"")
        else:
            stack.append((indent, key.strip()))
    return out


def load_properties(text: str) -> dict:
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "!")) or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


class ProjectIndex:
    def __init__(self, source_root: str, files: list):
        self.source_root = source_root
        self.parser = make_parser()
        self.classes: dict = {}
        self.config: dict = {}
        self.build_info: dict = {"files": [], "frameworks": [], "java_version": None, "dependencies": []}
        self.parse_errors: list = []
        self._load(files)
        self._classify()
        self._index_impls()

    def _read(self, rel: str) -> str:
        with open(os.path.join(self.source_root, *rel.split("/")), "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def _load(self, files: list):
        for f in files:
            rel, cat = f["path"], f["category"]
            if f["language"] == "java" and cat == "source":
                try:
                    for ci in parse_java_file(self.parser, os.path.join(self.source_root, *rel.split("/")), rel):
                        self.classes.setdefault(ci.name, ci)
                except Exception as e:  # noqa: BLE001
                    self.parse_errors.append(f"{rel}: {e}")
            elif rel.lower().endswith((".yml", ".yaml")) and cat == "config":
                self.config.update(flatten_yaml(self._read(rel)))
            elif rel.lower().endswith(".properties") and cat == "config":
                self.config.update(load_properties(self._read(rel)))
            if f["category"] == "build":
                self.build_info["files"].append(rel)
                if rel.endswith("pom.xml"):
                    self._read_pom(self._read(rel))
                elif "gradle" in rel:
                    self._read_gradle(self._read(rel))

    def _read_pom(self, text: str):
        for m in re.finditer(r"<artifactId>([^<]+)</artifactId>", text):
            self.build_info["dependencies"].append(m.group(1))
        m = re.search(r"<(?:java\.version|maven\.compiler\.(?:source|release)|release)>([^<]+)<", text)
        if m:
            self.build_info["java_version"] = m.group(1)
        m = re.search(r"<parent>.*?<artifactId>spring-boot-starter-parent</artifactId>\s*<version>([^<]+)</version>", text, re.S)
        if m:
            self.build_info["frameworks"].append(("Spring Boot", m.group(1), "pom.xml: spring-boot-starter-parent"))

    def _read_gradle(self, text: str):
        for m in re.finditer(r"['\"]([\w.\-]+):([\w.\-]+)(?::([\w.\-${}]+))?['\"]", text):
            self.build_info["dependencies"].append(m.group(2))
        m = re.search(r"(?:sourceCompatibility|JavaVersion\.VERSION_)\s*=?\s*['\"]?([\d._]+)", text)
        if m:
            self.build_info["java_version"] = m.group(1).replace("_", ".")
        m = re.search(r"org\.springframework\.boot['\"]\)?\s*version\s*['\"]([^'\"]+)", text)
        if m:
            self.build_info["frameworks"].append(("Spring Boot", m.group(1), "build.gradle: plugin org.springframework.boot"))

    def _classify(self):
        for ci in self.classes.values():
            kind = "other"
            for a in ci.annotations:
                if a.name in STEREOTYPES:
                    cand = STEREOTYPES[a.name]
                    if kind == "other":
                        kind = cand
            if kind == "other":
                bases = set(ci.implements) | ({ci.extends} if ci.extends else set())
                if ci.kind_decl == "interface" and bases & SPRING_DATA_BASES:
                    kind = "repository"
                elif ci.extends and (ci.extends.endswith("Exception") or ci.extends in ("Throwable", "Error")):
                    kind = "exception"
                elif ci.name.endswith("Exception"):
                    kind = "exception"
                elif ci.name.endswith("Client") and ci.kind_decl != "interface":
                    kind = "client"
            if kind == "other" and ci.name.endswith("Repository") and ci.kind_decl == "interface":
                kind = "repository"
            if "Path" in ci.ann_names:
                kind = "controller"
            elif ci.ann_names & {"Stateless", "Stateful", "Singleton"} and kind == "other":
                # El rol EJB se deriva del nombre/paquete; no presupone comportamiento remoto.
                kind = "repository" if ci.name.endswith("Repository") else "service"
            elif "ApplicationPath" in ci.ann_names:
                kind = "configuration"
            ci.kind = kind

    def _index_impls(self):
        self.impls: dict = {}
        for ci in self.classes.values():
            if ci.kind_decl == "class":
                for iface in ci.implements:
                    self.impls.setdefault(iface, []).append(ci)
                if ci.extends:
                    self.impls.setdefault(ci.extends, []).append(ci)

    # ---------------- consultas ----------------
    def resolve_class(self, type_name: str) -> Optional[ClassInfo]:
        t = simple_type(type_name)
        return self.classes.get(t)

    def implementations(self, ci: ClassInfo) -> list:
        if ci.kind_decl == "class":
            return [ci]
        return list(self.impls.get(ci.name, []))

    def find_method(self, ci: ClassInfo, name: str, argc: int, arg_types=None) -> Optional[MethodInfo]:
        cands = [m for m in ci.methods if m.name == name and not m.is_constructor]
        exact = [m for m in cands if len(m.params) == argc]
        if len(exact) > 1 and arg_types:
            compatible = [m for m in exact if all(t is None or simple_type(p[0]) == simple_type(t) for p, t in zip(m.params, arg_types))]
            return compatible[0] if len(compatible) == 1 else None
        if len(exact) == 1:
            return exact[0]
        return cands[0] if len(cands) == 1 else None

    def exception_ancestors(self, name: str) -> list:
        chain, cur, guard = [], name, 0
        while cur and guard < 20:
            ci = self.classes.get(cur)
            if not ci or not ci.extends:
                if ci is None and cur not in chain:
                    pass
                break
            chain.append(ci.extends)
            cur = ci.extends
            guard += 1
        return chain

    def resolve_config(self, key: str) -> Optional[str]:
        return self.config.get(key)

    def exception_handlers(self) -> dict:
        """Mapa excepción -> manejador (@ExceptionHandler en clases @ControllerAdvice o controladores)."""
        out = {}
        for ci in self.classes.values():
            for m in ci.methods:
                ann = get_ann(m.annotations, "ExceptionHandler")
                if not ann:
                    continue
                raw = ann.args.get("") or ann.args.get("value") or ""
                excs = [simple_type(x.replace(".class", "")) for x in re.findall(r"[\w.]+\.class", raw)]
                body_text = node_text(ci.source, m.node)
                status = None
                sm = get_ann(m.annotations, "ResponseStatus")
                if sm:
                    mm = re.search(r"HttpStatus\.(\w+)", sm.raw)
                    status = mm.group(1) if mm else None
                if status is None:
                    mm = re.search(r"HttpStatus\.(\w+)", body_text)
                    status = mm.group(1) if mm else None
                for e in excs:
                    out[e] = {"class": ci.name, "method": m.name, "file": ci.file, "line_start": m.line_start, "line_end": m.line_end,
                              "status_name": status, "status_code": HTTP_STATUS_CODES.get(status) if status else None,
                              "header_line": ci.source.decode("utf-8", errors="replace").splitlines()[m.line_start - 1].strip()}
        return out


def build_architecture_map(idx: ProjectIndex, project_id: str, manifest: dict, entry_points: list, integrations: list, unresolved: list) -> dict:
    lang_counts = {}
    for f in manifest["files"]:
        if f["category"] in ("source", "test") and f["language"] not in ("unknown",):
            lang_counts[f["language"]] = lang_counts.get(f["language"], 0) + 1
    languages = [{"name": k, "files": v} for k, v in sorted(lang_counts.items())]
    if idx.build_info["java_version"]:
        for l in languages:
            if l["name"] == "java":
                l["version_hint"] = f"Java {idx.build_info['java_version']} (declarado en el build)"

    frameworks = [{"name": n, "version": v, "evidence": e} for n, v, e in idx.build_info["frameworks"]]
    dep_map = {
        "spring-boot-starter-web": "Spring MVC", "spring-boot-starter-webflux": "Spring WebFlux",
        "spring-boot-starter-data-jpa": "Spring Data JPA", "spring-cloud-starter-openfeign": "OpenFeign",
        "spring-boot-starter-jdbc": "JDBC (Spring)", "spring-kafka": "Spring Kafka", "spring-boot-starter-amqp": "Spring AMQP",
        "spring-boot-starter-data-mongodb": "Spring Data MongoDB",
    }
    seen = {f["name"] for f in frameworks}
    for dep in idx.build_info["dependencies"]:
        if dep in dep_map and dep_map[dep] not in seen:
            frameworks.append({"name": dep_map[dep], "evidence": f"dependencia de build: {dep}"})
            seen.add(dep_map[dep])
    import_map = {"org.springframework.web.client.RestTemplate": "RestTemplate", "org.springframework.web.reactive.function.client.WebClient": "WebClient",
                  "org.springframework.cloud.openfeign.FeignClient": "OpenFeign", "org.springframework.jdbc.core.JdbcTemplate": "JdbcTemplate"}
    for ci in idx.classes.values():
        for imp in ci.imports:
            nm = import_map.get(imp)
            if imp.startswith(("javax.ws.rs.", "jakarta.ws.rs.")):
                nm = "JAX-RS"
            elif imp.startswith(("javax.ejb.", "jakarta.ejb.")):
                nm = "EJB"
            elif imp.startswith(("javax.persistence.", "jakarta.persistence.")):
                nm = "JPA"
            elif imp.startswith("org.hibernate."):
                nm = "Hibernate"
            elif imp.startswith(("javax.xml.ws.", "jakarta.xml.ws.")):
                nm = "JAX-WS"
            if nm and nm not in seen:
                frameworks.append({"name": nm, "evidence": f"import en {ci.file}"})
                seen.add(nm)

    components = []
    for ci in sorted(idx.classes.values(), key=lambda c: (c.file, c.line)):
        deps = []
        ctor_params = [p for m in ci.methods if m.is_constructor for p in m.params]
        for t, n in ctor_params:
            deps.append((n, simple_type(t)))
        for fname, fi in ci.fields.items():
            if any(a.name in ("Autowired", "Inject", "Resource", "EJB", "PersistenceContext") for a in fi.annotations):
                deps.append((fname, simple_type(fi.type)))
        seen_d, dlist = set(), []
        for n, t in deps:
            if (n, t) in seen_d:
                continue
            seen_d.add((n, t))
            target = idx.classes.get(t)
            dlist.append({"name": n, "type": t, "resolved_component": f"{target.package}.{target.name}" if target else None})
        entry = {
            "id": f"{ci.package}.{ci.name}" if ci.package else ci.name, "kind": ci.kind, "class": ci.name,
            "package": ci.package, "file": ci.file, "line": ci.line, "annotations": [a.name for a in ci.annotations],
            "implements": ci.implements, "dependencies": dlist,
            "methods": [{"name": m.name, "signature": m.signature, "line_start": m.line_start, "line_end": m.line_end} for m in ci.methods],
        }
        if ci.extends:
            entry["extends"] = ci.extends
        components.append(entry)

    packages = sorted({c.package for c in idx.classes.values() if c.package})
    doc = [f["path"] for f in manifest["files"] if f["category"] == "documentation"]
    modules = []
    build_dirs = sorted({os.path.dirname(b) for b in idx.build_info["files"]}, key=len, reverse=True)
    for directory in build_dirs:
        owned = [c for c in idx.classes.values() if next((d for d in build_dirs if not d or c.file.startswith(d + "/")), "") == directory]
        modules.append({"name": os.path.basename(directory) or project_id, "path": directory or ".",
                        "packages": sorted({c.package for c in owned if c.package})})
    if not modules:
        modules = [{"name": project_id, "path": ".", "packages": packages}]
    return {
        "schema_version": "1.0", "project_id": project_id, "languages": languages, "frameworks": frameworks,
        "build_files": idx.build_info["files"], "modules": modules, "components": components,
        "entry_points": entry_points, "integrations": integrations, "documentation": doc, "unresolved": unresolved,
    }
