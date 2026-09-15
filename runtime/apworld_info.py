"""Describes an uploaded apworld before any test runs: its module, manifest, and the games it registers.

The index CI's handler requires an apworld's top-level folder to be its module name, and the uploaded
file's name can differ from both (a browser may save it as "librarian (1).apworld"), so the folder is
what's reported. Expects waimea_boot.prepare() to have run.
"""
import json
import traceback
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO


def _module_and_manifest(apworld_path):
    with zipfile.ZipFile(apworld_path) as archive:
        names = [name for name in archive.namelist() if not name.startswith("__MACOSX/")]
        folders = sorted({name.split("/", 1)[0] for name in names if "/" in name})
        if len(folders) != 1:
            raise ValueError(f"an apworld must hold exactly one top-level folder, found {folders}")
        module = folders[0]
        manifest = {}
        # Newer builds put archipelago.json beside the folder; older ones inside it.
        for candidate in (f"{module}/archipelago.json", "archipelago.json"):
            if candidate in names:
                manifest = json.loads(archive.read(candidate))
                break
    return module, manifest


def describe(apworld_path):
    """JSON: {ok, module, version, manifest, games} or {ok: false, error, log}."""
    log = StringIO()
    try:
        module, manifest = _module_and_manifest(apworld_path)
        with redirect_stdout(log), redirect_stderr(log):
            import unit_tests
            from worlds.AutoWorld import AutoWorldRegister

            unit_tests.load_apworld(apworld_path, module)
        games = sorted(
            name for name, world in AutoWorldRegister.world_types.items()
            if world.__module__.split(".")[:2] == ["worlds", module]
        )
        if not games:
            raise ValueError(f"worlds.{module} registered no World classes")
        return json.dumps({
            "ok": True,
            "module": module,
            "version": manifest.get("world_version"),
            "manifest": manifest,
            "games": games,
        })
    except BaseException:
        return json.dumps({"ok": False, "error": traceback.format_exc()[-4000:], "log": log.getvalue()[-4000:]})
