# Benchmark

A small, reproducible task to compare delegate agents behind the same orchestrator.

## The `inventory` task
- `task/` — a Python project with **9 planted bugs** in `inventario.py`, an unimplemented function (`reabastecer`), a spec (`SPEC.md`) and two **protected files** the agent must not touch.
- The agent must fix the bugs, implement the function, write at least 6 new tests and run them.
- `judge.py` — a **hidden judge** with 23 checks (edge cases from the spec, the new function, protected files unchanged by hash, new tests present and passing). The untouched task scores **8/23**.
- `PROMPT.md` — the exact prompt.

## Run it yourself
```bash
# 1. Copy the task for each agent/model you want to test
cp -r benchmark/inventory/task benchmark/runs/my-agent

# 2. Ask your orchestrator to call the bridge, e.g. opencode_task with
#    cwd = <absolute path to benchmark/runs/my-agent> and the prompt from PROMPT.md

# 3. Score the result
python benchmark/inventory/judge.py benchmark/runs/my-agent
```
`benchmark/runs/` is git-ignored.

## Results
See [RESULTS.md](RESULTS.md).
