const PYO = "/home/troy/src/kalapana/vendor/pyodide/";
const { loadPyodide } = await import(`${PYO}pyodide.mjs`);
const py = await loadPyodide({ indexURL: PYO, stdout: (s) => console.log(s) });
const kind = process.argv[2];
py.runPython(`
import sys
sys.setrecursionlimit(1_000_000)
def plain(n): return 0 if n == 0 else 1 + plain(n - 1)
class Rule:
    def __init__(self, inner): self.inner = inner
    def __call__(self, state): return self.inner(state) if self.inner else True
def chain(n):
    r = None
    for _ in range(n): r = Rule(r)
    return r(None)
lam = lambda n: 0 if n == 0 else 1 + lam(n - 1)
fn = {"plain": plain, "callable": chain, "lambda": lam}["${kind}"]
for depth in range(500, 200001, 500):
    fn(depth)
    print("ok", depth, flush=True)
`);
