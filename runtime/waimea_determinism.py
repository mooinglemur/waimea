"""check-determinism for Pyodide: the pinned hooks/determinism.py with its subprocess replaced by a paired worker.

Natively, setup_worker starts a second Python process, and after_generate pickles the generation's args to it,
blocks until it regenerates the same seed, and compares the two serialized multiworlds. A Pyodide worker can't
start processes or block on another worker, so the orchestrator pairs each fuzz worker with a regenerating worker
(runtime/determinism_regenerator.py) and carries the request between them:

1. after_generate serializes the multiworld and keeps it;
2. fuzz_worker's generation pauses and hands regeneration_request() to the orchestrator;
3. the paired worker regenerates and serializes;
4. complete_regeneration() compares the two, as the native after_generate does after its recv_msg.

Serialization, comparison, the error messages and reclassify_outcome are the pinned hook's own.
"""
import base64
import pickle

from hooks import determinism


class Hook(determinism.Hook):
    def __init__(self):
        super().__init__()
        self._state1 = None

    def setup_worker(self, args):
        # The second interpreter is a separate worker, started by the orchestrator.
        pass

    def before_generate(self, args):
        super().before_generate(args)
        self._state1 = None

    def after_generate(self, mw, output_dir):
        if mw is None:
            return
        self._state1 = determinism.serialize_multiworld(mw)

    def regeneration_request(self):
        """What the native hook sends over its pipe, or None when there is nothing to regenerate."""
        if self._state1 is None:
            return None
        return {"args": base64.b64encode(pickle.dumps(self._args, protocol=pickle.HIGHEST_PROTOCOL)).decode("ascii")}

    def complete_regeneration(self, response):
        """The rest of the native after_generate, given the paired worker's response."""
        state1, self._state1 = self._state1, None
        if response["status"] == "error":
            self._determinism_error = determinism.DeterminismError(
                f"Subprocess generation failed:\n{response['text']}"
            )
            return

        result = pickle.loads(base64.b64decode(response["state"]))
        differences = determinism.compare_states(state1, result)
        del state1, result
        if differences:
            self._determinism_error = determinism.DeterminismError(
                "Non-deterministic generation:\n" + "\n".join(differences)
            )
