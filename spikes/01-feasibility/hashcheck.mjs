const { loadPyodide } = await import("/home/troy/src/kalapana/vendor/pyodide/pyodide.mjs");
const code = `import sys, os; (hash("archipelago"), hash(frozenset({"a","b","c"})), list(frozenset(["alpha","beta","gamma","delta"])), sys.flags.hash_randomization, os.environ.get("PYTHONHASHSEED"))`;
for (let n = 0; n < 3; n++) {
  const py = await loadPyodide({ indexURL: "/home/troy/src/kalapana/vendor/pyodide/" });
  console.log(n, JSON.stringify(py.runPython(code).toJs()));
}
