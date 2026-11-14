"""Synthetic mic input for the Bat Ears self-test (48 kHz, 16-bit mono, 12 s).

usage: python make_wav.py out.wav [basic|wave]

basic  20 kHz carrier + Doppler echoes: push (+60 Hz) at 4 s and 8 s, pull (-60 Hz) at 6 s and 10 s.
wave   push at 4 s, a wave (6 alternating +/-70 Hz strokes, 0.15 s each) from 6 s, pull at 9 s,
       and a burst of broadband noise at 10.5-11.5 s that should NOT trigger anything.
"""
import math
import random
import struct
import sys
import wave

SR = 48000
DUR = 12.0
F0 = 20000.0
SCENARIOS = {
    'basic': [(4.0, 0.4, +60.0), (6.0, 0.4, -60.0), (8.0, 0.4, +60.0), (10.0, 0.4, -60.0)],
    'wave': [(4.0, 0.4, +60.0)] + [(6.0 + i * 0.15, 0.15, 70.0 if i % 2 == 0 else -70.0) for i in range(6)] + [(9.0, 0.4, -60.0)],
}
NOISE_BURST = {'wave': (10.5, 11.5)}

out_path = sys.argv[1]
scenario = sys.argv[2] if len(sys.argv) > 2 else 'basic'
events = SCENARIOS[scenario]
burst = NOISE_BURST.get(scenario)
random.seed(1)
n = int(SR * DUR)
frames = bytearray()
carrier_phase = 0.0
echo_phase = 0.0
for i in range(n):
    t = i / SR
    carrier_phase += 2 * math.pi * F0 / SR
    sample = 0.3 * math.sin(carrier_phase)
    shift = 0.0
    env = 0.0
    for start, length, df in events:
        if start <= t < start + length:
            shift = df
            env = math.sin(math.pi * (t - start) / length) ** 2
    echo_phase += 2 * math.pi * (F0 + shift) / SR
    sample += 0.02 * env * math.sin(echo_phase)
    noise = 0.0005
    if burst and burst[0] <= t < burst[1]:
        noise = 0.004  # broadband: raises both sides of the carrier equally
    sample += random.gauss(0.0, noise)
    frames += struct.pack('<h', max(-32767, min(32767, int(sample * 32767))))

with wave.open(out_path, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(bytes(frames))
print('wrote', out_path, scenario, n, 'samples')
