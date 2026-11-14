# Prompt used in the benchmark

The task files (`task/SPEC.md`, code and tests) are in Spanish, and so was the prompt. It was sent verbatim to every agent:

```text
Lee SPEC.md en este directorio. Arregla inventario.py para que cumpla la especificación (hay varios bugs) e implementa reabastecer. Crea tests/test_nuevo.py con al menos 6 tests que cubran la especificación. NO modifiques config_protegida.py ni tests/test_base.py. Ejecuta `python -m unittest discover -s tests -t .` y asegúrate de que pase. Al final responde en 3-5 líneas: qué cambiaste y el resultado de los tests.
```

English translation: *Read SPEC.md in this directory. Fix inventario.py so it meets the spec (there are several bugs) and implement `reabastecer`. Create tests/test_nuevo.py with at least 6 tests covering the spec. Do NOT modify config_protegida.py or tests/test_base.py. Run `python -m unittest discover -s tests -t .` and make sure it passes. Finish with 3–5 lines: what you changed and the test result.*

For Antigravity the call also passed `allow_commands: ["python -m unittest discover -s tests -t ."]`, because in its default mode it cannot run commands.
