import unittest
from inventario import parse_linea

class TestBase(unittest.TestCase):
    def test_basico(self):
        it = parse_linea("ABC;2;3.5")
        self.assertEqual(it.cantidad, 2)
