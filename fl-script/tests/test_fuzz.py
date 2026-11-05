"""Random frames and callbacks through the FL script, with fixed seeds so a failure repeats.

The script's rules (docs/sysex.md): nothing escapes a callback, at most 8 frames per callback, and every frame
is valid. This runs on the fake FL in test_bridge, so it says nothing about how FL really behaves.
"""

import contextlib
import io
import random

import test_bridge

RUNS = 6
STEPS = 200
MAX_FRAMES_PER_CALLBACK = 8

FRAMES = [
    list(bytes.fromhex(vector["hex"]))
    for vector in test_bridge.load_vectors()
    if vector["direction"] == "toFl"
]


class ScriptFuzzTests(test_bridge.BridgeTestCase):
    def act(self, rnd):
        """One random thing happens. Any exception here has escaped the script."""
        script = self.script
        roll = rnd.random()
        if roll < 0.45:
            frame = list(rnd.choice(FRAMES))
            for _ in range(rnd.randint(0, 3)):
                at = rnd.randint(5, max(5, len(frame) - 2))
                if at < len(frame) - 1:
                    frame[at] = rnd.choice([0, 1, 2, 63, 64, 126, 127, rnd.randint(0, 127)])
            if rnd.random() < 0.08 and len(frame) > 6:
                frame = frame[: rnd.randint(5, len(frame) - 1)] + [0xF7]
            self.send(bytes(frame))
        elif roll < 0.8:
            self.clock.advance(rnd.choice([0.001, 0.01, 0.06, 0.11, 0.5, 1.2]))
            script.OnIdle()
        elif roll < 0.86:
            script.OnRefresh(rnd.getrandbits(20))
        elif roll < 0.89:
            script.OnDirtyChannel(rnd.randint(-1, 40), rnd.randint(0, 4))
        elif roll < 0.92:
            script.OnDirtyMixerTrack(rnd.randint(-1, 20))
        elif roll < 0.93:
            script.OnDoFullRefresh()
        elif roll < 0.94:
            script.OnProjectLoad(rnd.randint(0, 100))
        elif roll < 0.96:
            script.OnUpdateBeatIndicator(rnd.randint(0, 2))
        elif roll < 0.98:
            script.OnUpdateLiveMode()
        else:
            script.OnUpdateMeters()

    def test_nothing_escapes_and_no_callback_sends_a_burst(self):
        for seed in range(RUNS):
            self.fl.sysex_out[:] = []
            rnd = random.Random(seed)
            # The script logs what FL refuses: that is its job, not a failure here.
            with contextlib.redirect_stdout(io.StringIO()):
                self.start()
                for step in range(STEPS):
                    before = len(self.fl.sysex_out)
                    self.act(rnd)
                    sent = self.fl.sysex_out[before:]
                    where = "seed %d, step %d" % (seed, step)
                    self.assertLessEqual(len(sent), MAX_FRAMES_PER_CALLBACK, where)
                    for frame in sent:
                        data = list(frame)
                        self.assertEqual(data[0], 0xF0, where)
                        self.assertEqual(data[-1], 0xF7, where)
                        self.assertTrue(all(byte <= 127 for byte in data[1:-1]), where)

    def test_garbage_does_not_get_past_the_decoder(self):
        rnd = random.Random(7)
        for _ in range(5000):
            body = [rnd.randint(0, 127) for _ in range(rnd.randint(0, 40))]
            end = [0xF7] if rnd.random() < 0.9 else []
            self.script.decode(bytes([0xF0, 0x7D, 0x4D, 0x33, rnd.randint(0, 127)] + body + end))
