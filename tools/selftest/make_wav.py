"""Synthetic mic input for the Bat Ears self-test (48 kHz, 16-bit mono, 12 s).

usage: python make_wav.py out.wav [basic|wave|stereo]

basic   20 kHz carrier + Doppler echoes: push (+170 Hz) at 4 s and 8 s, pull (-170 Hz) at 6 s and 10 s.
wave    push at 4 s, a wave (6 alternating +/-170 Hz strokes, 0.15 s each) from 6 s, pull at 9 s,
        and a burst of broadband noise at 10.5-11.5 s that should NOT trigger anything.
stereo  two carriers as heard by the mic in stereo mode (19 kHz from the left speaker, 20.5 kHz from
        the right): push at 3 s (both up), swipe right at 5 s (left down, right up),
        swipe left at 7 s (left up, right down), pull at 9 s (both down).
"""
import math
import random
import struct
import sys
import wave

SR = 48000
DUR = 12.0
# scenario: carriers (Hz) and events (start s, length s, Doppler shift per carrier in Hz)
# Shifts of +/-170 Hz at 20 kHz = 1.46 m/s, a typical real push/pull peak (real recordings: 1.1-2.1 m/s).
SCENARIOS = {
    'basic': ([20000.0], [(4.0, 0.4, (170,)), (6.0, 0.4, (-170,)), (8.0, 0.4, (170,)), (10.0, 0.4, (-170,))]),
    'wave': ([20000.0], [(4.0, 0.4, (170,))] + [(6.0 + i * 0.15, 0.15, (170 if i % 2 == 0 else -170,)) for i in range(6)]
             + [(9.0, 0.4, (-170,))]),
    'stereo': ([19000.0, 20500.0], [(3.0, 0.4, (60, 60)), (5.0, 0.4, (-60, 60)), (7.0, 0.4, (60, -60)), (9.0, 0.4, (-60, -60))]),
}
NOISE_BURST = {'wave': (10.5, 11.5)}

out_path = sys.argv[1]
scenario = sys.argv[2] if len(sys.argv) > 2 else 'basic'
carriers, events = SCENARIOS[scenario]
burst = NOISE_BURST.get(scenario)
amp = 0.3 / len(carriers)
random.seed(1)
n = int(SR * DUR)
frames = bytearray()
car_phase = [0.0] * len(carriers)
echo_phase = [0.0] * len(carriers)
for i in range(n):
    t = i / SR
    sample = 0.0
    for c, f0 in enumerate(carriers):
        car_phase[c] += 2 * math.pi * f0 / SR
        sample += amp * math.sin(car_phase[c])
        shift, env = 0.0, 0.0
        for start, length, shifts in events:
            if start <= t < start + length:
                shift = shifts[c]
                env = math.sin(math.pi * (t - start) / length) ** 2
        echo_phase[c] += 2 * math.pi * (f0 + shift) / SR
        sample += amp * 0.067 * env * math.sin(echo_phase[c])
    noise = 0.004 if burst and burst[0] <= t < burst[1] else 0.0005
    sample += random.gauss(0.0, noise)
    frames += struct.pack('<h', max(-32767, min(32767, int(sample * 32767))))

with wave.open(out_path, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(bytes(frames))
print('wrote', out_path, scenario, n, 'samples')
