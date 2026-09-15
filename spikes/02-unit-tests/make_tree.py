"""Builds the unit-test tree from vendor/: AP's whole source tree without its worlds, as the CI image
has it, plus the lobby's ap_tests.py and Waimea's runtime. Also packages APQuest and a core world as
.apworld files, the second standing in for an upload.

Usage: python make_tree.py <world folder> <out dir> <ap_tests.py>
Writes <out dir>/tree.zip (unpacks at /) and <out dir>/<world>.apworld.
"""
import os
import sys
import zipfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
AP = os.path.join(REPO, "vendor", "archipelago")
# ModuleUpdate is replaced by Waimea's stub. Everything else stays: test/general reads files across the
# tree (requirements.txt files, data/, WebHostLib/).
EXCLUDED_TOP = {"ModuleUpdate.py", "worlds", ".github", ".run"}
# The CI image zips every other core world out of worlds/ (prepare_worlds.sh), and ap_tests.py loads
# APQuest from its zip.
KEPT_WORLDS = {"generic"}


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        for name in sorted(filenames):
            yield os.path.join(dirpath, name)


world, out_dir, ap_tests = sys.argv[1:4]
os.makedirs(out_dir, exist_ok=True)

with zipfile.ZipFile(os.path.join(out_dir, "tree.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    def add_tree(root, prefix):
        for file in walk(root):
            z.write(file, prefix + os.path.relpath(file, root))

    z.write(ap_tests, "ap/ap_tests.py")
    for name in sorted(os.listdir(AP)):
        path = os.path.join(AP, name)
        if name in EXCLUDED_TOP:
            continue
        if os.path.isfile(path):
            z.write(path, f"ap/{name}")
        else:
            add_tree(path, f"ap/{name}/")
    for name in sorted(os.listdir(os.path.join(AP, "worlds"))):
        path = os.path.join(AP, "worlds", name)
        if os.path.isfile(path) and name.endswith(".py"):
            z.write(path, f"ap/worlds/{name}")
        elif os.path.isdir(path) and (name in KEPT_WORLDS or (name.startswith("_") and name != "_sc2common")):
            add_tree(path, f"ap/worlds/{name}/")

    for wheel in sorted(os.listdir(os.path.join(REPO, "vendor", "wheels"))):
        with zipfile.ZipFile(os.path.join(REPO, "vendor", "wheels", wheel)) as archive:
            for info in archive.infolist():
                if not info.is_dir() and ".dist-info/" not in info.filename:
                    z.writestr(f"site-packages/{info.filename}", archive.read(info))
    for package in sorted(os.listdir(os.path.join(REPO, "vendor", "sources"))):
        add_tree(os.path.join(REPO, "vendor", "sources", package), f"site-packages/{package}/")
    for name in sorted(os.listdir(os.path.join(REPO, "runtime"))):
        if name.endswith(".py"):
            z.write(os.path.join(REPO, "runtime", name), f"site-packages/{name}")

for name in {world, "apquest"}:
    with zipfile.ZipFile(os.path.join(out_dir, f"{name}.apworld"), "w", zipfile.ZIP_DEFLATED) as z:
        for file in walk(os.path.join(AP, "worlds", name)):
            z.write(file, f"{name}/" + os.path.relpath(file, os.path.join(AP, "worlds", name)))
