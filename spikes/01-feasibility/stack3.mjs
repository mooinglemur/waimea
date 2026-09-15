const PYO = "/home/troy/src/kalapana/vendor/pyodide/";
const { loadPyodide } = await import(`${PYO}pyodide.mjs`);
const py = await loadPyodide({ indexURL: PYO, stdout: (s) => console.log(s) });
const [limit, step] = process.argv.slice(2);
py.runPython(`
import sys
if ${limit}: sys.setrecursionlimit(${limit})
print("limit", sys.getrecursionlimit(), flush=True)
class Rule:
    def __init__(self, inner): self.inner = inner
    def __call__(self, state): return self.inner(state) if self.inner else True
def chain(n):
    r = None
    for _ in range(n): r = Rule(r)
    return r(None)
depth = ${step}
while depth <= 200000:
    try:
        chain(depth)
    except RecursionError as e:
        print("RecursionError", depth, e, flush=True); break
    print("ok", depth, flush=True)
    depth += ${step}
`);
