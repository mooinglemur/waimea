"""Stand-in for bsdiff4: worlds/Files.py imports it, but tests and generation never patch ROMs."""


def patch(*args, **kwargs):
    raise NotImplementedError("bsdiff4 is not available in the browser")


def diff(*args, **kwargs):
    raise NotImplementedError("bsdiff4 is not available in the browser")
