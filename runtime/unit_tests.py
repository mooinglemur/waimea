"""Runs an apworld's unit tests the way the index CI does, reporting each result as it happens.

The CI runs the lobby's ap_tests.py: the world's WorldTestBase battery plus AP's test/general, in one
process, with every other world unloaded and per-world expectation annotations applied. This module
repeats its __main__ block, reusing its annotation logic, so outcomes, test ids and the .aptest and
.toml files match. The one addition is `emit`, called with a JSON string for each event.

Expects waimea_boot.prepare() to have run, with ap_tests.py in AP's root.
"""
import importlib.abc
import io
import json
import os
import sys
import time
import types
import unittest
import zipfile
import zipimport
from pathlib import Path

_apworld_specs = {}


def _import_ap_tests(argv):
    """Imports ap_tests.py, which checks its argv at import and exits unless given its seven arguments."""
    # It imports the lobby's handler, which needs OpenTelemetry and requests, only to build an ApHandler
    # in its __main__ block. load_apworld below stands in for it.
    sys.modules.setdefault("handler", types.ModuleType("handler"))
    saved = sys.argv
    sys.argv = [os.path.join(os.getcwd(), "ap_tests.py"), *argv]
    try:
        import ap_tests
    finally:
        sys.argv = saved
    return ap_tests


class _APWorldFinder(importlib.abc.MetaPathFinder):
    """Like handler's finder: answers imports of worlds loaded from an apworld outside worlds/."""

    def find_spec(self, fullname, _path=None, _target=None):
        return _apworld_specs.get(fullname)


sys.meta_path.insert(0, _APWorldFinder())


def read_manifest(apworld_path):
    """(game, world_version) from archipelago.json, as handler.ApHandler.read_apworld_manifest does."""
    from Utils import tuplize_version
    from worlds.Files import APWorldContainer

    with zipfile.ZipFile(apworld_path) as zf:
        for info in zf.infolist():
            if info.filename.endswith("archipelago.json"):
                with zf.open(info) as f:
                    manifest = json.load(f)
                if "compatible_version" in manifest and manifest["compatible_version"] > APWorldContainer.version:
                    raise Exception(
                        f"Apworld requires container version {manifest['compatible_version']} "
                        f"but we only support {APWorldContainer.version}"
                    )
                world_version = None
                if "world_version" in manifest:
                    try:
                        world_version = tuplize_version(manifest["world_version"])
                    except Exception:
                        pass
                return manifest.get("game"), world_version
    return None, None


def load_apworld(apworld_path):
    """Loads an apworld as handler.ApHandler.load_apworld does. The file's stem is its module name."""
    import worlds
    from worlds import WorldSource
    from worlds.AutoWorld import AutoWorldRegister

    game, world_version = read_manifest(apworld_path)
    module = f"worlds.{Path(apworld_path).stem}"
    _apworld_specs[module] = zipimport.zipimporter(apworld_path).find_spec(module)
    if not WorldSource(apworld_path, is_zip=True, relative=False).load():
        raise RuntimeError(f"{Path(apworld_path).name} failed to load; see the log")
    if game and game in AutoWorldRegister.world_types and world_version:
        AutoWorldRegister.world_types[game].world_version = world_version
    for name, world in AutoWorldRegister.world_types.items():
        if name not in worlds.network_data_package["games"]:
            worlds.network_data_package["games"][name] = world.get_data_package_data()
    return game


def _parent_id(test):
    return test.test_case.id() if hasattr(test, "test_case") else None


def run(apworld_path, apquest_path, apworld, version, world_name, annotations_folder, output_folder, emit):
    """Returns ap_tests.py's exit status: 0 on success, 69 when a FillError caused the failure, else 1.

    apquest_path is AP's APQuest packaged as an apworld, which ap_tests.py loads beside the world under
    test.
    """
    from Fill import FillError
    from test.bases import WorldTestBase
    from worlds.AutoWorld import AutoWorldRegister
    from worlds.Files import AutoPatchRegister

    def send(**event):
        emit(json.dumps(event))

    ap_tests = _import_ap_tests([os.path.dirname(apquest_path), os.path.dirname(apworld_path), apworld,
                                 version, world_name, annotations_folder, output_folder])
    os.makedirs(output_folder, exist_ok=True)
    load_apworld(apworld_path)
    load_apworld(apquest_path)

    # Unload as many worlds as possible before running tests, as ap_tests.py does.
    for loaded_world in list(AutoWorldRegister.world_types):
        if loaded_world in ("Test Game", "APQuest", "Archipelago") or loaded_world == world_name:
            continue
        del AutoWorldRegister.world_types[loaded_world]
        AutoPatchRegister.patch_types.pop(loaded_world, None)

    annotations = ap_tests.get_annotations_for_game(annotations_folder, apworld, version)
    expected = lambda test, **kw: ap_tests._expected_result(test, annotations, **kw)  # noqa: E731

    # Defined in ap_tests.py's __main__, so its test ids (and the annotations keyed by them) start
    # with __main__.WorldTest.
    WorldTest = type("WorldTest", (WorldTestBase,), {"game": world_name, "__module__": "__main__"})

    class Result(unittest.TextTestResult):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.has_fill_errors = False
            self._started = {}

        def startTest(self, test):
            super().startTest(test)
            self._started[test.id()] = time.perf_counter()
            send(type="start", id=test.id())

        def stopTest(self, test):
            # A test whose subtest failed gets no result of its own, so the page closes tests on this.
            super().stopTest(test)
            send(type="stop", id=test.id())

        def _report(self, test, outcome, err=None):
            start = self._started.get(test.id()) or self._started.get(_parent_id(test) or "")
            send(
                type="result",
                id=test.id(),
                parent=_parent_id(test),
                outcome=outcome,
                description=test.shortDescription(),
                traceback=self._exc_info_to_string(err, test) if err else None,
                seconds=time.perf_counter() - start if start else None,
            )

        # The bodies below follow ap_tests.py's MyResult; _report calls are the only additions.
        def _shouldIgnoreResult(self, test):
            if expected(test) == "flaky":
                return True
            if hasattr(test, "test_case"):
                return expected(test.test_case, ignore_params=True) == "error"
            return False

        def addFailure(self, test, err):
            if self._shouldIgnoreResult(test):
                self.addSkip(test, "A subtest is failing for a test that errors out")
                return
            if expected(test) == "fail":
                self.addExpectedFailure(test, err)
                self._report(test, "expected_failure", err)
            else:
                super().addFailure(test, err)
                self._report(test, "failure", err)

        def addError(self, test, err):
            if self._shouldIgnoreResult(test):
                self.addSkip(test, "A subtest is failing for a test that errors out")
                return
            if isinstance(err[1], FillError):
                self.has_fill_errors = True
            if expected(test) == "error":
                super().addExpectedFailure(test, err)
                self._report(test, "expected_failure", err)
            else:
                super().addError(test, err)
                self._report(test, "error", err)
            self.stop()

        def addSuccess(self, test):
            if self._shouldIgnoreResult(test):
                self.addSkip(test, "A subtest is failing for a test that errors out")
                return
            if expected(test) == "success":
                super().addSuccess(test)
                self._report(test, "success")
            else:
                super().addUnexpectedSuccess(test)
                self._report(test, "unexpected_success")

        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            send(type="result", id=test.id(), parent=_parent_id(test), outcome="skipped", description=reason)

        def addSubTest(self, test, subtest, err):
            if err is None:
                return self.addSuccess(subtest)
            if issubclass(err[0], test.failureException):
                self.addFailure(subtest, err)
            else:
                self.addError(subtest, err)

        def hasFillErrors(self):
            return self.has_fill_errors

    suite = unittest.TestSuite()
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(WorldTest))
    suite.addTests(unittest.defaultTestLoader.discover("test/general", top_level_dir="."))

    def ids(tests):
        for test in tests:
            if isinstance(test, unittest.TestSuite):
                yield from ids(test)
            else:
                yield test.id()

    send(type="plan", tests=list(ids(suite)))
    runner = unittest.TextTestRunner(stream=io.StringIO(), verbosity=1, resultclass=Result)
    results = runner.run(suite)

    # Output files, exactly as ap_tests.py writes them.
    if results.failures or results.errors or results.unexpectedSuccesses or results.expectedFailures:
        output = {
            "failures": {t.id(): {"traceback": tb, "description": t.shortDescription()} for t, tb in results.failures},
            "errors": {t.id(): {"traceback": tb, "description": t.shortDescription()} for t, tb in results.errors},
            "expected_failures": {t.id(): {"traceback": tb, "description": t.shortDescription()} for t, tb in results.expectedFailures},
            "unexpected_successes": {t.id(): {"description": t.shortDescription()} for t in results.unexpectedSuccesses},
            "apworld": apworld,
            "version": version,
            "world_name": world_name,
        }
        with open(os.path.join(output_folder, f"{apworld}.aptest"), "w") as fd:
            fd.write(json.dumps(output))
    new_expectations = ap_tests._get_new_expectations_from(annotations_folder, apworld, results, version)
    with open(os.path.join(output_folder, f"{apworld}.toml"), "w") as fd:
        fd.write(new_expectations)

    status = 0 if results.wasSuccessful() else (69 if results.hasFillErrors() else 1)
    send(
        type="done",
        status=status,
        stopped_early=results.shouldStop,
        run=results.testsRun,
        failures=len(results.failures),
        errors=len(results.errors),
        skipped=len(results.skipped),
        expected_failures=len(results.expectedFailures),
        unexpected_successes=len(results.unexpectedSuccesses),
    )
    return status
