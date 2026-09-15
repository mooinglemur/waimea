"""Summarize spike results in out/: per world and runtime, timing, outcomes, heap, and ratio to native."""
import json
import os
import statistics as st

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
SOURCES = [
    ("native", "{tag}-nat-{w}.json"),
    ("node-pyodide", "{tag}-pyo-{w}.json"),
    ("chrome", "browser-chrome-{w}.json"),
    ("firefox", "browser-firefox-{w}.json"),
]


def load(name):
    path = os.path.join(OUT, name)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return None
    with open(path) as fd:
        return json.load(fd)


def summarize(label, data, native_mean):
    if "runs" not in data:
        print(f"  {label:13} CRASH/ERROR: {str(data.get('crash') or data.get('error'))[-400:]}")
        return None
    runs = data["runs"]
    times = sorted(r["seconds"] for r in runs)
    outcomes = {}
    for r in runs:
        outcomes[r["outcome"]] = outcomes.get(r["outcome"], 0) + 1
    mean = st.mean(times)
    p95 = times[min(len(times) - 1, int(len(times) * 0.95))]
    ratio = f"{mean / native_mean:.2f}x" if native_mean else "-"
    heap = data.get("heap", [])
    heap_mib = [h["bytes"] / 2**20 for h in heap]
    growth = ""
    if len(heap) >= 2:
        per_gen = (heap[-1]["bytes"] - heap[0]["bytes"]) / (heap[-1]["after"] - heap[0]["after"])
        growth = f" heap {heap_mib[0]:.0f}->{heap_mib[-1]:.0f} MiB ({per_gen / 1024:.1f} KiB/gen)"
    phases = data.get("phases")
    boot = ""
    if phases:
        boot = " boot " + "+".join(f"{phases[k]:.2f}" for k in ("loadPyodide", "loadPackage", "unpack") if k in phases) + "s"
    print(f"  {label:13} n={len(runs)} mean {mean:.3f}s median {st.median(times):.3f}s p95 {p95:.3f}s "
          f"total {sum(times):.1f}s {ratio} {outcomes}{growth}{boot}")
    for r in runs:
        if r["outcome"] not in ("success", "ignored"):
            print(f"      run {r['i']} {r['outcome']}: {r.get('error', '')[:200]}")
    return mean


for tag, world in (("full", "apquest"), ("full", "tunic"), ("full", "stardew_valley"), ("long", "tunic")):
    print(f"== {world} ({tag})")
    native_mean = None
    results = {}
    for label, pattern in SOURCES:
        if label in ("chrome", "firefox") and tag == "long":
            continue
        data = load(pattern.format(tag=tag, w=world))
        if data is None:
            print(f"  {label:13} (missing)")
            continue
        results[label] = data
        mean = summarize(label, data, native_mean)
        if label == "native":
            native_mean = mean
    if "native" in results and "node-pyodide" in results and "runs" in results["node-pyodide"]:
        same = sum(a.get("yaml") == b.get("yaml") for a, b in zip(results["native"]["runs"], results["node-pyodide"]["runs"]))
        print(f"  identical YAMLs native vs node-pyodide: {same}/{len(results['native']['runs'])}")
