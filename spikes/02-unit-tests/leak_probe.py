"""Why does test_memory.test_leak fail for Stardew Valley under Pyodide but not natively?

Loads the world as unit_tests.run does, builds a solo multiworld as the test does, then reports whether
it survives gc and what still refers to it. Runs the same way natively (cwd = AP root, argv: apworld
paths) and under Pyodide (probe.mjs calls probe()).
"""
import gc
import json
import sys
import types
import weakref


def describe(obj):
    if isinstance(obj, types.FrameType):
        return f"frame {obj.f_code.co_filename}:{obj.f_lineno} {obj.f_code.co_name}"
    if isinstance(obj, dict):
        return f"dict({len(obj)}) keys={list(obj)[:6]!r}"[:200]
    if isinstance(obj, (list, tuple, set)):
        return f"{type(obj).__name__}({len(obj)})"
    if isinstance(obj, types.FunctionType):
        return f"function {obj.__module__}.{obj.__qualname__}"
    if isinstance(obj, types.CellType):
        return "cell"
    return f"{type(obj).__module__}.{type(obj).__qualname__}"


def chain(target, depth=6, fanout=4):
    """Referrer tree from target outward, skipping this probe's own frames and containers."""
    seen = {id(sys._getframe())}
    lines = []

    def walk(obj, level):
        if level > depth:
            return
        referrers = [r for r in gc.get_referrers(obj) if id(r) not in seen and not isinstance(r, types.FrameType)]
        for r in referrers[:fanout]:
            seen.add(id(r))
            lines.append("  " * level + describe(r))
            if isinstance(r, types.ModuleType) or (isinstance(r, dict) and "__name__" in r and "__builtins__" in r):
                continue
            walk(r, level + 1)

    walk(target, 0)
    return lines


def probe(apworld_path, apquest_path, game):
    import unit_tests
    from test.general import setup_solo_multiworld
    from worlds.AutoWorld import AutoWorldRegister

    unit_tests.load_apworld(apworld_path)
    unit_tests.load_apworld(apquest_path)
    for name in list(AutoWorldRegister.world_types):
        if name not in ("Test Game", "APQuest", "Archipelago", game):
            del AutoWorldRegister.world_types[name]

    result = {"python": sys.version.split()[0], "gc_thresholds": gc.get_threshold()}
    weak = weakref.ref(setup_solo_multiworld(AutoWorldRegister.world_types[game]))
    gc.collect()
    result["alive_after_1_collect"] = weak() is not None
    for _ in range(3):
        gc.collect()
    result["alive_after_4_collects"] = weak() is not None
    if weak() is not None:
        result["referrers"] = chain(weak())
    return json.dumps(result, indent=1)


if __name__ == "__main__" and sys.platform != "emscripten":
    import os

    sys.path.insert(0, os.getcwd())
    sys.path.append(os.path.join(os.path.dirname(os.getcwd()), "site-packages"))
    os.environ["SKIP_REQUIREMENTS_UPDATE"] = "1"
    sys.argv = [os.path.join(os.getcwd(), "ap_tests.py")]
    print(probe(os.environ["APWORLD"], os.environ["APQUEST"], os.environ["GAME"]))
