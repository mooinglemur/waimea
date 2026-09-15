"""A minimal world that probes what network access generation has, then fails with the findings.

In a browser worker, Python can reach JavaScript through the `js` module, so an apworld can try
requests. generate_early makes blocking XMLHttpRequests to the worker's own origin (/healthz) and to
another origin (http://127.0.0.1:8236/, which the probe script listens on), then raises an exception
naming each outcome, so the result lands in the fuzz report's error key. Natively there's no `js` module.

It exists to check Waimea's worker Content Security Policy. It is not a real game.
"""
from dataclasses import dataclass

from BaseClasses import Item, ItemClassification, Location, Region
from Options import PerGameCommonOptions
from worlds.AutoWorld import World

GAME = "Waimea Net Probe"
CROSS_ORIGIN = "http://127.0.0.1:8236/probe"


class ProbeItem(Item):
    game = GAME


class ProbeLocation(Location):
    game = GAME


@dataclass
class ProbeOptions(PerGameCommonOptions):
    pass


def attempt(js, url):
    try:
        request = js.XMLHttpRequest.new()
        request.open("GET", url, False)
        request.send()
        return f"status {request.status}"
    except Exception as e:
        return f"blocked ({type(e).__name__}: {str(e).splitlines()[0][:80]})"


class NetProbeWorld(World):
    """Reports whether same-origin and cross-origin requests succeed, as a generation failure."""

    game = GAME
    options_dataclass = ProbeOptions
    topology_present = False
    item_name_to_id = {"Probe Token": 777_100_001}
    location_name_to_id = {"Probe Check": 777_100_001}

    def generate_early(self):
        try:
            import js
        except ImportError:
            raise Exception("netprobe: no js module (not running in a browser)")
        same = attempt(js, f"{js.location.origin}/healthz")
        cross = attempt(js, CROSS_ORIGIN)
        raise Exception(f"netprobe: same-origin {same}; cross-origin {cross}")

    def create_item(self, name):
        return ProbeItem(name, ItemClassification.progression, self.item_name_to_id[name], self.player)

    def create_regions(self):
        menu = Region("Menu", self.player, self.multiworld)
        menu.locations.append(ProbeLocation(self.player, "Probe Check", self.location_name_to_id["Probe Check"], menu))
        self.multiworld.regions.append(menu)

    def create_items(self):
        self.multiworld.itempool.append(self.create_item("Probe Token"))

    def set_rules(self):
        self.multiworld.completion_condition[self.player] = lambda state: True
