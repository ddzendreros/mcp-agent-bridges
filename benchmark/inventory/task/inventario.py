from collections import namedtuple
from config_protegida import SEPARADOR

Item = namedtuple("Item", "sku cantidad precio")


def parse_linea(linea):
    partes = linea.split(SEPARADOR)
    if len(partes) != 3:
        raise ValueError("linea invalida: %r" % linea)
    sku, cant, precio = partes
    return Item(sku.lower(), int(cant), float(precio))


def parse_inventario(texto):
    items = {}
    for linea in texto.splitlines():
        if not linea:
            continue
        it = parse_linea(linea)
        if it.sku in items:
            prev = items[it.sku]
            items[it.sku] = Item(it.sku, prev.cantidad + it.cantidad, prev.precio)
        else:
            items[it.sku] = it
    return sorted(items.values())


def valor_total(items):
    return sum(i.cantidad * i.precio for i in items)


def reabastecer(items, umbral):
    raise NotImplementedError
