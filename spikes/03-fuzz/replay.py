"""Replays one fuzz generation from its YAMLs and seed, to check an outcome reproduces in another runtime.

fuzz.call_generate draws the generation seed from random.randint; this pins that one call and otherwise
runs the fuzzer's own code. There's no timeout. Under Pyodide, replay.mjs calls replay(); natively, run
from AP's root: python replay.py <yamls dir> <seed>.
"""
import json
import os
import sys
import tempfile
import time
import traceback
from argparse import Namespace


def replay(yamls_dir, seed):
    import fuzz

    original = fuzz.random.randint
    fuzz.random.randint = lambda _a, _b: int(seed)
    started = time.perf_counter()
    try:
        with tempfile.TemporaryDirectory(prefix="apfuzz") as output_path:
            fuzz.patched_init_logging("Fuzzer")
            fuzz.call_generate(yamls_dir, Namespace(skip_output=False), output_path)
        result = {"outcome": "success"}
    except Exception as e:
        result = {"outcome": "exception", "type": type(e).__name__, "message": str(e)[:500], "traceback": "".join(traceback.format_exception(e))[-1500:]}
    finally:
        fuzz.random.randint = original
    result["seconds"] = round(time.perf_counter() - started, 1)
    result["python"] = sys.version.split()[0]
    return json.dumps(result)


if __name__ == "__main__" and sys.platform != "emscripten":
    yamls_dir, seed = os.path.abspath(sys.argv[1]), sys.argv[2]
    ap_root = os.getcwd()
    sys.argv = [os.path.join(ap_root, "fuzz.py")]
    sys.path.insert(0, ap_root)
    os.environ["SKIP_REQUIREMENTS_UPDATE"] = "1"
    result = replay(yamls_dir, seed)
    sys.__stdout__.write(result + "\n")
