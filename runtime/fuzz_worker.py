"""Runs the pinned fuzzer's generations in a Pyodide worker, one at a time, for web/fuzz-orchestrator.mjs.

fuzz.py's __main__ drives a process pool and enforces timeouts with timers and signals, none of which
exist in Pyodide. The orchestrator takes over scheduling and timeouts. This module repeats the rest of
fuzz.py using its own functions: the main loop's YAML writing, gen_wrapper's generation and outcome
classification, dump_generation_output's files, and the error keys gen_callback and write_report use.

Hooks run as they would natively. setup_main runs first, standing in for the main process whose state a
forked pool worker would inherit; setup_worker then runs on separate instances, which gen_wrapper would
register. One difference: natively a failing setup_worker turns every run into a failure, while here
setup() raises and the orchestrator stops the variant with that error.

Expects waimea_boot.prepare() to have run, with the apworld under test staged in worlds/.
"""
import json
import logging
import os
import random
import shutil
import tempfile
import time
import traceback
from argparse import Namespace
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO

_state = {}
_randint = random.randint


def _find_hook(hook_path):
    """fuzz.find_hook without its subclass check, which is inverted: it raises when the hook *is* a
    BaseHook subclass. Natively the check never fires, because fuzz.py runs as __main__ while hooks import
    a second copy of it as `fuzz`, so the two BaseHook classes differ. Here fuzz.py is imported once."""
    import importlib

    module_path, object_path = hook_path.split(":")
    obj = importlib.import_module(module_path)
    for inner in object_path.split("."):
        obj = getattr(obj, inner)
    if not isinstance(obj, type):
        raise RuntimeError("the hook argument should refer to a class in a module")
    return obj()


def setup(config_json):
    """Imports the fuzzer and sets up hooks. Returns the game name of the apworld under test."""
    config = json.loads(config_json)
    import fuzz
    from settings import get_settings

    # The argparse defaults of fuzz.py's __main__, with the orchestrator's values.
    args = Namespace(
        game=[config["apworld"]],
        jobs=1,
        runs=config["runs"],
        yamls_per_run=str(config.get("yamls_per_run", "1")),
        timeout=config["timeout"],
        meta=None,
        dump_ignored=bool(config.get("dump_ignored", False)),
        with_static_worlds=None,
        sample_from=None,
        hook=list(config.get("hooks", [])),
        skip_output=bool(config.get("skip_output", False)),
    )
    tmp = tempfile.mkdtemp(prefix="apfuzz")
    meta = {}
    if config.get("meta_yaml"):
        import yaml

        text = config["meta_yaml"].removeprefix("﻿")
        args.meta = os.path.join(tmp, "meta.yaml")
        with open(args.meta, "w", encoding="utf-8") as fd:
            fd.write(text)
        meta = yaml.safe_load(text)

    # fuzz.py's __main__ makes sure host.yaml exists before any generation.
    get_settings()
    game_name, _world = fuzz.world_from_apworld_name(config["apworld"])

    main_hooks = []
    for hook_path in args.hook:
        hook = _find_hook(hook_path)
        hook.setup_main(args)
        main_hooks.append(hook)

    bounds = [int(arg) for arg in args.yamls_per_run.split("-")]
    if len(bounds) not in {1, 2} or (len(bounds) == 2 and bounds[0] >= bounds[1]):
        raise Exception("Invalid value passed for `yamls_per_run`. Either pass an int or a range like `1-10`")

    static_yamls = []
    if args.with_static_worlds:
        for yaml_file in os.listdir(args.with_static_worlds):
            path = os.path.join(args.with_static_worlds, yaml_file)
            if os.path.isfile(path):
                with open(path, "r", encoding="utf-8-sig") as fd:
                    static_yamls.append(fd.read())

    for hook_path in args.hook:
        hook = _find_hook(hook_path)
        hook.setup_worker(args)
        fuzz.MP_HOOKS.append(hook)

    _state.update(fuzz=fuzz, args=args, meta=meta, tmp=tmp, bounds=bounds, static_yamls=static_yamls, main_hooks=main_hooks)
    return json.dumps({"game": game_name})


def _read_dir(path):
    files = {}
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if os.path.isfile(full):
            with open(full, "r", encoding="utf-8", errors="replace") as fd:
                files[name] = fd.read()
    return files


def prepare(i, seed):
    """Writes run i's YAMLs as fuzz.py's main loop does, from a per-run seed. Returns them by file name."""
    fuzz = _state["fuzz"]
    args = _state["args"]
    bounds = _state["bounds"]
    random.seed(seed)
    count = bounds[0] if len(bounds) == 1 else random.randrange(bounds[0], bounds[1] + 1)
    apworld = args.game[0]
    yamls = [(f"{i}-{nb}.yaml", fuzz.generate_random_yaml(apworld, _state["meta"])) for nb in range(count)]
    if i % 100 == 0:
        fuzz.clear_abc_caches()

    yamls_dir = tempfile.mkdtemp(prefix="apfuzz", dir=_state["tmp"])
    for name, content in yamls:
        with open(os.path.join(yamls_dir, name), "wb") as fd:
            fd.write(content.encode("utf-8"))
    for nb, content in enumerate(_state["static_yamls"]):
        with open(os.path.join(yamls_dir, f"static-{i}-{nb}.yaml"), "wb") as fd:
            fd.write(content.encode("utf-8"))
    _state["current"] = (i, yamls_dir)
    return json.dumps({"yamls": _read_dir(yamls_dir)})


def _names():
    outcome = _state["fuzz"].GenOutcome
    return {outcome.Success: "success", outcome.Failure: "failure", outcome.Timeout: "timeout", outcome.OptionError: "ignored"}


def _error_key(exc_type, exc_str):
    """write_report's key for an entry in fuzz.py's REPORT."""
    from Fill import FillError

    if exc_type == FillError:
        return "FillError"
    return exc_str if exc_str else str(exc_type)


def _finish(i, yamls_dir, outcome, raised, out_buf):
    """gen_wrapper's tail: which outcomes are dumped, with what log, and the REPORT key gen_callback adds."""
    fuzz = _state["fuzz"]
    args = _state["args"]
    kinds = fuzz.GenOutcome
    result = {"outcome": _names()[outcome], "key": None, "dump": None}
    if outcome == kinds.Success:
        return result
    if outcome == kinds.OptionError and not args.dump_ignored:
        return result

    if outcome == kinds.Timeout:
        extra = f"[...] Generation killed here after {args.timeout}s"
    elif isinstance(raised, fuzz.PlayerFilesError):
        extra = str(raised)
    else:
        extra = "".join(traceback.format_exception(raised))
    kind = {kinds.OptionError: "ignored", kinds.Timeout: "timeout"}.get(outcome, "error")
    result["dump"] = {"kind": kind, "files": {**_read_dir(yamls_dir), f"{i}.log": out_buf.getvalue() + extra}}

    if outcome == kinds.Failure:
        result["key"] = _error_key(type(raised), str(raised))
    elif outcome == kinds.Timeout:
        result["key"] = _error_key(TimeoutError, "")
    return result


def generate(generation_seed=None):
    """Generates the prepared run as gen_wrapper does, without its timer. Returns the outcome record,
    with the seconds call_generate took.

    generation_seed pins the seed call_generate otherwise draws at random, so a calibration run does the
    same work in every runtime.
    """
    fuzz = _state["fuzz"]
    args = _state["args"]
    from Options import OptionError

    i, yamls_dir = _state.pop("current")
    out_buf = StringIO()
    raised = None
    mw = None
    seconds = None
    try:
        with redirect_stdout(out_buf), redirect_stderr(out_buf), tempfile.TemporaryDirectory(prefix="apfuzz", dir=_state["tmp"]) as output_path:
            try:
                fuzz.patched_init_logging("Fuzzer")
                if generation_seed is not None:
                    fuzz.random.randint = lambda _a, _b: int(generation_seed)
                started = time.perf_counter()
                try:
                    mw = fuzz.call_generate(yamls_dir, args, output_path)
                finally:
                    seconds = time.perf_counter() - started
                    fuzz.random.randint = _randint
            except Exception as e:
                raised = e
            finally:
                try:
                    for hook in fuzz.MP_HOOKS:
                        hook.after_generate(mw, output_path)
                finally:
                    fuzz.clear_abc_caches()

                root_logger = logging.getLogger()
                for handler in root_logger.handlers[:]:
                    root_logger.removeHandler(handler)
                    handler.close()

                outcome = fuzz.GenOutcome.Success
                if raised:
                    is_timeout = isinstance(raised, TimeoutError)
                    is_option_error = fuzz.exception_in_causes(raised, OptionError)
                    if not is_option_error and isinstance(raised, fuzz.PlayerFilesError):
                        is_option_error = all(fuzz.exception_in_causes(e, OptionError) for e in raised.exceptions)
                    if is_timeout:
                        outcome = fuzz.GenOutcome.Timeout
                    elif is_option_error:
                        outcome = fuzz.GenOutcome.OptionError
                    else:
                        outcome = fuzz.GenOutcome.Failure

                for hook in fuzz.MP_HOOKS:
                    outcome, raised = hook.reclassify_outcome(outcome, raised)
                result = _finish(i, yamls_dir, outcome, raised, out_buf)
    except Exception as e:
        # gen_wrapper raises FuzzerException from here. The pool's error callback then dumps its output and
        # counts a failure with no exception, which write_report keys as "None".
        wrapped = fuzz.FuzzerException("Fuzzer error", out_buf)
        wrapped.__cause__ = e
        log = wrapped.out_buf + "\n".join(traceback.format_exception(wrapped))
        result = {"outcome": "failure", "key": "None", "dump": {"kind": "error", "files": {**_read_dir(yamls_dir), f"{i}.log": log}}}
    shutil.rmtree(yamls_dir, ignore_errors=True)
    result["seconds"] = seconds
    return json.dumps(result)


def timeout_outcome():
    """The outcome for a run the orchestrator killed: fuzz.py's timeout handler lets only the main
    process's hooks reclassify it."""
    fuzz = _state["fuzz"]
    outcome = fuzz.GenOutcome.Timeout
    for hook in _state["main_hooks"]:
        outcome, _ = hook.reclassify_outcome(outcome, TimeoutError())
    return _names()[outcome]
