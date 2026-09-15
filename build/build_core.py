"""Builds core.zip, the Archipelago runtime each browser worker unpacks at /.

Runs under Pyodide (build-core.mjs) so its bytecode is compiled by the same Python the browser runs.
Expects the vendor directory mounted at /vendor, Waimea's runtime at /runtime, and writes /out/core.zip.

The layout copies the index CI's ap-checker image, because fuzzer hooks name its paths:
  ap/archipelago/          AP's source tree after prepare_worlds.sh (only generic and the _* support
                           packages left in worlds/), with the pinned fuzz.py and hooks/, the lobby's
                           ap_tests.py, and tracker.apworld in worlds/
  ap/supported_worlds/     core worlds zipped as <world>-<AP version>.apworld: APQuest, which
                           ap_tests.py loads, and Kingdom Hearts, which the gerpocalypse hook loads
  ap/empty.apworld         the empty world the no-restrictive-starts hook loads
  site-packages/           vendored wheels, source packages, and Waimea's runtime modules

Python sources are kept: unittest discovery finds tests by their .py files, and tracebacks show source
lines. Beside each one goes an unchecked hash-based .pyc in __pycache__, which imports use without
reading or checking the source.
"""
import importlib._bootstrap_external as bootstrap_external
import importlib.util
import io
import json
import os
import re
import sys
import zipfile

VENDOR = "/vendor"
RUNTIME = "/runtime"
OUT = "/out/core.zip"
AP = os.path.join(VENDOR, "archipelago")
# ModuleUpdate is replaced by Waimea's stub, which installs nothing.
EXCLUDED_AP_TOP = {"ModuleUpdate.py", ".github", ".run"}
SUPPORTED_WORLDS = ["apquest", "kh1"]
FIXED_TIME = (2000, 1, 1, 0, 0, 0)
CACHE_TAG = sys.implementation.cache_tag


def walk_files(root):
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for name in sorted(files):
            yield os.path.join(directory, name)


def read(path):
    with open(path, "rb") as f:
        return f.read()


def zip_bytes(entries):
    """A reproducible zip of (archive path, bytes) pairs, such as an apworld."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return buffer.getvalue()


class BundleWriter:
    def __init__(self, path):
        self.archive = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9)
        self.files = 0
        self.compiled = 0

    def add(self, archive_path, data):
        """Adds a file, and for Python sources a precompiled cache beside it."""
        self.add_raw(archive_path, data)
        if archive_path.endswith(".py"):
            try:
                code = compile(data, "/" + archive_path, "exec", dont_inherit=True)
            except SyntaxError:
                # Importing it reports the error as usual.
                return
            directory, name = os.path.split(archive_path)
            pyc = os.path.join(directory, "__pycache__", f"{name[:-3]}.{CACHE_TAG}.pyc")
            self.add_raw(pyc, bytes(bootstrap_external._code_to_hash_pyc(code, importlib.util.source_hash(data), checked=False)))
            self.compiled += 1

    def add_tree(self, root, prefix):
        for file in walk_files(root):
            self.add(prefix + os.path.relpath(file, root), read(file))

    def add_raw(self, name, data):
        info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        self.archive.writestr(info, data)
        self.files += 1

    def close(self):
        self.archive.close()


def ap_version():
    # prepare_worlds.sh reads the version the same way.
    match = re.search(r'__version__ = "(\d+\.\d+\.\d+)"', read(os.path.join(AP, "Utils.py")).decode())
    return match.group(1)


def build():
    writer = BundleWriter(OUT)
    version = ap_version()
    root = "ap/archipelago"

    for name in sorted(os.listdir(AP)):
        path = os.path.join(AP, name)
        if name in EXCLUDED_AP_TOP or name == "worlds":
            continue
        if os.path.isfile(path):
            writer.add(f"{root}/{name}", read(path))
        else:
            writer.add_tree(path, f"{root}/{name}/")
    worlds = os.path.join(AP, "worlds")
    for name in sorted(os.listdir(worlds)):
        path = os.path.join(worlds, name)
        if os.path.isfile(path):
            writer.add(f"{root}/worlds/{name}", read(path))
        elif name == "generic" or name.startswith("_"):
            writer.add_tree(path, f"{root}/worlds/{name}/")
    for world in SUPPORTED_WORLDS:
        folder = os.path.join(worlds, world)
        writer.add_raw(f"ap/supported_worlds/{world}-{version}.apworld", zip_bytes(
            (f"{world}/{os.path.relpath(file, folder)}", read(file)) for file in walk_files(folder)
        ))

    fuzzer = os.path.join(VENDOR, "fuzzer")
    writer.add(f"{root}/fuzz.py", read(os.path.join(fuzzer, "fuzz.py")))
    writer.add_tree(os.path.join(fuzzer, "hooks"), f"{root}/hooks/")
    writer.add(f"{root}/ap_tests.py", read(os.path.join(VENDOR, "lobby", "ap_tests.py")))
    apworlds = os.path.join(VENDOR, "apworlds")
    writer.add_raw(f"{root}/worlds/tracker.apworld", read(os.path.join(apworlds, "tracker.apworld")))
    writer.add_raw("ap/empty.apworld", read(os.path.join(apworlds, "empty.apworld")))

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
        "archipelagoVersion": version,
        "archipelago": inputs["archipelago"]["commit"],
        "fuzzer": inputs["fuzzer"]["commit"],
        "lobby": inputs["lobby"]["commit"],
    }


result = json.dumps(build())
