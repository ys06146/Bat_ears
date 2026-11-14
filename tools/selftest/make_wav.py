"""Synthetic mic input for the Bat Ears self-test.

20 kHz carrier plus short Doppler-shifted echoes: push (+60 Hz) at 4 s and 8 s,
pull (-60 Hz) at 6 s and 10 s. 48 kHz, 16-bit mono, 12 s.
"""
import math
import random
import struct
import sys
import wave

SR = 48000
DUR = 12.0
F0 = 20000.0
EVENTS = [(4.0, +60.0), (6.0, -60.0), (8.0, +60.0), (10.0, -60.0)]
EVENT_LEN = 0.4

out_path = sys.argv[1]
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
    for start, df in EVENTS:
        if start <= t < start + EVENT_LEN:
            shift = df
            env = math.sin(math.pi * (t - start) / EVENT_LEN) ** 2
    echo_phase += 2 * math.pi * (F0 + shift) / SR
    sample += 0.02 * env * math.sin(echo_phase)
    sample += random.gauss(0.0, 0.0005)
    frames += struct.pack('<h', max(-32767, min(32767, int(sample * 32767))))

with wave.open(out_path, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(bytes(frames))
print('wrote', out_path, n, 'samples')
