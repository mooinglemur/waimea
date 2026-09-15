"""A minimal world that fails generation by recursing deeply through callable objects.

Calls through __call__ use the engine's stack under Pyodide rather than only Python's own frames, so the
same depth fails differently per runtime (see docs/spike-01-feasibility.md):
- native CPython raises RecursionError at the default limit of 1000;
- Firefox workers do the same;
- Chrome workers overflow the JavaScript stack at about 450 levels, a fatal interpreter error.

It exists to exercise Waimea's fatal-error handling. It is not a real game.
"""
from dataclasses import dataclass

from BaseClasses import Item, ItemClassification, Location, Region
from Options import PerGameCommonOptions
from worlds.AutoWorld import World

GAME = "Waimea Crash Test"
DEPTH = 5000


class CrashItem(Item):
    game = GAME


class CrashLocation(Location):
    game = GAME


@dataclass
class CrashOptions(PerGameCommonOptions):
    pass


class Nested:
    def __init__(self, inner):
        self.inner = inner

    def __call__(self):
        return self.inner() if self.inner else True


class CrashWorld(World):
    """Recurses DEPTH levels through __call__ before generating anything."""

    game = GAME
    options_dataclass = CrashOptions
    topology_present = False
    item_name_to_id = {"Crash Token": 777_000_001}
    location_name_to_id = {"Crash Check": 777_000_001}

    def generate_early(self):
        chain = None
        for _ in range(DEPTH):
            chain = Nested(chain)
        chain()

    def create_item(self, name):
        return CrashItem(name, ItemClassification.progression, self.item_name_to_id[name], self.player)

    def create_regions(self):
        menu = Region("Menu", self.player, self.multiworld)
        menu.locations.append(CrashLocation(self.player, "Crash Check", self.location_name_to_id["Crash Check"], menu))
        self.multiworld.regions.append(menu)

    def create_items(self):
        self.multiworld.itempool.append(self.create_item("Crash Token"))

    def set_rules(self):
        self.multiworld.completion_condition[self.player] = lambda state: True
