"""Fills a data folder for the browser fuzz spike: zips fixtures/<world>/ into <world>.apworld files.

Usage: python make_data.py <data dir>
core.zip and any real apworlds are copied in separately.
"""
import os
import sys
import zipfile

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

data_dir = sys.argv[1]
os.makedirs(data_dir, exist_ok=True)
for world in sorted(os.listdir(FIXTURES)):
    folder = os.path.join(FIXTURES, world)
    if not os.path.isdir(folder):
        continue
    with zipfile.ZipFile(os.path.join(data_dir, f"{world}.apworld"), "w", zipfile.ZIP_DEFLATED) as z:
        for directory, dirs, files in os.walk(folder):
            dirs[:] = sorted(d for d in dirs if d != "__pycache__")
            for name in sorted(files):
                path = os.path.join(directory, name)
                z.write(path, os.path.join(world, os.path.relpath(path, folder)))
    print(f"{world}.apworld")
