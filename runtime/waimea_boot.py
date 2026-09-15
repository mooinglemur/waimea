"""Prepares Pyodide's interpreter for Archipelago's tests and the fuzzer.

Expects the core bundle unpacked at /, laid out as the index CI's image is, since fuzzer hooks name those
paths: AP's root at /ap/archipelago, zipped core worlds in /ap/supported_worlds, vendored modules under
/site-packages.
"""
import concurrent.futures
import concurrent.futures.thread
import os
import sys

AP_ROOT = "/ap/archipelago"
SITE_PACKAGES = "/site-packages"


class InlineExecutor(concurrent.futures.Executor):
    """Runs submitted work immediately, since Pyodide cannot start threads."""

    def __init__(self, *args, **kwargs):
        pass

    def submit(self, fn, /, *args, **kwargs):
        future = concurrent.futures.Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as e:
            future.set_exception(e)
        return future


def _disable_singledispatchmethod_cache() -> None:
    """Works around CPython gh-127750, which Pyodide 0.29's Python 3.13.2 still has.

    3.13.2's functools.singledispatchmethod caches each bound method in a WeakKeyDictionary keyed by the
    instance. The bound method refers to that instance, so the instance is never collected. Worlds that
    dispatch this way (Stardew Valley's logic) then fail test_memory's leak check, which passes natively.
    3.13.3 removed the cache; 3.13.2's code skips it when _method_cache is None.
    """
    import functools

    if sys.version_info[:3] != (3, 13, 2):
        return
    original_init = functools.singledispatchmethod.__init__

    def __init__(self, func):
        original_init(self, func)
        self._method_cache = None

    functools.singledispatchmethod.__init__ = __init__


def prepare() -> None:
    concurrent.futures.ThreadPoolExecutor = InlineExecutor
    concurrent.futures.thread.ThreadPoolExecutor = InlineExecutor
    # Before any world is imported, since decorating a method constructs a singledispatchmethod.
    _disable_singledispatchmethod_cache()

    # Vendored stubs (ssl, ModuleUpdate, ...) must win over anything else with the same name.
    for path in (SITE_PACKAGES, AP_ROOT):
        if path in sys.path:
            sys.path.remove(path)
    sys.path[:0] = [SITE_PACKAGES, AP_ROOT]

    try:
        import ssl  # noqa: F401  (Pyodide's ssl package, loaded only for worlds that use requests)
    except ImportError:
        import ssl_stub

        sys.modules["ssl"] = ssl_stub

    import bundled_libraries
    import native_stubs

    native_stubs.install()
    bundled_libraries.install()

    # A missing Players folder makes settings fall back to a native folder dialog.
    os.makedirs(os.path.join(AP_ROOT, "Players"), exist_ok=True)
    os.makedirs(os.path.join(AP_ROOT, "custom_worlds"), exist_ok=True)
    # Test discovery and the fuzzer both resolve paths from AP's root.
    os.chdir(AP_ROOT)
    os.environ["SKIP_REQUIREMENTS_UPDATE"] = "1"

    # ap_tests.py and fuzz.py find AP's root from argv[0], as they do when run from it natively.
    sys.argv = [os.path.join(AP_ROOT, "ap_tests.py")]
    import settings

    # A missing required file raises instead of opening a native file dialog.
    settings.no_gui = True
    settings.skip_autosave = True
