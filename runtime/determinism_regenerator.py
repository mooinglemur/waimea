"""The paired worker for check-determinism: the pinned hooks/determinism.py's worker_main, one request at a time.

Natively this is a long-lived child process reading pickled generation args from a pipe. Here the orchestrator
passes each request from the fuzz worker (runtime/waimea_determinism.py) and returns the response to it. Being a
separate Pyodide instance, it has its own string hash randomization, which is what the check relies on.

Two differences, both from not sharing a filesystem with the fuzz worker:
- the request carries the run's YAMLs, written here at the path the args name;
- the output directory is created here and removed afterward.

Expects waimea_boot.prepare() to have run, with the apworld under test staged in worlds/.
"""
import base64
import gc
import json
import os
import pickle
import shutil
import sys
import traceback
from abc import ABCMeta
from io import StringIO

_state = {}


def setup():
    # The native child disables logging setup before anything imports it, and sends stdout to devnull.
    import Utils

    Utils.init_logging = lambda *args, **kwargs: None

    import worlds  # noqa: F401
    from Generate import main as GenMain
    from Main import main as ERmain
    from hooks import determinism

    abc_classes = [obj for obj in gc.get_objects() if isinstance(obj, ABCMeta)]
    _state.update(GenMain=GenMain, ERmain=ERmain, determinism=determinism, abc_classes=abc_classes)


def _clear_abc_caches():
    for cls in _state["abc_classes"]:
        try:
            cls._abc_caches_clear()
        except Exception:
            pass


def regenerate(request_json):
    """Regenerates one run. Returns {status: "ok", state} (a pickled serialized multiworld, base64) or
    {status: "error", text}, the native child's two replies."""
    request = json.loads(request_json)
    args = pickle.loads(base64.b64decode(request["args"]))
    yamls_dir = args.player_files_path
    os.makedirs(yamls_dir, exist_ok=True)
    for name, text in request["yamls"].items():
        with open(os.path.join(yamls_dir, name), "wb") as fd:
            fd.write(text.encode("utf-8"))
    os.makedirs(args.outputpath, exist_ok=True)

    capture = StringIO()
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = StringIO()
    sys.stderr = capture
    try:
        erargs, seed = _state["GenMain"](args)
        mw = _state["ERmain"](erargs, seed)
        state = _state["determinism"].serialize_multiworld(mw)
        del mw
        response = {"status": "ok", "state": base64.b64encode(pickle.dumps(state, protocol=pickle.HIGHEST_PROTOCOL)).decode("ascii")}
    except Exception as e:
        logs = capture.getvalue()
        response = {"status": "error", "text": f"{e}\n{traceback.format_exc()}\n{logs}"}
    finally:
        sys.stdout, sys.stderr = old_stdout, old_stderr
        _clear_abc_caches()
        shutil.rmtree(yamls_dir, ignore_errors=True)
        shutil.rmtree(args.outputpath, ignore_errors=True)
    return json.dumps(response)
