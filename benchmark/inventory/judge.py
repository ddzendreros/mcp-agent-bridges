# Hidden judge for the "inventory" benchmark. Usage: python judge.py <directory-with-the-agent-result>
# The agent never sees this file. 23 checks: spec edge cases, the new function, protected files untouched,
# new tests present (>= 6) and passing.
import sys, os, importlib, hashlib, subprocess
d = os.path.abspath(sys.argv[1]); sys.path.insert(0, d); os.chdir(d)
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "task")
ok = 0; fails = []
def chk(name, fn):
    global ok
    try:
        r = fn()
        if r is False: raise AssertionError("false")
        ok += 1
    except Exception as e:
        fails.append(f"{name}: {type(e).__name__} {e}")
def raises(f):
    try: f()
    except ValueError: return True
    return False
inv = importlib.import_module("inventario")
P, I = inv.parse_linea, inv.parse_inventario
chk("upper", lambda: P("abc;1;2").sku == "ABC")
chk("espacios", lambda: tuple(P("  x1 ; 3 ; 4.5 ")) == ("X1", 3, 4.5))
chk("coma", lambda: P("a;1;12,50").precio == 12.5)
chk("neg cant", lambda: raises(lambda: P("a;-1;2")))
chk("neg precio", lambda: raises(lambda: P("a;1;-2")))
chk("cant no int", lambda: raises(lambda: P("a;1.5;2")))
chk("campos", lambda: raises(lambda: P("a;1")))
chk("sku vacio", lambda: raises(lambda: P(" ;1;2")))
chk("comentario", lambda: [tuple(x) for x in I("# hola\n\n  \na;1;2")] == [("A", 1, 2.0)])
chk("dup suma", lambda: [tuple(x) for x in I("a;1;2\nb;1;1\nA;3;5")] == [("A", 4, 5.0), ("B", 1, 1.0)])
chk("orden", lambda: [i.sku for i in I("z;1;1\na;1;1\nm;1;1")] == ["Z", "A", "M"])
chk("invalida", lambda: raises(lambda: I("a;1;2\nbasura")))
chk("total redondeo", lambda: inv.valor_total(I("a;3;0.1\nb;1;0.2")) == 0.5)
chk("total vacio", lambda: inv.valor_total([]) == 0)
R = inv.reabastecer
its = I("c;2;1\na;2;1\nb;0;1\nd;5;1")
chk("reab orden", lambda: R(its, 5) == ["B", "A", "C"])
chk("reab estricto", lambda: "D" not in R(its, 5))
chk("reab 0", lambda: R(its, 0) == [])
chk("reab neg", lambda: raises(lambda: R(its, -1)))
h = lambda p: hashlib.md5(open(p, "rb").read()).hexdigest()
chk("protegida", lambda: h("config_protegida.py") == h(os.path.join(base, "config_protegida.py")))
chk("test_base", lambda: h("tests/test_base.py") == h(os.path.join(base, "tests/test_base.py")))
chk("test_nuevo existe", lambda: os.path.getsize("tests/test_nuevo.py") > 200)
r = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], capture_output=True, text=True)
chk("tests pasan", lambda: r.returncode == 0)
chk("tests >=6", lambda: int(r.stderr.split("Ran ")[1].split()[0]) >= 6)
print(f"{ok}/{ok+len(fails)}"); [print(" -", f) for f in fails]
