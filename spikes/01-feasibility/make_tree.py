"""Zip AP core + one world + pinned fuzzer + Kalapana runtime stubs, laid out like Kalapana's core bundle.

Usage: python make_tree.py <world folder> <out.zip>
"""
import os
import sys
import zipfile

AP = "/home/troy/src/kalapana/vendor/archipelago"
KALAPANA = "/home/troy/src/kalapana"
FUZZER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fuzzer")
EXCLUDED_MODULES = {"kvui.py", "setup.py", "WebHost.py", "conftest.py", "ModuleUpdate.py"}
EXCLUDED_PACKAGES = {"WebHostLib", "test", "worlds"}


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        for name in sorted(filenames):
            yield os.path.join(dirpath, name)


world, out = sys.argv[1:3]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    def add_tree(root, prefix):
        for file in walk(root):
            z.write(file, prefix + os.path.relpath(file, root))

    z.write(os.path.join(AP, "LICENSE"), "ap/LICENSE")
    for name in sorted(os.listdir(AP)):
        path = os.path.join(AP, name)
        if os.path.isfile(path) and name.endswith(".py") and name not in EXCLUDED_MODULES:
            z.write(path, f"ap/{name}")
        elif os.path.isdir(path) and name not in EXCLUDED_PACKAGES and os.path.exists(os.path.join(path, "__init__.py")):
            add_tree(path, f"ap/{name}/")
    for name in sorted(os.listdir(os.path.join(AP, "worlds"))):
        path = os.path.join(AP, "worlds", name)
        if os.path.isfile(path) and name.endswith(".py"):
            z.write(path, f"ap/worlds/{name}")
        elif os.path.isdir(path) and (name in ("generic", world) or (name.startswith("_") and name != "_sc2common")):
            add_tree(path, f"ap/worlds/{name}/")
    z.write(os.path.join(FUZZER, "fuzz.py"), "ap/fuzz.py")
    add_tree(os.path.join(FUZZER, "hooks"), "ap/hooks/")

    for wheel in sorted(os.listdir(os.path.join(KALAPANA, "vendor", "wheels"))):
        with zipfile.ZipFile(os.path.join(KALAPANA, "vendor", "wheels", wheel)) as archive:
            for info in archive.infolist():
                if not info.is_dir() and ".dist-info/" not in info.filename:
                    z.writestr(f"site-packages/{info.filename}", archive.read(info))
    for name in sorted(os.listdir(os.path.join(KALAPANA, "runtime"))):
        if name.endswith(".py"):
            z.write(os.path.join(KALAPANA, "runtime", name), f"site-packages/{name}")
