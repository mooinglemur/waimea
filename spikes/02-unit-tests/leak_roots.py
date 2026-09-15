"""Finds what keeps a leaked MultiWorld alive: referrers from outside the set of objects it reaches.

leak_probe.py's referrer walk only circles the multiworld's own region/entrance cycles. Here the
multiworld's reachable set is computed first, and any referrer of a member that isn't itself in the set
(and isn't this probe's frame) is a root. Call roots(apworld_path, apquest_path, game) after
waimea_boot.prepare().
"""
import gc
import json
import sys
import types
import weakref

from leak_probe import describe


def reachable(start, limit=2_000_000):
    seen = {id(start): start}
    stack = [start]
    while stack and len(seen) < limit:
        for ref in gc.get_referents(stack.pop()):
            # Modules, classes and functions lead everywhere; an external root is what matters here.
            if isinstance(ref, (types.ModuleType, type, types.FunctionType, types.BuiltinFunctionType)):
                continue
            if id(ref) not in seen:
                seen[id(ref)] = ref
                stack.append(ref)
    return seen


def roots(apworld_path, apquest_path, game):
    import unit_tests
    from test.general import setup_solo_multiworld
    from worlds.AutoWorld import AutoWorldRegister

    unit_tests.load_apworld(apworld_path)
    unit_tests.load_apworld(apquest_path)
    for name in list(AutoWorldRegister.world_types):
        if name not in ("Test Game", "APQuest", "Archipelago", game):
            del AutoWorldRegister.world_types[name]

    weak = weakref.ref(setup_solo_multiworld(AutoWorldRegister.world_types[game]))
    for _ in range(4):
        gc.collect()
    if weak() is None:
        return json.dumps({"alive": False})

    members = reachable(weak())
    values = list(members.values())
    here = {id(sys._getframe()), id(members), id(values)}
    shared = (type(None), bool, int, float, str, bytes, type, frozenset, tuple)
    found = {}
    for member in values:
        # Anything can refer to a shared immutable object; only mutable members locate a real holder.
        if isinstance(member, shared):
            continue
        for referrer in gc.get_referrers(member):
            if id(referrer) in members or id(referrer) in here or isinstance(referrer, types.FrameType):
                continue
            key = describe(referrer)
            entry = found.setdefault(key, {"count": 0, "holds": set(), "sample": None})
            entry["count"] += 1
            entry["holds"].add(describe(member))
            if entry["sample"] is None:
                try:
                    entry["sample"] = repr(referrer)[:300]
                except Exception as e:
                    entry["sample"] = f"<repr failed: {e!r}>"
    report = sorted(
        ({"referrer": k, "count": v["count"], "holds": sorted(v["holds"])[:8], "sample": v["sample"]} for k, v in found.items()),
        key=lambda r: -r["count"],
    )
    return json.dumps({"alive": True, "members": len(members), "roots": report[:40]}, indent=1)
