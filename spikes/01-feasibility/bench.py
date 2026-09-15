"""Fuzz-generation benchmark that runs the same way under Pyodide and native CPython.

Reuses the pinned fuzzer's generate_random_yaml and call_generate. Native usage:
  python bench.py '<json config>' > result.json   (cwd = unpacked tree's ap/)
Under Pyodide the driver runs this file, then calls bench(config_json, heap_bytes).
"""
import hashlib
import json
import logging
import os
import random
import shutil
import sys
import tempfile
import time
import traceback
from argparse import Namespace
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO


def _chain(e):
    while e is not None:
        yield e
        e = e.__cause__ or e.__context__


def bench(config_json, heap_bytes):
    config = json.loads(config_json)
    t_import = time.perf_counter()
    import fuzz
    from Options import OptionError

    import_seconds = time.perf_counter() - t_import
    runs = []
    heap = []
    for i in range(config["runs"]):
        random.seed(config["seed"] + i)
        record = {"i": i}
        t0 = time.perf_counter()
        buf = StringIO()
        yamls_dir = tempfile.mkdtemp(prefix="apfuzz")
        try:
            yaml_text = fuzz.generate_random_yaml(config["world"], {})
            record["yaml"] = hashlib.sha256(yaml_text.encode()).hexdigest()[:12]
            with open(os.path.join(yamls_dir, f"{i}-0.yaml"), "w", encoding="utf-8") as fd:
                fd.write(yaml_text)
            with redirect_stdout(buf), redirect_stderr(buf), tempfile.TemporaryDirectory(prefix="apfuzz") as out:
                fuzz.patched_init_logging("Fuzzer")
                fuzz.call_generate(yamls_dir, Namespace(skip_output=config.get("skip_output", False)), out)
            record["outcome"] = "success"
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt):
                raise
            chain = list(_chain(e))
            if any(isinstance(c, RecursionError) for c in chain):
                record["outcome"] = "recursion"
            elif fuzz.exception_in_causes(e, OptionError):
                record["outcome"] = "ignored"
            else:
                record["outcome"] = "failure"
            record["error"] = "".join(traceback.format_exception_only(e)).strip()[-300:]
            if record["outcome"] != "ignored":
                record["traceback"] = "".join(traceback.format_exception(e))[-3000:]
        finally:
            fuzz.clear_abc_caches()
            if config.get("gc"):
                import gc

                gc.collect()
            root = logging.getLogger()
            for handler in root.handlers[:]:
                root.removeHandler(handler)
                handler.close()
            shutil.rmtree(yamls_dir, ignore_errors=True)
        record["seconds"] = time.perf_counter() - t0
        runs.append(record)
        if i % 10 == 9 or i == config["runs"] - 1:
            heap.append({"after": i + 1, "bytes": heap_bytes()})
    return json.dumps({
        "python": sys.version,
        "recursionlimit": sys.getrecursionlimit(),
        "import_seconds": import_seconds,
        "runs": runs,
        "heap": heap,
    })


if __name__ == "__main__" and sys.platform != "emscripten":
    config_json = sys.argv[1]
    ap_root = os.getcwd()
    sys.argv = [os.path.join(ap_root, "fuzz.py")]
    sys.path.insert(0, ap_root)
    # Only for the ModuleUpdate stub: real venv packages stay ahead of Kalapana's other stubs.
    sys.path.append(os.path.join(os.path.dirname(ap_root), "site-packages"))
    os.environ["SKIP_REQUIREMENTS_UPDATE"] = "1"
    os.makedirs("Players", exist_ok=True)

    def rss():
        with open("/proc/self/statm") as fd:
            return int(fd.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")

    result = bench(config_json, rss)
    sys.__stdout__.write(result)
