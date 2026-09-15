"""Measures Waimea's fuzz timeout calibration workload natively, as the reference for deploy/calibration.json.

Run it where the index CI fuzzes, inside its ap-checker image, so the reference reflects CI's runner:

    python measure_native.py --ap-root /ap/archipelago \
        --apworld /ap/supported_worlds/tunic-0.6.7.apworld --out calibration.json

Then copy the output's "reference" into deploy/calibration.json. Remeasure when the runner hardware, the
pinned Archipelago or fuzzer, or the workload changes.

It stages the apworld in worlds/ as run_fuzz.py does and writes each run's YAML as Waimea's
runtime/fuzz_worker.py does: seeded with "<yamlSeed>-<i>", then fuzz.generate_random_yaml. Generation
then runs in a fork pool of --jobs processes, as fuzz.py's is, with call_generate's seed pinned to
generationSeedBase + i, timing call_generate in its worker. Workload values must match those in
deploy/calibration.json.
"""
import argparse
import datetime
import json
import logging
import multiprocessing
import os
import platform
import random
import shutil
import statistics
import sys
import tempfile
import time
from argparse import Namespace
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO


def run_one(yamls_dir, generation_seed):
    import fuzz

    buf = StringIO()
    with redirect_stdout(buf), redirect_stderr(buf), tempfile.TemporaryDirectory(prefix="apfuzz") as output_path:
        fuzz.patched_init_logging("Fuzzer")
        fuzz.random.randint = lambda _a, _b: generation_seed
        started = time.perf_counter()
        try:
            fuzz.call_generate(yamls_dir, Namespace(skip_output=False), output_path)
            outcome = "success"
        except Exception as e:
            outcome = type(e).__name__
        seconds = time.perf_counter() - started
        fuzz.clear_abc_caches()
        root = logging.getLogger()
        for handler in root.handlers[:]:
            root.removeHandler(handler)
            handler.close()
    return outcome, seconds


def cpu_model():
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ap-root", required=True)
    parser.add_argument("--apworld", required=True, help="the workload world's .apworld")
    parser.add_argument("--world", default="tunic", help="its module name")
    parser.add_argument("--runs", type=int, default=40)
    parser.add_argument("--jobs", type=int, default=4, help="the index CI fuzzes with -j 4")
    parser.add_argument("--yaml-seed", default="waimea-calibration")
    parser.add_argument("--generation-seed-base", type=int, default=1000000)
    parser.add_argument("--label", default="", help="where this was measured, for the record")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    ap_root = os.path.abspath(args.ap_root)
    out_path = os.path.abspath(args.out)
    shutil.copy(args.apworld, os.path.join(ap_root, "worlds", f"{args.world}.apworld"))
    os.makedirs(os.path.join(ap_root, "Players"), exist_ok=True)
    os.chdir(ap_root)
    sys.path.insert(0, ap_root)
    sys.argv = [os.path.join(ap_root, "fuzz.py")]
    os.environ["SKIP_REQUIREMENTS_UPDATE"] = "1"

    import fuzz
    from settings import get_settings

    get_settings()
    tmp = tempfile.mkdtemp(prefix="apfuzz")
    yamls_dirs = []
    for i in range(args.runs):
        random.seed(f"{args.yaml_seed}-{i}")
        yamls_dir = tempfile.mkdtemp(prefix="apfuzz", dir=tmp)
        with open(os.path.join(yamls_dir, f"{i}-0.yaml"), "wb") as fd:
            fd.write(fuzz.generate_random_yaml(args.world, {}).encode("utf-8"))
        yamls_dirs.append(yamls_dir)

    multiprocessing.set_start_method("fork")
    with multiprocessing.Pool(processes=args.jobs, maxtasksperchild=None) as pool:
        pending = [pool.apply_async(run_one, (d, args.generation_seed_base + i)) for i, d in enumerate(yamls_dirs)]
        results = [p.get() for p in pending]
    shutil.rmtree(tmp, ignore_errors=True)

    successes = [seconds for outcome, seconds in results if outcome == "success"]
    version_file = os.path.join(ap_root, "version")
    report = {
        "workload": {
            "world": args.world,
            "supportedApworld": os.path.basename(args.apworld),
            "yamlSeed": args.yaml_seed,
            "generationSeedBase": args.generation_seed_base,
        },
        "reference": {
            "label": args.label,
            "measuredAt": datetime.date.today().isoformat(),
            "jobs": args.jobs,
            "python": sys.version.split()[0],
            "cpu": cpu_model(),
            "cpus": os.cpu_count(),
            "archipelagoCommit": open(version_file).read().strip() if os.path.exists(version_file) else None,
            "medianSeconds": round(statistics.median(successes), 4) if successes else None,
            "outcomes": [outcome for outcome, _ in results],
            "seconds": [round(seconds, 4) for _, seconds in results],
        },
    }
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(json.dumps({k: v for k, v in report["reference"].items() if k not in ("outcomes", "seconds")}))


if __name__ == "__main__":
    main()
