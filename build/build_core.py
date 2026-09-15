"""Builds core.zip, the Archipelago runtime the browser unpacks at /.

Runs under Pyodide (build-core.mjs) so its bytecode is compiled by the same Python the browser runs.
Expects the vendor directory mounted at /vendor, Waimea's runtime at /runtime, and writes /out/core.zip.

Layout:
  ap/                 AP's source tree without worlds, as the CI image has it, plus the pinned fuzzer
                      (fuzz.py, hooks/) and the lobby's ap_tests.py
  supported/          APQuest zipped as CI's prepare_worlds.sh does, and the pinned extra apworlds
  site-packages/      vendored wheels, source packages, and Waimea's runtime modules

Python sources are kept: unittest discovery finds tests by their .py files, and tracebacks show source
lines. Beside each one goes an unchecked hash-based .pyc in __pycache__, which imports use without
reading or checking the source.
"""
import importlib._bootstrap_external as bootstrap_external
import importlib.util
import io
import json
import os
import sys
import zipfile

VENDOR = "/vendor"
RUNTIME = "/runtime"
OUT = "/out/core.zip"
AP = os.path.join(VENDOR, "archipelago")
# ModuleUpdate is replaced by Waimea's stub, which installs nothing. Every world is left out of worlds/:
# APQuest is zipped into supported/, and the world under test arrives as an upload.
EXCLUDED_AP_TOP = {"ModuleUpdate.py", ".github", ".run"}
FIXED_TIME = (2000, 1, 1, 0, 0, 0)
CACHE_TAG = sys.implementation.cache_tag


def walk_files(root):
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for name in sorted(files):
            yield os.path.join(directory, name)


def zip_bytes(entries):
    """A reproducible zip of (archive path, bytes) pairs, as an apworld."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return buffer.getvalue()


def read(path):
    with open(path, "rb") as f:
        return f.read()


class BundleWriter:
    def __init__(self, path):
        self.archive = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9)
        self.files = 0
        self.compiled = 0

    def add(self, archive_path, data):
        self._write(archive_path, data)
        if archive_path.endswith(".py"):
            try:
                code = compile(data, "/" + archive_path, "exec", dont_inherit=True)
            except SyntaxError:
                # Importing it reports the error as usual.
                return
            directory, name = os.path.split(archive_path)
            pyc = os.path.join(directory, "__pycache__", f"{name[:-3]}.{CACHE_TAG}.pyc")
            self._write(pyc, bytes(bootstrap_external._code_to_hash_pyc(code, importlib.util.source_hash(data), checked=False)))
            self.compiled += 1

    def add_tree(self, root, prefix):
        for file in walk_files(root):
            self.add(prefix + os.path.relpath(file, root), read(file))

    def _write(self, name, data):
        info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        self.archive.writestr(info, data)
        self.files += 1

    def close(self):
        self.archive.close()


def build():
    writer = BundleWriter(OUT)

    for name in sorted(os.listdir(AP)):
        path = os.path.join(AP, name)
        if name in EXCLUDED_AP_TOP:
            continue
        if name == "worlds":
            continue
        if os.path.isfile(path):
            writer.add(f"ap/{name}", read(path))
        else:
            writer.add_tree(path, f"ap/{name}/")
    # worlds/ keeps its own modules, the generic world and the shared client frameworks (_bizhawk, ...),
    # which is what prepare_worlds.sh leaves behind.
    worlds = os.path.join(AP, "worlds")
    for name in sorted(os.listdir(worlds)):
        path = os.path.join(worlds, name)
        if os.path.isfile(path):
            writer.add(f"ap/worlds/{name}", read(path))
        elif name == "generic" or name.startswith("_"):
            writer.add_tree(path, f"ap/worlds/{name}/")
    apquest = os.path.join(worlds, "apquest")
    writer._write("supported/apquest.apworld", zip_bytes(
        (f"apquest/{os.path.relpath(file, apquest)}", read(file)) for file in walk_files(apquest)
    ))

    fuzzer = os.path.join(VENDOR, "fuzzer")
    writer.add("ap/fuzz.py", read(os.path.join(fuzzer, "fuzz.py")))
    writer.add_tree(os.path.join(fuzzer, "hooks"), "ap/hooks/")
    writer.add("ap/ap_tests.py", read(os.path.join(VENDOR, "lobby", "ap_tests.py")))
    for name in sorted(os.listdir(os.path.join(VENDOR, "apworlds"))):
        writer._write(f"supported/{name}", read(os.path.join(VENDOR, "apworlds", name)))

    for wheel in sorted(os.listdir(os.path.join(VENDOR, "wheels"))):
        with zipfile.ZipFile(os.path.join(VENDOR, "wheels", wheel)) as archive:
            for info in sorted(archive.infolist(), key=lambda i: i.filename):
                if not info.is_dir() and ".dist-info/" not in info.filename:
                    writer.add(f"site-packages/{info.filename}", archive.read(info))
    for package in sorted(os.listdir(os.path.join(VENDOR, "sources"))):
        writer.add_tree(os.path.join(VENDOR, "sources", package), f"site-packages/{package}/")
    for name in sorted(os.listdir(RUNTIME)):
        if name.endswith(".py"):
            writer.add(f"site-packages/{name}", read(os.path.join(RUNTIME, name)))

    writer.close()
    with open(os.path.join(VENDOR, "inputs.json")) as f:
        inputs = json.load(f)
    return {
        "files": writer.files,
        "compiled": writer.compiled,
        "bytes": os.path.getsize(OUT),
        "python": sys.version.split()[0],
        "archipelago": inputs["archipelago"]["commit"],
        "fuzzer": inputs["fuzzer"]["commit"],
        "lobby": inputs["lobby"]["commit"],
    }


result = json.dumps(build())
