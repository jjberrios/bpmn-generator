"""Pruebas del análisis estructural Java sobre el fixture orders-service (rutas esperadas conocidas)."""
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "ingestion"))
sys.path.insert(0, os.path.join(ROOT, "tools", "analysis"))

from extract_zip import DEFAULT_LIMITS, ingest  # noqa: E402
from analyze_project import analyze  # noqa: E402
from java_index import ProjectIndex  # noqa: E402
from java_trace import TraceBuilder, discover_entry_points, discover_integrations  # noqa: E402

FIXTURE_ZIP = os.path.join(ROOT, "tests", "fixtures", "orders-service.zip")


class JavaAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="bpmn_re_an_")
        ingest(FIXTURE_ZIP, cls.tmp, "orders", dict(DEFAULT_LIMITS), False)
        cls.project = os.path.join(cls.tmp, "orders")
        cls.summary = analyze(cls.project)
        with open(os.path.join(cls.project, "analysis", "architecture-map.json"), encoding="utf-8") as f:
            cls.arch = json.load(f)
        with open(os.path.join(cls.project, "analysis", "execution-trace.json"), encoding="utf-8") as f:
            cls.traces = {t["id"]: t for t in json.load(f)["traces"]}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def trace_for(self, method):
        for t in self.traces.values():
            if t["entry"]["method"] == method:
                return t
        self.fail(f"no hay traza para {method}")

    def nodes(self, trace, **filters):
        return [n for n in trace["nodes"] if all(n.get(k) == v for k, v in filters.items())]

    def test_lenguaje_y_framework(self):
        self.assertIn("java", [l if isinstance(l, str) else l.get("name") for l in self.arch["languages"]])
        frameworks = json.dumps(self.arch["frameworks"]).lower()
        self.assertIn("spring", frameworks)

    def test_puntos_de_entrada_rest(self):
        rest = {(e["http_method"], e["path"], e["method"]) for e in self.arch["entry_points"] if e["kind"] == "rest"}
        self.assertEqual(rest, {("GET", "/api/orders/{orderId}/status", "getStatus"), ("POST", "/api/orders/{orderId}/cancel", "cancel")})

    def test_componentes_clasificados(self):
        kinds = {c["class"]: c["kind"] for c in self.arch["components"]}
        self.assertEqual(kinds["OrderController"], "controller")
        self.assertEqual(kinds["OrderService"], "service")
        self.assertEqual(kinds["OrderRepository"], "repository")
        self.assertEqual(kinds["ShippingClient"], "client")

    def test_integraciones_http_y_base_de_datos(self):
        http = [i for i in self.arch["integrations"] if i["kind"] == "http"]
        db = [i for i in self.arch["integrations"] if i["kind"] == "database"]
        self.assertEqual(len(http), 1)
        self.assertEqual(http[0]["mechanism"], "RestTemplate")
        self.assertEqual(len(db), 3)

    def test_ruta_getstatus_decisiones_y_resultados(self):
        t = self.trace_for("getStatus")
        conds = [n["condition"] for n in self.nodes(t, type="decision")]
        self.assertTrue(any("orderId == null" in c for c in conds))
        self.assertTrue(any("isEmpty" in c for c in conds))
        self.assertTrue(any("CANCELLED" in c for c in conds))
        self.assertTrue(any("getCode() != 0" in c for c in conds))
        outcomes = {n.get("outcome") for n in t["nodes"] if n.get("outcome")}
        self.assertTrue(any("400" in o for o in outcomes))
        self.assertTrue(any("404" in o for o in outcomes))
        self.assertTrue(any("502" in o for o in outcomes))
        self.assertTrue(any("200" in o for o in outcomes))
        kinds = {p["kind"] for p in t["paths"]}
        self.assertTrue({"success", "rejection", "error"} <= kinds)

    def test_consulta_a_repositorio_y_servicio_externo(self):
        t = self.trace_for("getStatus")
        self.assertTrue(self.nodes(t, type="persistence"))
        ext = self.nodes(t, type="external_call")
        self.assertEqual(len(ext), 1)
        self.assertIn("shipping.internal", ext[0]["target"])

    def test_excepcion_capturada_y_ruta_de_error(self):
        t = self.trace_for("getStatus")
        self.assertTrue(self.nodes(t, type="catch"))
        self.assertTrue(any(e["kind"] == "exception" for e in t["edges"]))

    def test_llamada_no_resoluble_se_registra(self):
        t = self.trace_for("getStatus")
        unresolved = self.nodes(t, type="unresolved_call")
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["resolution"], "NO_RESUELTA")
        self.assertTrue(t["limitations"])

    def test_ruta_cancel(self):
        t = self.trace_for("cancel")
        self.assertEqual(len(t["paths"]), 3)
        conds = " ".join(n.get("condition", "") for n in self.nodes(t, type="decision"))
        self.assertIn("SHIPPED", conds)
        self.assertTrue(any(n.get("operation") == "write" for n in self.nodes(t, type="persistence")))

    def test_cada_nodo_tiene_evidencia_existente(self):
        for t in self.traces.values():
            ids = {e["id"] for e in t["evidence"]}
            for n in t["nodes"]:
                self.assertIn(n["evidence_id"], ids)
            for e in t["evidence"]:
                self.assertTrue(os.path.isfile(os.path.join(self.project, "source", e["file"])), e["file"])


class JdbcRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bpmn_jdbc_")
        self.addCleanup(self.tmp.cleanup)
        source = '''
class Routes {
    static final String BASE = "/api" + "/test";
    static final String RUN = "/run";
}
@RestController @RequestMapping(Routes.BASE)
class TestController {
    TestRepository repository;
    @PostMapping(Routes.RUN)
    public Object run() { return repository.run(); }
}
@Repository
class TestRepository {
    public Object run() {
        CallableStatement cs = connection.prepareCall("{call TEST()}");
        try {
            printLog();
            cs.setQueryTimeout(2);
            cs.execute();
        } catch (Exception e) { printLog(); }
        return null;
    }
    public void printLog() { logger.info("solo log"); }
}
'''
        with open(os.path.join(self.tmp.name, "Test.java"), "w", encoding="utf-8") as f:
            f.write(source)
        self.idx = ProjectIndex(self.tmp.name, [{"path": "Test.java", "category": "source", "language": "java"}])

    def test_ruta_rest_resuelve_constantes_y_concatenacion(self):
        entries = discover_entry_points(self.idx)
        self.assertEqual([(e["http_method"], e["path"]) for e in entries], [("POST", "/api/test/run")])

    def test_callable_statement_local_es_una_integracion_no_setters(self):
        db = [i for i in discover_integrations(self.idx) if i["kind"] == "database"]
        self.assertEqual(len(db), 1)
        self.assertEqual(db[0]["mechanism"], "CallableStatement")

    def test_logs_no_son_persistencia_y_catch_no_es_llamada_no_resuelta(self):
        entry = discover_entry_points(self.idx)[0]
        trace = TraceBuilder(self.idx, entry, "TR_EP1").build()
        persistence = [n for n in trace["nodes"] if n["type"] == "persistence"]
        self.assertEqual(len(persistence), 1)
        self.assertIn("execute", persistence[0]["label"])
        catches = [n for n in trace["nodes"] if n["type"] == "catch"]
        self.assertTrue(catches)
        self.assertFalse(any(n.get("resolution") == "NO_RESUELTA" for n in catches))


class JaxRsRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bpmn_jaxrs_")
        self.addCleanup(self.tmp.cleanup)
        source = '''
import javax.ws.rs.Path;
import javax.ws.rs.POST;
import javax.ejb.Stateless;
import javax.ejb.EJB;
@Stateless @Path(Constantes.BASE)
class Resource {
    @EJB TestService service;
    @POST @Path(Constantes.RUN)
    public Object run() { service.overloaded(unknown()); service.callback(); return response; }
}
@Stateless class TestService {
    public void overloaded(String value) { first(); }
    public void overloaded(Integer value) { second(); }
    public void callback() {
        Session session;
        session.doWork(new Work() {
            public void execute(Connection connection) {
                OracleCallableStatement cs = connection.prepareCall("{call TEST()}");
                cs.execute();
            }
        });
    }
}
'''
        with open(os.path.join(self.tmp.name, "Resource.java"), "w", encoding="utf-8") as f:
            f.write(source)
        self.idx = ProjectIndex(self.tmp.name, [{"path": "Resource.java", "category": "source", "language": "java"}])

    def trace(self):
        return TraceBuilder(self.idx, discover_entry_points(self.idx)[0], "TR_EP1").build()

    def test_jaxrs_sin_constantes_no_inventa_ruta_ni_estado_200(self):
        ep = discover_entry_points(self.idx)[0]
        self.assertEqual(ep["http_method"], "POST")
        self.assertIn("NO_RESUELTA", ep["path"])
        self.assertIn("Constantes.BASE", ep["path"])
        outcomes = [n.get("outcome", "") for n in self.trace()["nodes"] if n["type"] == "return"]
        self.assertTrue(outcomes)
        self.assertFalse(any(o.startswith("200") for o in outcomes))

    def test_sobrecarga_ambigua_no_elige_primera(self):
        unresolved = [n for n in self.trace()["nodes"] if n["type"] == "unresolved_call"]
        self.assertTrue(any("Sobrecarga no resuelta" in n["label"] for n in unresolved))

    def test_ambito_callback_oracle_jdbc_y_ejb(self):
        persistence = [n for n in self.trace()["nodes"] if n["type"] == "persistence"]
        self.assertEqual(len(persistence), 1)
        self.assertIn("execute", persistence[0]["label"])

    def test_catch_inferido_no_duplica_ramas_normales(self):
        source = '''
import javax.ws.rs.Path;
import javax.ws.rs.POST;
@Path("/test") class Resource {
    @POST public Object run() {
        if (flag) { value = 1; }
        try { value = 2; } catch (Exception e) { value = 3; }
        return response;
    }
}
'''
        with open(os.path.join(self.tmp.name, "Resource.java"), "w", encoding="utf-8") as f:
            f.write(source)
        idx = ProjectIndex(self.tmp.name, [{"path": "Resource.java", "category": "source", "language": "java"}])
        t = TraceBuilder(idx, discover_entry_points(idx)[0], "TR_EP1").build()
        catches = {n["id"] for n in t["nodes"] if n["type"] == "catch"}
        incoming = [e for e in t["edges"] if e["to"] in catches]
        self.assertEqual(len(incoming), 2)
        self.assertTrue(all(e["kind"] == "exception" for e in incoming))

    def test_bucle_etiquetado_no_oculta_la_consulta_jdbc(self):
        source = '''
import javax.ws.rs.Path;
import javax.ws.rs.POST;
@Path("/test") class Resource {
    @POST public Object run() {
        CallableStatement cs;
        retry: for (int i=0; i<3; i++) { cs.execute(); }
        return response;
    }
}
'''
        with open(os.path.join(self.tmp.name, "Resource.java"), "w", encoding="utf-8") as f:
            f.write(source)
        idx = ProjectIndex(self.tmp.name, [{"path": "Resource.java", "category": "source", "language": "java"}])
        t = TraceBuilder(idx, discover_entry_points(idx)[0], "TR_EP1").build()
        self.assertEqual(len([n for n in t["nodes"] if n["type"] == "persistence"]), 1)
        self.assertTrue(any(n["type"] == "loop" for n in t["nodes"]))


if __name__ == "__main__":
    unittest.main()
