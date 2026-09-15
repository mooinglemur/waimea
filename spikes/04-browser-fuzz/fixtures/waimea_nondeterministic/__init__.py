"""A minimal world whose generation depends on string hash randomization.

It builds its item pool by iterating over a set of strings, whose order differs between interpreters with
different hash seeds. Two generations of the same seed in one interpreter agree; a second interpreter, as
check-determinism uses, usually doesn't.

It exists to exercise check-determinism. It is not a real game.
"""
from dataclasses import dataclass

from BaseClasses import Item, ItemClassification, Location, Region
from Options import PerGameCommonOptions
from worlds.AutoWorld import World

GAME = "Waimea Nondeterministic Test"
NAMES = [f"Token {letter}{n}" for letter in "ABCDEFGH" for n in range(1, 4)]
BASE_ID = 778_000_000


class TokenItem(Item):
    game = GAME


class TokenLocation(Location):
    game = GAME


@dataclass
class TokenOptions(PerGameCommonOptions):
    pass


class NondeterministicWorld(World):
    """Creates its items in set iteration order."""

    game = GAME
    options_dataclass = TokenOptions
    topology_present = False
    item_name_to_id = {name: BASE_ID + i for i, name in enumerate(NAMES)}
    location_name_to_id = {f"Check {name}": BASE_ID + i for i, name in enumerate(NAMES)}

    def create_item(self, name):
        return TokenItem(name, ItemClassification.filler, self.item_name_to_id[name], self.player)

    def create_regions(self):
        menu = Region("Menu", self.player, self.multiworld)
        for name, address in self.location_name_to_id.items():
            menu.locations.append(TokenLocation(self.player, name, address, menu))
        self.multiworld.regions.append(menu)

    def create_items(self):
        for name in set(NAMES):
            self.multiworld.itempool.append(self.create_item(name))

    def set_rules(self):
        self.multiworld.completion_condition[self.player] = lambda state: True
