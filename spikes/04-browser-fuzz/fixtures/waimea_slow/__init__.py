"""A minimal world that spins in generate_early for longer than any fuzz timeout.

Every generation reaches the limit, so the variant ends with timeouts and no failures. It exercises timeout
handling: the worker is terminated, a replacement asks the main-process hooks to reclassify, and the page
marks the variant as a warning rather than a pass.

It isn't a real game. The spin is a busy loop, not sleep, so it burns a worker's time the way a slow world does.
"""
import time
from dataclasses import dataclass

from BaseClasses import Item, ItemClassification, Location, Region
from Options import PerGameCommonOptions
from worlds.AutoWorld import World

GAME = "Waimea Slow Test"
SECONDS = 600


class SlowItem(Item):
    game = GAME


class SlowLocation(Location):
    game = GAME


@dataclass
class SlowOptions(PerGameCommonOptions):
    pass


class SlowWorld(World):
    """Spins for SECONDS before generating anything."""

    game = GAME
    options_dataclass = SlowOptions
    topology_present = False
    item_name_to_id = {"Slow Token": 779_000_001}
    location_name_to_id = {"Slow Check": 779_000_001}

    def generate_early(self):
        deadline = time.perf_counter() + SECONDS
        while time.perf_counter() < deadline:
            pass

    def create_item(self, name):
        return SlowItem(name, ItemClassification.progression, self.item_name_to_id[name], self.player)

    def create_regions(self):
        menu = Region("Menu", self.player, self.multiworld)
        menu.locations.append(SlowLocation(self.player, "Slow Check", self.location_name_to_id["Slow Check"], menu))
        self.multiworld.regions.append(menu)

    def create_items(self):
        self.multiworld.itempool.append(self.create_item("Slow Token"))

    def set_rules(self):
        self.multiworld.completion_condition[self.player] = lambda state: True
