# Inventario - especificación

Formato de línea: `SKU;cantidad;precio`
- Espacios alrededor de cada campo se ignoran.
- SKU se normaliza a MAYÚSCULAS y no puede quedar vacío.
- cantidad: entero >= 0. precio: decimal >= 0, acepta coma o punto decimal ("12,50" == 12.5).
- Líneas vacías (o solo espacios) o que empiezan con `#` se ignoran (parse_inventario las salta).
- Cualquier otra línea inválida lanza ValueError.

## Funciones (inventario.py)
- `parse_linea(linea) -> Item` (Item = namedtuple sku, cantidad, precio)
- `parse_inventario(texto) -> list[Item]`; si un SKU se repite, se suman cantidades y se queda el ÚLTIMO precio; conserva el orden de primera aparición.
- `valor_total(items) -> float` = suma cantidad*precio, redondeado a 2 decimales.
- `reabastecer(items, umbral) -> list[str]`: **POR IMPLEMENTAR**. SKUs con cantidad < umbral (estricto), ordenados por cantidad ascendente y, en empate, por SKU alfabético. umbral negativo -> ValueError.

## Restricciones
- NO modificar `config_protegida.py` ni `tests/test_base.py`.
- Añadir tests nuevos en `tests/test_nuevo.py`.
- Comando de tests: `python -m unittest discover -s tests -t .`
