import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import fitz


spec = importlib.util.spec_from_file_location(
    "generator", Path(__file__).resolve().parents[1] / "scripts/generate-pages-and-contents.py"
)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class OtherLearningResourcesTests(unittest.TestCase):
    def test_split_all_supported_files_into_separate_numerically_named_pages(self):
        with tempfile.TemporaryDirectory() as root:
            resources = Path(root) / "other-learning-resources"
            resources.mkdir()
            names = [
                "03 CC Metals", "03 CC Metals Answer", "03 CC Metals Answers",
                "List of Definition", "Paragraph Length Question",
                "Summary of Diagrams", "Ultimate Intensive Note",
            ]
            for name in names + ["Chemical Test for Cations and Anions", "123 Invalid"]:
                with fitz.open() as pdf:
                    pdf.new_page(width=72, height=72)
                    pdf.new_page(width=72, height=72)
                    pdf.save(resources / f"{name}.pdf")
            for fmt in ("png", "jpg"):
                args = SimpleNamespace(dpi=72, format=fmt)
                generator.split_other_learning_resources(root, args)
                generator.split_other_learning_resources(root, args)
            self.assertEqual(
                sorted(str(file.relative_to(resources)) for file in (resources / "pages").rglob("*") if file.is_file()),
                sorted(f"pages/{name}/page-{page}.{fmt}" for name in names for page in (1, 2) for fmt in ("png", "jpg")),
            )

    def test_missing_resources_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(FileNotFoundError):
                generator.split_other_learning_resources(root, SimpleNamespace(dpi=72, format="png"))


if __name__ == "__main__":
    unittest.main()
