"""Generate fake recorder CSVs (same columns as web/recorder.js) to test the ML pipeline without real data.

Each session holds 30 s blocks of idle, push, pull, wave, other. Push/pull are short one-sided bumps
followed by a smaller rebound on the other side (the hand returning). Wave alternates sides quickly.
Other (typing, body motion) is short two-sided spikes with no clear direction.

usage: python make_fake_data.py [out_dir] [n_sessions]
"""
import csv
import math
import os
import random
import sys

FPS = 60
BLOCK_S = 30
LABELS = ['idle', 'push', 'pull', 'wave', 'other']
F0, C = 20000.0, 343.0
SUB_EDGES = [25, 50, 80, 120, 170, 230, 300]
HEAD = ['session', 't_ms', 'label', 'gesture', 'dUp_db', 'dDown_db', 'up_db', 'down_db', 'v_mps', 'snr_db',
        'carrier_db', 'noise_db', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']


def hann(x):
    return math.sin(math.pi * x) ** 2 if 0 <= x <= 1 else 0.0


def events_for(label, rng, start, dur):
    """Return a list of (t0, length_s, kind, amp_db, speed) bumps inside a block."""
    ev, t = [], start + 1.0
    end = start + dur - 1.0
    while t < end:
        if label in ('push', 'pull'):
            amp, speed, length = rng.uniform(10, 24), rng.uniform(0.3, 1.1), rng.uniform(0.25, 0.4)
            ev.append((t, length, label, amp, speed))
            ev.append((t + length * 0.9, length * 0.8, 'pull' if label == 'push' else 'push', amp * rng.uniform(0.25, 0.45), speed * 0.5))
            t += rng.uniform(1.3, 2.0)
        elif label == 'wave':
            n = rng.randint(4, 7)
            for i in range(n):
                ev.append((t + i * 0.16, 0.16, 'push' if i % 2 == 0 else 'pull', rng.uniform(8, 15), rng.uniform(0.4, 0.9)))
            t += n * 0.16 + rng.uniform(0.8, 1.4)
        elif label == 'other':
            ev.append((t, rng.uniform(0.05, 0.12), 'both', rng.uniform(4, 9), rng.uniform(0.05, 0.3)))
            t += rng.uniform(0.15, 0.6)
        else:  # idle: rare tiny bumps
            if rng.random() < 0.15:
                ev.append((t, 0.1, 'both', rng.uniform(2, 4), 0.05))
            t += rng.uniform(1.5, 3.0)
    return ev


def band_of(speed):
    hz = 2 * speed * F0 / C
    for b in range(len(SUB_EDGES) - 1):
        if hz < SUB_EDGES[b + 1]:
            return b
    return len(SUB_EDGES) - 2


def make_session(path, seed, name):
    rng = random.Random(seed)
    base_up, base_dn = rng.uniform(-62, -55), rng.uniform(-62, -55)
    base_bands = [rng.uniform(-80, -60) for _ in range(12)]
    blocks = []
    for i, lab in enumerate(LABELS):
        blocks.append((lab, i * BLOCK_S, events_for(lab, rng, i * BLOCK_S, BLOCK_S)))
    last_fire, cand, cand_n = -10.0, None, 0
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(HEAD)
        n = len(LABELS) * BLOCK_S * FPS
        for i in range(n):
            t = i / FPS
            lab, _, evs = blocks[min(len(blocks) - 1, int(t // BLOCK_S))]
            up, dn, v = rng.gauss(0, 1.2), rng.gauss(0, 1.2), rng.gauss(0, 0.03)
            bu = [x + rng.gauss(0, 1.5) for x in base_bands[:6]]
            bd = [x + rng.gauss(0, 1.5) for x in base_bands[6:]]
            for (t0, length, kind, amp, speed) in evs:
                e = hann((t - t0) / length)
                if e <= 0:
                    continue
                b = band_of(speed)
                if kind in ('push', 'both'):
                    up += amp * e
                    bu[b] += amp * e
                    v += speed * e if kind == 'push' else 0
                if kind in ('pull', 'both'):
                    dn += amp * e
                    bd[b] += amp * e
                    v -= speed * e if kind == 'pull' else 0
            # imitate the browser's rule-based detector (threshold 6 dB, margin 3 dB, 2 frames, 450 ms)
            c = 'push' if up > 6 and up - dn > 3 else 'pull' if dn > 6 and dn - up > 3 else None
            cand_n = cand_n + 1 if c and c == cand else (1 if c else 0)
            cand = c
            gesture = ''
            if c and cand_n >= 2 and t - last_fire > 0.45:
                gesture, last_fire = c, t
            snr = 93 + rng.gauss(0, 1.5)
            w.writerow([name, f'{t * 1000:.1f}', lab, gesture, f'{up:.2f}', f'{dn:.2f}', f'{base_up + up:.2f}',
                        f'{base_dn + dn:.2f}', f'{v:.3f}', f'{snr:.1f}', '-31.7', f'{-31.7 - snr:.1f}',
                        *[f'{x:.2f}' for x in bu], *[f'{x:.2f}' for x in bd]])


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'fake')
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    os.makedirs(out, exist_ok=True)
    for s in range(n):
        name = f'fake{s + 1}'
        path = os.path.join(out, f'batears_{name}.csv')
        make_session(path, seed=100 + s, name=name)
        print('wrote', path)


if __name__ == '__main__':
    main()
