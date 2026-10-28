"""Reconstrucción de rutas de ejecución (execution-trace) desde cada punto de entrada.

Estrategia: se recorre el AST del método de entrada y se inlinan las invocaciones resolubles estáticamente
(proyecto), generando un grafo de nodos/aristas con evidencia (archivo, líneas, fragmento literal).
Todo lo no resoluble se registra como `unresolved_call` + limitación (nunca se adivina).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from java_index import (
    HTTP_MAPPINGS, HTTP_STATUS_CODES, LISTENER_ANNOTATIONS, ClassInfo, MethodInfo, ProjectIndex, get_ann,
    node_text, simple_type, strip_quotes,
)

MAX_DEPTH = 8
MAX_NODES = 600
MAX_PATHS = 300

EXTERNAL_HTTP_TYPES = {"RestTemplate", "TestRestTemplate", "WebClient", "RestClient", "HttpClient", "OkHttpClient", "CloseableHttpClient", "WebServiceTemplate"}
JDBC_TYPES = {"JdbcTemplate", "NamedParameterJdbcTemplate", "JdbcOperations", "EntityManager", "SimpleJdbcCall", "SimpleJdbcInsert", "DSLContext", "CallableStatement", "OracleCallableStatement", "PreparedStatement", "Statement"}
MESSAGING_TYPES = {"KafkaTemplate", "JmsTemplate", "RabbitTemplate", "AmqpTemplate", "StreamBridge", "ApplicationEventPublisher", "SqsTemplate", "SnsTemplate"}
IGNORED_TYPES = {
    "String", "Optional", "List", "ArrayList", "Map", "HashMap", "Set", "HashSet", "Collection", "Collections", "Objects", "Arrays",
    "Stream", "StringBuilder", "Integer", "Long", "Boolean", "Double", "Math", "System", "Logger", "Log", "LoggerFactory", "UUID",
    "BigDecimal", "Instant", "Duration", "LocalDate", "LocalDateTime", "ResponseEntity", "HttpStatus", "ObjectMapper", "Pattern",
    "Matcher", "StringUtils", "Object", "Thread", "Character", "Date", "Iterator", "Throwable", "Exception", "RuntimeException",
}
READ_PREFIXES = ("find", "get", "exists", "count", "read", "query", "select", "load", "search", "list", "fetch", "stream")
WRITE_PREFIXES = ("save", "delete", "remove", "insert", "update", "persist", "merge", "flush", "create", "store")
GENERIC_CATCH = {"Exception", "Throwable", "RuntimeException"}


@dataclass
class Handler:
    types: list
    pending: list = field(default_factory=list)  # [(node_id, kind, cond)]


@dataclass
class Ctx:
    cls: ClassInfo
    method: MethodInfo
    locals: dict
    depth: int
    stack: tuple
    handlers: list  # pila compartida de marcos: cada marco = lista[Handler]
    returns: list = field(default_factory=list)


class TraceBuilder:
    def __init__(self, idx: ProjectIndex, entry: dict, trace_id: str):
        self.idx = idx
        self.entry = entry
        self.trace_id = trace_id
        self.nodes: list = []
        self.edges: list = []
        self.evidence: list = []
        self.limitations: list = []
        self.exc_handlers = idx.exception_handlers()
        self._n = 0
        self._e = 0
        self._ev = 0
        self.truncated = False

    # ---------------- utilidades de grafo ----------------
    def _new_id(self, prefix: str) -> str:
        if prefix == "N":
            self._n += 1
            return f"N{self._n}"
        self._e += 1
        return f"E{self._e}"

    def add_evidence(self, ci: ClassInfo, method: Optional[MethodInfo], node, status: str = "CONFIRMADA", justification: str = "") -> str:
        self._ev += 1
        eid = f"EV{self._ev}"
        start, end = node.start_point[0] + 1, node.end_point[0] + 1
        lines = ci.source.decode("utf-8", errors="replace").splitlines()
        snippet = lines[start - 1].strip()[:300] if 0 < start <= len(lines) else ""
        ev = {"id": eid, "status": status, "file": ci.file, "line_start": start, "line_end": end, "class": ci.name, "snippet": snippet}
        if method is not None:
            ev["method"] = method.name
        if justification:
            ev["justification"] = justification
        self.evidence.append(ev)
        return eid

    def node(self, type_: str, label: str, ctx: Ctx, ast, **kw) -> str:
        if len(self.nodes) >= MAX_NODES:
            if not self.truncated:
                self.truncated = True
                self.limitations.append({"description": f"Traza truncada: se alcanzó el máximo de {MAX_NODES} nodos."})
            raise _Truncated()
        nid = self._new_id("N")
        eid = self.add_evidence(ctx.cls, ctx.method, ast, kw.pop("ev_status", "CONFIRMADA"), kw.pop("ev_just", ""))
        n = {"id": nid, "type": type_, "label": label[:240], "class": ctx.cls.name, "method": ctx.method.name, "evidence_id": eid,
             "resolution": kw.pop("resolution", "DIRECTA")}
        for k, v in kw.items():
            if v not in (None, ""):
                n[k] = v
        self.nodes.append(n)
        return nid

    def connect(self, ends: list, to: str):
        for src, kind, cond in ends:
            e = {"id": self._new_id("E"), "from": src, "to": to, "kind": kind}
            if cond:
                e["condition"] = cond[:240]
            self.edges.append(e)

    def limitation(self, desc: str, node_id: Optional[str] = None):
        item = {"description": desc}
        if node_id:
            item["node_id"] = node_id
        if item not in self.limitations:
            self.limitations.append(item)

    # ---------------- resolución de tipos ----------------
    def type_of(self, ctx: Ctx, expr) -> Optional[str]:
        src = ctx.cls.source
        if expr is None:
            return None
        t = expr.type
        if t == "identifier":
            name = node_text(src, expr)
            if name in ctx.locals:
                return simple_type(ctx.locals[name])
            fi = ctx.cls.fields.get(name)
            if fi:
                return simple_type(fi.type)
            if name[:1].isupper():
                return name
            return None
        if t == "field_access":
            obj, fld = expr.child_by_field_name("object"), expr.child_by_field_name("field")
            if obj is not None and node_text(src, obj) == "this":
                fi = ctx.cls.fields.get(node_text(src, fld))
                return simple_type(fi.type) if fi else None
            return None
        if t == "this":
            return ctx.cls.name
        if t in ("object_creation_expression", "cast_expression"):
            return simple_type(node_text(src, expr.child_by_field_name("type")))
        if t == "string_literal":
            return "String"
        return None

    def is_field_ref(self, ctx: Ctx, expr) -> bool:
        src = ctx.cls.source
        if expr.type == "identifier":
            n = node_text(src, expr)
            return n not in ctx.locals and n in ctx.cls.fields
        return expr.type == "field_access"

    # ---------------- recorrido ----------------
    def build(self) -> dict:
        ci = self.idx.classes[self.entry["class_key"]]
        mi = next(m for m in ci.methods if m.name == self.entry["method"] and m.line_start == self.entry["line"] or m.name == self.entry["method"])
        for m in ci.methods:
            if m.name == self.entry["method"] and m.line_start == self.entry.get("method_line", m.line_start):
                mi = m
        locals_ = {n: t for t, n in mi.params}
        ctx = Ctx(ci, mi, locals_, 0, ((ci.name, mi.name),), [])
        label = f"{self.entry.get('http_method', '')} {self.entry.get('path', '')}".strip() or f"{ci.name}.{mi.name}"
        try:
            entry_id = self.node("entry", label, ctx, mi.node, outcome=None, ev_status="CONFIRMADA")
            ends = [(entry_id, "next", None)]
            ends = self.walk_method_body(ctx, ends)
            # fin sin return explícito (void) en el método de entrada
            for end in ends:
                pass
        except _Truncated:
            pass
        paths = self.enumerate_paths()
        return {
            "id": self.trace_id, "entry_point_id": self.entry["id"],
            "entry": {k: v for k, v in {"class": ci.name, "method": mi.name, "kind": self.entry.get("kind"),
                                        "http_method": self.entry.get("http_method"), "path": self.entry.get("path")}.items() if v},
            "nodes": self.nodes, "edges": self.edges, "evidence": self.evidence, "paths": paths, "limitations": self.limitations,
        }

    def walk_method_body(self, ctx: Ctx, ends: list) -> list:
        body = ctx.method.node.child_by_field_name("body")
        if body is None:
            return ends
        stmts = [c for c in body.named_children]
        out = self.walk_stmts(stmts, ends, ctx, top_level=True)
        return out + ctx.returns if ctx.depth > 0 else out + ctx.returns

    def walk_stmts(self, stmts: list, ends: list, ctx: Ctx, top_level: bool = False) -> list:
        for i, st in enumerate(stmts):
            if not ends:
                break
            if st.type in ("line_comment", "block_comment"):
                continue
            is_last = top_level and i == len(stmts) - 1
            ends = self.walk_stmt(st, ends, ctx, is_last)
        return ends

    def walk_stmt(self, st, ends: list, ctx: Ctx, is_last: bool = False) -> list:
        t = st.type
        src = ctx.cls.source
        if t == "block":
            return self.walk_stmts([c for c in st.named_children], ends, ctx, top_level=is_last)
        if t == "local_variable_declaration":
            tnode = st.child_by_field_name("type")
            ttext = node_text(src, tnode)
            for d in st.children:
                if d.type == "variable_declarator":
                    nm = node_text(src, d.child_by_field_name("name"))
                    tt = simple_type(ttext)
                    if tt == "var":
                        val = d.child_by_field_name("value")
                        if val is not None and val.type == "object_creation_expression":
                            tt = simple_type(node_text(src, val.child_by_field_name("type")))
                        else:
                            tt = "?"
                    ctx.locals[nm] = tt
            return self.process_expressions(st, ends, ctx)
        if t == "expression_statement":
            return self.process_expressions(st, ends, ctx)
        if t == "if_statement":
            return self.walk_if(st, ends, ctx, is_last)
        if t in ("switch_expression", "switch_statement"):
            return self.walk_switch(st, ends, ctx)
        if t == "return_statement":
            return self.walk_return(st, ends, ctx, is_last)
        if t == "throw_statement":
            return self.walk_throw(st, ends, ctx)
        if t in ("try_statement", "try_with_resources_statement"):
            return self.walk_try(st, ends, ctx, is_last)
        if t in ("for_statement", "enhanced_for_statement", "while_statement", "do_statement"):
            return self.walk_loop(st, ends, ctx)
        if t == "labeled_statement":
            # Una etiqueta puede envolver un for/while, no sólo un bloque.
            # No recorrerla dejaba invisibles consultas y reintentos completos.
            inner = next((c for c in reversed(st.named_children) if c.type != "identifier"), None)
            return self.walk_stmt(inner, ends, ctx, is_last) if inner is not None else ends
        if t == "synchronized_statement":
            inner = [c for c in st.named_children if c.type == "block"]
            return self.walk_stmts(inner, ends, ctx) if inner else ends
        if t in ("break_statement", "continue_statement", "empty_statement", "assert_statement", "local_class_declaration", "yield_statement"):
            return ends
        return self.process_expressions(st, ends, ctx)

    # ---- if / switch ----
    def walk_if(self, st, ends, ctx, is_last=False):
        src = ctx.cls.source
        cond_node = st.child_by_field_name("condition")
        cond = node_text(src, cond_node).strip()
        if cond.startswith("(") and cond.endswith(")"):
            cond = cond[1:-1].strip()
        ends = self.process_expressions(cond_node, ends, ctx)
        if not ends:
            return ends
        header_end = st.child_by_field_name("consequence")
        did = self.node("decision", f"Decisión: {cond}", ctx, cond_node if cond_node.start_point[0] == st.start_point[0] else st, condition=cond)
        self.connect(ends, did)
        cons = st.child_by_field_name("consequence")
        alt = st.child_by_field_name("alternative")
        # un `if` con else que es la última sentencia: sus returns finales son finales del método
        last_in_branch = is_last and alt is not None
        out = self.walk_stmt(cons, [(did, "true", cond)], ctx, last_in_branch) if cons is not None else []
        if alt is not None:
            out += self.walk_stmt(alt, [(did, "false", "else")], ctx, last_in_branch)
        else:
            out += [(did, "false", "else")]
        return out

    def walk_switch(self, st, ends, ctx):
        src = ctx.cls.source
        cond_node = st.child_by_field_name("condition")
        cond = node_text(src, cond_node).strip().strip("()")
        ends = self.process_expressions(cond_node, ends, ctx)
        did = self.node("decision", f"Decisión (switch): {cond}", ctx, st, condition=f"switch({cond})")
        self.connect(ends, did)
        body = st.child_by_field_name("body")
        out, has_default = [], False
        for grp in (body.named_children if body is not None else []):
            if grp.type == "switch_block_statement_group":
                labels = [c for c in grp.children if c.type == "switch_label"]
                ltxt = ", ".join(node_text(src, l).replace(":", "").strip() for l in labels) or "case"
                stmts = [c for c in grp.named_children if c.type != "switch_label"]
            elif grp.type == "switch_rule":
                lab = grp.children[0] if grp.children else grp
                ltxt = node_text(src, lab).replace("->", "").strip()
                stmts = [c for c in grp.named_children if c is not lab and c.type != "switch_label"]
            else:
                continue
            is_def = ltxt.startswith("default")
            has_default = has_default or is_def
            out += self.walk_stmts(stmts, [(did, "default" if is_def else "case", ltxt)], ctx)
        if not has_default:
            out += [(did, "default", "ningún caso coincide")]
        return out

    # ---- return / throw ----
    def http_outcome(self, expr_text: str) -> str:
        m = re.search(r"HttpStatus\.(\w+)", expr_text)
        if m:
            return f"{HTTP_STATUS_CODES.get(m.group(1), '?')} {m.group(1)}"
        table = [("ok(", "200 OK"), (".ok()", "200 OK"), ("created(", "201 CREATED"), ("accepted(", "202 ACCEPTED"), ("noContent(", "204 NO_CONTENT"),
                 ("badRequest(", "400 BAD_REQUEST"), ("notFound(", "404 NOT_FOUND"), ("unprocessableEntity(", "422 UNPROCESSABLE_ENTITY")]
        for key, val in table:
            if key in expr_text:
                return val
        return ""

    def walk_return(self, st, ends, ctx, is_last):
        src = ctx.cls.source
        expr = next((c for c in st.named_children), None)
        if expr is not None:
            ends = self.process_expressions(expr, ends, ctx)
        if not ends:
            return ends
        if ctx.depth == 0:
            text = node_text(src, expr) if expr is not None else ""
            outcome = self.http_outcome(text)
            controller = ctx.cls.kind == "controller"
            if not outcome and controller and "Path" not in ctx.cls.ann_names and expr is not None:
                outcome = "200 OK (retorno directo; código por defecto de Spring MVC)"
            if not outcome and "Path" in ctx.cls.ann_names:
                outcome = "respuesta JAX-RS (estado HTTP no determinado estáticamente)"
            rid = self.node("return", f"Retorna {text[:120]}" if text else "Fin del método", ctx, st, outcome=outcome or None)
            self.connect(ends, rid)
            return []
        if is_last:
            ctx.returns += ends
            return []
        text = node_text(src, expr) if expr is not None else ""
        rid = self.node("return", f"Retorno anticipado: {text[:120]}", ctx, st)
        self.connect(ends, rid)
        ctx.returns.append((rid, "next", None))
        return []

    def exception_type_of_throw(self, st, ctx) -> str:
        src = ctx.cls.source
        expr = next((c for c in st.named_children), None)
        if expr is not None and expr.type == "object_creation_expression":
            return simple_type(node_text(src, expr.child_by_field_name("type")))
        if expr is not None and expr.type == "identifier":
            nm = node_text(src, expr)
            return simple_type(ctx.locals.get(nm, nm))
        return "Exception"

    def handler_matches(self, exc: str, types: list) -> bool:
        anc = self.idx.exception_ancestors(exc)
        for t in types:
            if t == exc or t in anc or t in GENERIC_CATCH or t == "Throwable":
                return True
        return False

    def route_exception(self, source_id: str, exc: Optional[str], ctx: Ctx, may_throw_unknown: bool = False) -> bool:
        """Conecta la excepción al marco try/catch aplicable más interno. Devuelve True si fue capturada."""
        for frame in reversed(ctx.handlers):
            for h in frame:
                if may_throw_unknown or exc is None or self.handler_matches(exc, h.types):
                    h.pending.append((source_id, "exception", exc or "excepción posible durante la operación (tipo no determinado estáticamente)"))
                    return True
        return False

    def walk_throw(self, st, ends, ctx):
        src = ctx.cls.source
        expr = next((c for c in st.named_children), None)
        if expr is not None:
            ends = self.process_expressions(expr, ends, ctx)
        if not ends:
            return ends
        exc = self.exception_type_of_throw(st, ctx)
        tid = self.node("throw", f"Lanza {exc}", ctx, st, exception_type=exc)
        self.connect(ends, tid)
        if self.route_exception(tid, exc, ctx):
            return []
        self.terminal_exception(tid, exc, ctx, st)
        return []

    def terminal_exception(self, throw_id: str, exc: str, ctx: Ctx, st):
        chain = [exc] + self.idx.exception_ancestors(exc)
        h = next((self.exc_handlers[c] for c in chain if c in self.exc_handlers), None)
        tnode = next(n for n in self.nodes if n["id"] == throw_id)
        if h is None:
            tnode["outcome"] = f"excepción {exc} sin manejador @ExceptionHandler en el proyecto (respuesta del framework no determinada)"
            self.limitation(f"La excepción {exc} no tiene @ExceptionHandler resoluble; el resultado observable queda DESCONOCIDO.", throw_id)
            return
        outcome = f"{h['status_code']} {h['status_name']}" if h["status_code"] else "estado HTTP no determinado"
        self._ev += 1
        eid = f"EV{self._ev}"
        self.evidence.append({"id": eid, "status": "CONFIRMADA", "file": h["file"], "line_start": h["line_start"], "line_end": h["line_end"],
                              "class": h["class"], "method": h["method"], "snippet": h["header_line"][:300]})
        nid = self._new_id("N")
        self.nodes.append({"id": nid, "type": "catch", "label": f"Manejador de excepciones {h['class']}.{h['method']}: {outcome}", "class": h["class"],
                           "method": h["method"], "exception_type": exc, "outcome": outcome, "resolution": "INDIRECTA", "evidence_id": eid})
        self.edges.append({"id": self._new_id("E"), "from": throw_id, "to": nid, "kind": "exception", "condition": exc})
        tnode["outcome"] = f"{outcome} (vía {h['class']}.{h['method']})"

    # ---- try/catch ----
    def walk_try(self, st, ends, ctx, is_last=False):
        src = ctx.cls.source
        res = st.child_by_field_name("resources")
        if res is not None:
            ends = self.process_expressions(res, ends, ctx)
        body = st.child_by_field_name("body")
        catches = [c for c in st.children if c.type == "catch_clause"]
        fin = next((c for c in st.children if c.type == "finally_clause"), None)
        frame = []
        for c in catches:
            param = next((x for x in c.named_children if x.type == "catch_formal_parameter"), None)
            ct = next((x for x in param.named_children if x.type == "catch_type"), None) if param is not None else None
            types = [simple_type(x.strip()) for x in node_text(src, ct).split("|")] if ct is not None else ["Exception"]
            frame.append(Handler(types))
        entry_ends = list(ends)
        ctx.handlers.append(frame)
        try:
            body_ends = self.walk_stmt(body, ends, ctx, is_last and fin is None) if body is not None else ends
        finally:
            ctx.handlers.pop()
        out = list(body_ends)
        for c, h in zip(catches, frame):
            param = next((x for x in c.named_children if x.type == "catch_formal_parameter"), None)
            pname = node_text(src, param.child_by_field_name("name")) if param is not None and param.child_by_field_name("name") is not None else "e"
            tname = h.types[0]
            ctx.locals[pname] = tname
            cid = self.node("catch", f"Captura {' | '.join(h.types)}", ctx, c, exception_type=" | ".join(h.types))
            if h.pending:
                for src_id, kind, cond in h.pending:
                    self.edges.append({"id": self._new_id("E"), "from": src_id, "to": cid, "kind": "exception", "condition": cond})
            else:
                # Cada extremo previo es un origen excepcional inferido. Cambiar
                # sólo la última arista duplicaba falsamente ramas false/loop_exit.
                self.connect([(eid, "exception", "origen de la excepción no determinado estáticamente") for eid, _, _ in entry_ends], cid)
                self.limitation(f"El bloque catch ({'|'.join(h.types)}) no tiene un origen de excepción resoluble dentro del try; se conecta desde la entrada del try.", cid)
            cbody = c.child_by_field_name("body")
            cends = self.walk_stmt(cbody, [(cid, "next", None)], ctx, is_last and fin is None) if cbody is not None else [(cid, "next", None)]
            out += cends
        if fin is not None:
            fb = next((x for x in fin.named_children if x.type == "block"), None)
            if fb is not None and out:
                out = self.walk_stmt(fb, out, ctx)
        return out

    # ---- bucles ----
    def walk_loop(self, st, ends, ctx):
        src = ctx.cls.source
        cond_node = st.child_by_field_name("condition") or st.child_by_field_name("value")
        cond = node_text(src, cond_node).strip().strip("()") if cond_node is not None else node_text(src, st).splitlines()[0]
        if cond_node is not None:
            ends = self.process_expressions(cond_node, ends, ctx)
        lid = self.node("loop", f"Iteración: {cond}"[:200], ctx, st, condition=cond)
        self.connect(ends, lid)
        body = st.child_by_field_name("body")
        bends = self.walk_stmt(body, [(lid, "loop_body", cond)], ctx) if body is not None else []
        self.limitation("Los bucles se modelan como una iteración opcional; no se analizan iteraciones múltiples ni break/continue.", lid)
        return bends + [(lid, "loop_exit", "fin de la iteración")]

    # ---------------- expresiones e invocaciones ----------------
    def collect_invocations(self, node, out: list, ctx: Ctx):
        t = node.type
        if t == "lambda_expression":
            return
        if t == "method_invocation":
            obj = node.child_by_field_name("object")
            if obj is not None:
                self.collect_invocations(obj, out, ctx)
            args = node.child_by_field_name("arguments")
            if args is not None:
                for a in args.named_children:
                    self.collect_invocations(a, out, ctx)
            out.append(node)
            return
        if t in ("class_body", "method_declaration"):
            return  # callbacks se expanden con su propio alcance, no como expresiones del llamador
        for c in node.named_children:
            self.collect_invocations(c, out, ctx)

    def process_expressions(self, node, ends: list, ctx: Ctx) -> list:
        invs: list = []
        self.collect_invocations(node, invs, ctx)
        for inv in invs:
            if not ends:
                break
            ends = self.handle_invocation(inv, ends, ctx)
        return ends

    def chain_root_is_simple(self, obj) -> bool:
        return obj is None or obj.type in ("identifier", "this", "field_access")

    def handle_invocation(self, inv, ends: list, ctx: Ctx) -> list:
        src = ctx.cls.source
        name = node_text(src, inv.child_by_field_name("name"))
        obj = inv.child_by_field_name("object")
        args = inv.child_by_field_name("arguments")
        argc = len(args.named_children) if args is not None else 0
        stmt_text = node_text(src, inv)

        if name == "orElseThrow" and args is not None and any(a.type in ("lambda_expression", "method_reference") for a in args.named_children):
            return self.handle_or_else_throw(inv, ends, ctx, args)

        if obj is not None and not self.chain_root_is_simple(obj):
            return ends  # cadena sobre resultados intermedios (builders, Optional.get(), etc.)

        if obj is None:
            target = ctx.cls
            recv_type = ctx.cls.name
        else:
            recv_type = self.type_of(ctx, obj)
            if recv_type is None:
                return ends
            target = self.idx.classes.get(recv_type)

        # --- tecnologías externas por tipo ---
        if recv_type == "Configuration" and name.startswith("get"):
            self.limitation("Las lecturas de Configuration se agrupan como configuración técnica; los valores efectivos y sus efectos no se resuelven estáticamente.")
            return ends
        if recv_type == "Session" and name == "doWork":
            callbacks = list(self._descendants(args, "method_declaration")) if args is not None else []
            callback = next((m for m in callbacks if node_text(src, m.child_by_field_name("name")) == "execute"), None)
            if callback is not None:
                params = [(node_text(src, p.child_by_field_name("type")), node_text(src, p.child_by_field_name("name")))
                          for p in callback.child_by_field_name("parameters").named_children if p.type == "formal_parameter"]
                mi = MethodInfo("execute", params, "void", [], callback.start_point[0] + 1, callback.end_point[0] + 1, callback, ctx.cls)
                sub = Ctx(ctx.cls, mi, {**ctx.locals, **{n: t for t, n in params}}, ctx.depth + 1, ctx.stack, ctx.handlers)
                return self.walk_method_body(sub, ends)
        if recv_type in EXTERNAL_HTTP_TYPES:
            return self.external_http(inv, name, recv_type, ends, ctx)
        if recv_type in JDBC_TYPES:
            return self.jdbc_call(inv, name, recv_type, ends, ctx)
        if recv_type in MESSAGING_TYPES:
            nid = self.node("async", f"Publica mensaje/evento ({recv_type}.{name})", ctx, inv, mechanism=recv_type, operation=name)
            self.connect(ends, nid)
            self.route_exception(nid, None, ctx, may_throw_unknown=True)
            return [(nid, "next", None)]
        if recv_type in IGNORED_TYPES:
            return ends

        if target is None:
            if obj is not None and self.is_field_ref(ctx, obj) and recv_type not in IGNORED_TYPES and not recv_type.endswith(("Utils", "Util")):
                nid = self.node("unresolved_call", f"Llamada no resuelta: {recv_type}.{name}()", ctx, inv, resolution="NO_RESUELTA", mechanism=recv_type)
                self.limitation(f"{recv_type}.{name}() pertenece a un tipo fuera del proyecto y sin tratamiento específico; su comportamiento se desconoce.", nid)
                self.connect(ends, nid)
                self.route_exception(nid, None, ctx, may_throw_unknown=True)
                return [(nid, "next", None)]
            return ends

        # --- tipos del proyecto ---
        if target.kind == "client" and get_ann(target.annotations, "FeignClient"):
            return self.feign_call(inv, name, target, ends, ctx)
        if target.kind == "repository" and target.kind_decl == "interface":
            return self.repository_call(inv, name, target, ends, ctx)
        if target.kind in ("entity", "exception"):
            return ends
        if target.kind == "other" and target.kind_decl != "interface" and not self._has_stereotype(target):
            return ends
        impls = self.idx.implementations(target)
        if not impls and target.kind_decl != "interface":
            return ends
        if not impls:
            nid = self.node("unresolved_call", f"Llamada no resuelta: {target.name}.{name}() (sin implementación en el proyecto)", ctx, inv, resolution="NO_RESUELTA")
            self.limitation(f"{target.name} no tiene implementaciones en el proyecto analizado.", nid)
            self.connect(ends, nid)
            self.route_exception(nid, None, ctx, may_throw_unknown=True)
            return [(nid, "next", None)]
        if len(impls) > 1:
            names = ", ".join(sorted(i.name for i in impls))
            nid = self.node("unresolved_call", f"Llamada polimórfica no resuelta: {target.name}.{name}() [candidatas: {names}]", ctx, inv, resolution="NO_RESUELTA")
            self.limitation(f"{target.name}.{name}() tiene {len(impls)} implementaciones candidatas ({names}); la resolución depende del contenedor Spring (@Primary/@Qualifier/perfiles) y no se determina estáticamente.", nid)
            self.connect(ends, nid)
            self.route_exception(nid, None, ctx, may_throw_unknown=True)
            return [(nid, "next", None)]
        impl = impls[0]
        arg_types = [self.type_of(ctx, a) for a in args.named_children] if args is not None else []
        m = self.idx.find_method(impl, name, argc, arg_types)
        if m is None:
            m = self.idx.find_method(target, name, argc, arg_types)
            if m is None:
                if any(x.name == name for x in target.methods):
                    nid = self.node("unresolved_call", f"Sobrecarga no resuelta: {target.name}.{name}()", ctx, inv, resolution="NO_RESUELTA")
                    self.limitation("No se selecciona arbitrariamente una sobrecarga con tipos ambiguos.", nid)
                    self.connect(ends, nid)
                    self.route_exception(nid, None, ctx, may_throw_unknown=True)
                    return [(nid, "next", None)]
                return ends
        resolution = "DIRECTA" if impl is target else "INDIRECTA"
        return self.inline_call(inv, impl, m, ends, ctx, resolution, name)

    def _has_stereotype(self, ci: ClassInfo) -> bool:
        return bool({a.name for a in ci.annotations} & {"Component", "Service", "Repository", "Configuration", "Controller", "RestController", "Stateless", "Stateful", "Singleton", "Path"})

    def inline_call(self, inv, impl: ClassInfo, m: MethodInfo, ends, ctx: Ctx, resolution: str, name: str) -> list:
        key = (impl.name, m.name)
        label = f"Invoca {impl.name}.{m.name}()"
        if key in ctx.stack:
            nid = self.node("unresolved_call", f"{label} (recursión detectada)", ctx, inv, resolution="NO_RESUELTA")
            self.limitation(f"Recursión en {impl.name}.{m.name}(): no se expande.", nid)
            self.connect(ends, nid)
            return [(nid, "next", None)]
        if ctx.depth + 1 > MAX_DEPTH:
            nid = self.node("unresolved_call", f"{label} (profundidad máxima)", ctx, inv, resolution="NO_RESUELTA")
            self.limitation(f"Se alcanzó la profundidad máxima ({MAX_DEPTH}) al expandir {impl.name}.{m.name}().", nid)
            self.connect(ends, nid)
            return [(nid, "next", None)]
        cid = self.node("call", label, ctx, inv, resolution=resolution)
        self.connect(ends, cid)
        sub = Ctx(impl, m, {n: t for t, n in m.params}, ctx.depth + 1, ctx.stack + (key,), ctx.handlers)
        return self.walk_method_body(sub, [(cid, "next", None)])

    def handle_or_else_throw(self, inv, ends, ctx, args) -> list:
        src = ctx.cls.source
        exc = "Exception"
        for sub in self._descendants(args, "object_creation_expression"):
            exc = simple_type(node_text(src, sub.child_by_field_name("type")))
            break
        did = self.node("decision", "Decisión: ¿resultado ausente? (Optional.orElseThrow)", ctx, inv, condition="resultado ausente (Optional.orElseThrow)")
        self.connect(ends, did)
        tid = self.node("throw", f"Lanza {exc} si el resultado está ausente", ctx, inv, exception_type=exc)
        self.edges.append({"id": self._new_id("E"), "from": did, "to": tid, "kind": "true", "condition": "resultado ausente"})
        if not self.route_exception(tid, exc, ctx):
            self.terminal_exception(tid, exc, ctx, inv)
        return [(did, "false", "resultado presente")]

    def _descendants(self, node, typ):
        for c in node.named_children:
            if c.type == typ:
                yield c
            yield from self._descendants(c, typ)

    # ---- tecnologías ----
    def resolve_expr(self, ctx: Ctx, expr) -> tuple:
        """Intenta resolver una expresión (literales, concatenaciones, campos @Value) a texto. Devuelve (texto, resuelto?)."""
        src = ctx.cls.source
        raw = node_text(src, expr)
        if expr.type == "string_literal":
            return strip_quotes(raw), True
        if expr.type == "binary_expression":
            l, lo = self.resolve_expr(ctx, expr.child_by_field_name("left"))
            r, ro = self.resolve_expr(ctx, expr.child_by_field_name("right"))
            return l + r, lo and ro
        if expr.type == "identifier":
            fi = ctx.cls.fields.get(raw)
            if fi:
                a = get_ann(fi.annotations, "Value")
                if a:
                    key = re.sub(r"^\$\{|\}$", "", strip_quotes(a.args.get("", "")))
                    key = key.split(":")[0]
                    val = self.idx.resolve_config(key)
                    if val is not None:
                        return val, True
                    return f"${{{key}}}", False
        return raw, False

    def external_http(self, inv, name, recv_type, ends, ctx) -> list:
        src = ctx.cls.source
        args = inv.child_by_field_name("arguments")
        first = args.named_children[0] if args is not None and args.named_children else None
        verb_map = {"getForObject": "GET", "getForEntity": "GET", "postForObject": "POST", "postForEntity": "POST", "postForLocation": "POST",
                    "put": "PUT", "delete": "DELETE", "patchForObject": "PATCH", "headForHeaders": "HEAD", "optionsForAllow": "OPTIONS",
                    "get": "GET", "post": "POST", "patch": "PATCH", "head": "HEAD"}
        if recv_type == "WebClient" or recv_type == "RestClient":
            if name not in ("get", "post", "put", "delete", "patch", "head", "method", "options"):
                return ends
            # buscar .uri(...) en la cadena
            cur, uri_expr = inv, None
            while cur.parent is not None and cur.parent.type == "method_invocation" and cur.parent.child_by_field_name("object") == cur:
                cur = cur.parent
                if node_text(src, cur.child_by_field_name("name")) == "uri":
                    ua = cur.child_by_field_name("arguments")
                    uri_expr = ua.named_children[0] if ua is not None and ua.named_children else None
                    break
            target, ok = self.resolve_expr(ctx, uri_expr) if uri_expr is not None else ("", False)
            verb = verb_map.get(name, name.upper())
        else:
            verb = verb_map.get(name)
            if name == "exchange" and args is not None and len(args.named_children) >= 2:
                mm = re.search(r"HttpMethod\.(\w+)", node_text(src, args.named_children[1]))
                verb = mm.group(1) if mm else "desconocido"
            if verb is None:
                return ends
            target, ok = self.resolve_expr(ctx, first) if first is not None else ("", False)
        label = f"Llamada HTTP {verb} {target}".strip() if target else f"Llamada HTTP {verb} (destino no determinado)"
        nid = self.node("external_call", label, ctx, inv, mechanism=recv_type, operation=f"http_{verb.lower()}",
                        target=target if ok else (f"{target} [no resuelto completamente]" if target else ""),
                        resolution="DIRECTA" if ok else "INDIRECTA")
        if not ok:
            self.limitation(f"El destino de la llamada {recv_type}.{name}() no se pudo resolver por completo estáticamente: {target or 'expresión no analizable'}.", nid)
        self.connect(ends, nid)
        self.route_exception(nid, None, ctx, may_throw_unknown=True)
        return [(nid, "next", None)]

    def feign_call(self, inv, name, target: ClassInfo, ends, ctx) -> list:
        ann = get_ann(target.annotations, "FeignClient")
        m = next((x for x in target.methods if x.name == name), None)
        verb_path = ""
        if m:
            for a in m.annotations:
                if a.name in HTTP_MAPPINGS:
                    verb = HTTP_MAPPINGS[a.name] or "REQUEST"
                    verb_path = f"{verb} {strip_quotes(a.args.get('') or a.args.get('value') or a.args.get('path') or '')}"
        dest = strip_quotes(ann.args.get("url") or ann.args.get("name") or ann.args.get("value") or "")
        nid = self.node("external_call", f"Llamada Feign {target.name}.{name}() {verb_path}".strip(), ctx, inv, mechanism="OpenFeign", target=f"{dest} {verb_path}".strip())
        self.connect(ends, nid)
        self.route_exception(nid, None, ctx, may_throw_unknown=True)
        return [(nid, "next", None)]

    def jdbc_call(self, inv, name, recv_type, ends, ctx) -> list:
        # Preparación, setters, lectura de OUT y close no son operaciones SQL nuevas.
        if name not in ("execute", "executeQuery", "executeUpdate", "executeBatch", "query", "queryForObject", "queryForList", "update", "batchUpdate", "persist", "merge", "remove", "find"):
            return ends
        src = ctx.cls.source
        args = inv.child_by_field_name("arguments")
        sql = ""
        if args is not None and args.named_children and args.named_children[0].type == "string_literal":
            sql = strip_quotes(node_text(src, args.named_children[0]))
        low = (sql or name).lower()
        op = "write" if re.match(r"\s*(insert|update|delete|merge)", low) or name in ("update", "persist", "merge", "remove", "batchUpdate") else "read"
        nid = self.node("persistence", f"Acceso a datos ({recv_type}.{name}){': ' + sql[:100] if sql else ''}", ctx, inv, mechanism=recv_type, operation=op, target=sql[:200] if sql else "")
        self.connect(ends, nid)
        self.route_exception(nid, None, ctx, may_throw_unknown=True)
        return [(nid, "next", None)]

    def repository_call(self, inv, name, repo: ClassInfo, ends, ctx) -> list:
        entity = ""
        for base in repo.implements:
            pass
        raw = repo.source[repo.node.start_byte:repo.node.end_byte].decode("utf-8", errors="replace")
        mm = re.search(r"(?:JpaRepository|CrudRepository|PagingAndSortingRepository|MongoRepository|ListCrudRepository)\s*<\s*([\w.]+)", raw)
        if mm:
            entity = mm.group(1)
        op = "write" if name.startswith(WRITE_PREFIXES) else ("read" if name.startswith(READ_PREFIXES) else "read")
        m = next((x for x in repo.methods if x.name == name), None)
        target = entity
        if m:
            q = get_ann(m.annotations, "Query")
            if q:
                qt = strip_quotes(q.args.get("") or q.args.get("value") or "")
                fm = re.search(r"(?:from|into|update)\s+(\w+)", qt, re.I)
                target = fm.group(1) if fm else entity
        nid = self.node("persistence", f"{'Consulta' if op == 'read' else 'Persistencia'} {repo.name}.{name}()" + (f" [{target}]" if target else ""), ctx, inv,
                        mechanism="Spring Data" if any(b in raw for b in ("JpaRepository", "CrudRepository", "PagingAndSortingRepository")) else "Repository",
                        operation=op, target=target)
        self.connect(ends, nid)
        self.route_exception(nid, None, ctx, may_throw_unknown=True)
        return [(nid, "next", None)]

    # ---------------- caminos ----------------
    def enumerate_paths(self) -> list:
        out_edges: dict = {}
        for e in self.edges:
            out_edges.setdefault(e["from"], []).append(e)
        nodes = {n["id"]: n for n in self.nodes}
        if not self.nodes:
            return []
        paths, count = [], 0
        start = self.nodes[0]["id"]
        stack = [(start, [start])]
        while stack and count < MAX_PATHS:
            nid, p = stack.pop()
            outs = out_edges.get(nid, [])
            if not outs:
                count += 1
                paths.append(p)
                continue
            for e in reversed(outs):
                if e["to"] in p:
                    continue
                stack.append((e["to"], p + [e["to"]]))
        if stack:
            self.limitation(f"Se alcanzó el máximo de {MAX_PATHS} rutas enumeradas; existen más rutas sin listar.")
        result = []
        for i, p in enumerate(paths, 1):
            term = nodes[p[-1]]
            outcome = term.get("outcome", "")
            m = re.match(r"(\d{3})", outcome)
            if term["type"] in ("return", "catch", "throw") and m:
                code = int(m.group(1))
                kind = "success" if code < 300 else ("rejection" if code < 500 and code not in (500,) else "error")
                if code in (502, 503, 504) or code >= 500:
                    kind = "error"
            else:
                kind = "unknown"
            result.append({"id": f"P{i}", "kind": kind, "node_ids": p, "terminal": p[-1]})
        return result


class _Truncated(Exception):
    pass


def annotation_path(idx, ci, expression, seen=None):
    """Resuelve solo literales/constantes de cadena; nunca evalúa código Java."""
    expression = expression.strip()
    if expression.startswith('"') and expression.endswith('"') and '"' not in expression[1:-1]:
        return strip_quotes(expression)
    seen = set() if seen is None else seen
    key = (ci.name, expression)
    if key in seen:
        return expression
    seen = seen | {key}
    if "+" in expression:
        return "".join(annotation_path(idx, ci, part, seen) for part in expression.split("+"))
    owner, _, field = expression.rpartition(".")
    target = idx.classes.get(owner) if owner else ci
    value = target.fields.get(field or expression) if target else None
    return annotation_path(idx, target, value.initializer, seen) if value and value.initializer else expression


def discover_entry_points(idx: ProjectIndex) -> list:
    entries = []
    counter = 0
    for ci in sorted(idx.classes.values(), key=lambda c: (c.file, c.line)):
        base = get_ann(ci.annotations, "RequestMapping", "Path")
        base_path = ""
        if base:
            base_path = annotation_path(idx, ci, base.args.get("") or base.args.get("value") or base.args.get("path") or "")
        for m in ci.methods:
            if m.is_constructor:
                continue
            # JAX-RS declara el verbo y la ruta en anotaciones independientes.
            jax_verb = get_ann(m.annotations, "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS")
            if jax_verb and ("Path" in ci.ann_names or any(i.startswith(("javax.ws.rs.", "jakarta.ws.rs.")) for i in ci.imports)):
                path_ann = get_ann(m.annotations, "Path")
                sub = annotation_path(idx, ci, (path_ann.args.get("") or path_ann.args.get("value") or "") if path_ann else "")
                literal = all(not p or p.startswith("/") for p in (base_path, sub))
                route = ("/" + (base_path + "/" + sub).strip("/")).replace("//", "/") if literal else f"NO_RESUELTA: {base_path} + {sub}"
                counter += 1
                entries.append({"id": f"EP{counter}", "kind": "rest", "http_method": jax_verb.name, "path": route,
                                "class": ci.name, "method": m.name, "file": ci.file, "line": m.line_start,
                                "annotations": [x.name for x in m.annotations], "class_key": ci.name, "method_line": m.line_start})
            for a in m.annotations:
                if ci.kind == "controller" and a.name in HTTP_MAPPINGS:
                    verb = HTTP_MAPPINGS[a.name]
                    if verb is None:
                        mm = re.search(r"RequestMethod\.(\w+)", a.args.get("method", ""))
                        verb = mm.group(1) if mm else "ANY"
                    sub = annotation_path(idx, ci, a.args.get("") or a.args.get("value") or a.args.get("path") or "")
                    counter += 1
                    entries.append({"id": f"EP{counter}", "kind": "rest", "http_method": verb, "path": ("/" + (base_path + "/" + sub).strip("/")).replace("//", "/") if (base_path or sub) else "/",
                                    "class": ci.name, "method": m.name, "file": ci.file, "line": m.line_start, "annotations": [x.name for x in m.annotations],
                                    "class_key": ci.name, "method_line": m.line_start})
                elif a.name in LISTENER_ANNOTATIONS:
                    counter += 1
                    entries.append({"id": f"EP{counter}", "kind": LISTENER_ANNOTATIONS[a.name], "path": a.raw[:120], "class": ci.name, "method": m.name,
                                    "file": ci.file, "line": m.line_start, "annotations": [x.name for x in m.annotations], "class_key": ci.name, "method_line": m.line_start})
            if m.name == "main" and any("static" in node_text(ci.source, ch) for ch in m.node.children if ch.type == "modifiers"):
                counter += 1
                entries.append({"id": f"EP{counter}", "kind": "main", "class": ci.name, "method": "main", "file": ci.file, "line": m.line_start,
                                "annotations": [], "class_key": ci.name, "method_line": m.line_start})
    return entries


def discover_integrations(idx: ProjectIndex) -> list:
    out, counter = [], 0
    for ci in sorted(idx.classes.values(), key=lambda c: (c.file, c.line)):
        types = {n: simple_type(f.type) for n, f in ci.fields.items()}
        for m in ci.methods:
            types_m = dict(types)
            types_m.update({n: simple_type(t) for t, n in m.params})
            body = m.node.child_by_field_name("body")
            if body is None:
                continue
            for declaration in _descendants(body):
                if declaration.type == "local_variable_declaration":
                    local_type = simple_type(node_text(ci.source, declaration.child_by_field_name("type")))
                    for variable in declaration.named_children:
                        if variable.type == "variable_declarator":
                            types_m[node_text(ci.source, variable.child_by_field_name("name"))] = local_type
            for inv in _all_invocations(body):
                name = node_text(ci.source, inv.child_by_field_name("name"))
                obj = inv.child_by_field_name("object")
                if obj is None or obj.type != "identifier":
                    continue
                t = types_m.get(node_text(ci.source, obj))
                if not t:
                    continue
                kind = mech = op = None
                if t in EXTERNAL_HTTP_TYPES:
                    kind, mech = "http", t
                    op = name
                elif t in JDBC_TYPES:
                    if name not in ("execute", "executeQuery", "executeUpdate", "executeBatch", "query", "queryForObject", "queryForList", "update", "batchUpdate", "persist", "merge", "remove", "find"):
                        continue
                    kind, mech = "database", t
                    op = name
                elif t in MESSAGING_TYPES:
                    kind, mech = "messaging", t
                    op = name
                else:
                    target = idx.classes.get(t)
                    if target and target.kind == "repository" and target.kind_decl == "interface" and ci.kind != "repository":
                        kind, mech, op = "database", "Spring Data", name
                    elif target and get_ann(target.annotations, "FeignClient"):
                        kind, mech, op = "http", "OpenFeign", name
                if kind is None:
                    continue
                if kind == "http" and mech in ("WebClient", "RestClient") and name not in ("get", "post", "put", "delete", "patch", "head", "method"):
                    continue
                counter += 1
                item = {"id": f"INT{counter}", "kind": kind, "mechanism": mech, "class": ci.name, "method": m.name, "operation": op,
                        "file": ci.file, "line": inv.start_point[0] + 1}
                tgt = ""
                if kind == "database" and mech == "Spring Data":
                    tgt = t
                item["target"] = tgt
                out.append({k: v for k, v in item.items() if v != ""})
    return out


def _all_invocations(node):
    if node.type == "method_invocation":
        yield node
    for c in node.named_children:
        yield from _all_invocations(c)


def _descendants(node):
    yield node
    for child in node.named_children:
        yield from _descendants(child)
