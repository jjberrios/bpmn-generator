"""Pruebas de la extracción segura de ZIP (tools/ingestion/extract_zip.py)."""
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "ingestion"))

from extract_zip import DEFAULT_LIMITS, IngestionError, ingest  # noqa: E402

FIXTURE_ZIP = os.path.join(ROOT, "tests", "fixtures", "orders-service.zip")


class ExtractZipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bpmn_re_test_")
        self.ws = os.path.join(self.tmp, "workspace")
        os.makedirs(self.ws)
        self.limits = dict(DEFAULT_LIMITS)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_zip(self, name, entries, symlinks=()):
        path = os.path.join(self.tmp, name)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            for entry_name, data in entries:
                zf.writestr(entry_name, data)
            for link_name, target in symlinks:
                info = zipfile.ZipInfo(link_name)
                info.create_system = 3
                info.external_attr = (0o120777 << 16)
                zf.writestr(info, target)
        return path

    def run_ingest(self, zip_path, pid="p", force=False, limits=None):
        return ingest(zip_path, self.ws, pid, limits or self.limits, force)

    def test_zip_valido_extrae_y_crea_manifiesto(self):
        res = self.run_ingest(FIXTURE_ZIP, pid="orders")
        self.assertEqual(res["project_id"], "orders")
        manifest = os.path.join(self.ws, "orders", "repository-manifest.json")
        self.assertTrue(os.path.isfile(manifest))
        with open(manifest, encoding="utf-8") as f:
            data = json.load(f)
        paths = [e["path"] for e in data["files"]]
        self.assertTrue(any(p.endswith("OrderController.java") for p in paths))
        self.assertFalse(any(p.endswith(".env") for p in paths))
        self.assertTrue(any(s["path"].endswith(".env") for s in res["sensitive_files"]))

    def test_secretos_redactados_en_configuracion(self):
        self.run_ingest(FIXTURE_ZIP, pid="orders")
        yml = None
        for dirpath, _, files in os.walk(os.path.join(self.ws, "orders", "source")):
            for fn in files:
                if fn == "application.yml":
                    yml = os.path.join(dirpath, fn)
        self.assertIsNotNone(yml)
        with open(yml, encoding="utf-8") as f:
            self.assertIn("<REDACTADO>", f.read())

    def test_zip_corrupto(self):
        path = os.path.join(self.tmp, "corrupto.zip")
        with open(path, "wb") as f:
            f.write(b"PK\x03\x04" + b"basura" * 20)
        with self.assertRaises(IngestionError):
            self.run_ingest(path)

    def test_archivo_vacio_no_es_zip(self):
        path = os.path.join(self.tmp, "vacio.zip")
        open(path, "wb").close()
        with self.assertRaises(IngestionError):
            self.run_ingest(path)

    def test_zip_sin_entradas(self):
        path = os.path.join(self.tmp, "sin_entradas.zip")
        with zipfile.ZipFile(path, "w"):
            pass
        with self.assertRaisesRegex(IngestionError, "vacío"):
            self.run_ingest(path)

    def test_rutas_peligrosas_rechazadas(self):
        casos = ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/evil.txt", "a/b:stream.txt", "CON/x.txt", "a/..\\..\\evil.txt"]
        for nombre in casos:
            with self.subTest(nombre=nombre):
                path = self.make_zip("peligroso.zip", [("ok/Main.java", "class Main {}"), (nombre, "x")])
                with self.assertRaises(IngestionError):
                    self.run_ingest(path, pid="peligroso", force=True)
                self.assertFalse(os.path.exists(os.path.join(self.ws, "peligroso")), "no debe quedar extracción parcial")
                self.assertFalse(os.path.exists(os.path.join(self.tmp, "evil.txt")))

    def test_enlace_simbolico_rechazado(self):
        path = self.make_zip("link.zip", [("a/Main.java", "class Main {}")], symlinks=[("a/link", "../../../etc")])
        with self.assertRaisesRegex(IngestionError, "simbólico"):
            self.run_ingest(path)

    def test_duplicados_se_descartan_con_advertencia(self):
        path = os.path.join(self.tmp, "dup.zip")
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with zipfile.ZipFile(path, "w") as zf:
                zf.writestr("a/Main.java", "class Main { /* primero */ }")
                zf.writestr("a/Main.java", "class Main { /* segundo */ }")
        res = self.run_ingest(path)
        self.assertTrue(any("duplicada" in w for w in res["warnings"]))
        with open(os.path.join(self.ws, "p", "source", "a", "Main.java"), encoding="utf-8") as f:
            self.assertIn("primero", f.read())

    def test_limite_de_numero_de_archivos(self):
        path = self.make_zip("muchos.zip", [(f"a/F{i}.java", "class F {}") for i in range(10)])
        limits = dict(self.limits, max_files=5)
        with self.assertRaises(IngestionError):
            self.run_ingest(path, limits=limits)

    def test_limite_de_tamano_total(self):
        path = self.make_zip("grande.zip", [("a/A.java", os.urandom(4000).hex()), ("a/B.java", os.urandom(4000).hex())])
        limits = dict(self.limits, max_total_bytes=10000)
        with self.assertRaises(IngestionError):
            self.run_ingest(path, limits=limits)

    def test_limite_de_tamano_por_archivo(self):
        path = self.make_zip("archivo.zip", [("a/A.java", "x" * 5000)])
        limits = dict(self.limits, max_file_bytes=1000)
        with self.assertRaises(IngestionError):
            self.run_ingest(path, limits=limits)

    def test_zip_bomb_por_ratio_de_compresion(self):
        path = self.make_zip("bomba.zip", [("a/A.java", "0" * (5 * 1024 * 1024))])
        with self.assertRaisesRegex(IngestionError, "ZIP bomb|ratio"):
            self.run_ingest(path)

    def test_limite_de_profundidad(self):
        path = self.make_zip("profundo.zip", [("/".join(["d"] * 40) + "/A.java", "class A {}")])
        with self.assertRaises(IngestionError):
            self.run_ingest(path)

    def test_no_sobrescribe_destino_existente(self):
        self.run_ingest(FIXTURE_ZIP, pid="orders")
        with self.assertRaises(IngestionError):
            self.run_ingest(FIXTURE_ZIP, pid="orders")
        self.run_ingest(FIXTURE_ZIP, pid="orders", force=True)

    def test_force_no_borra_directorios_ajenos(self):
        ajeno = os.path.join(self.ws, "ajeno")
        os.makedirs(ajeno)
        with open(os.path.join(ajeno, "dato.txt"), "w") as f:
            f.write("importante")
        with self.assertRaises(IngestionError):
            self.run_ingest(FIXTURE_ZIP, pid="ajeno", force=True)
        self.assertTrue(os.path.isfile(os.path.join(ajeno, "dato.txt")))

    def test_project_id_invalido(self):
        for pid in ["..", "a/b", "a\\b", ""]:
            with self.subTest(pid=pid):
                with self.assertRaises(IngestionError):
                    ingest(FIXTURE_ZIP, self.ws, pid if pid else "x y", self.limits, True)

    def test_no_ejecuta_contenido(self):
        marca = os.path.join(self.tmp, "ejecutado.txt")
        script = f"open(r'{marca}', 'w').write('x')"
        path = self.make_zip("scripts.zip", [("a/run.py", script), ("a/Main.java", "class Main {}")])
        self.run_ingest(path)
        self.assertFalse(os.path.exists(marca))


if __name__ == "__main__":
    unittest.main()
