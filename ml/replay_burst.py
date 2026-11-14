"""Replay recorder CSVs through a "burst" detector offline and score it against the guided-collection cues.

Real recordings showed that a gesture is a burst with a small counter-move (wind-up before a pull, return
after a push). The intended direction is the sign of the LARGEST hand speed in the burst, not whichever
side crosses a threshold first. This script tests that rule (and parameter variants) without hardware.

usage: python replay_burst.py [csv or folder ...]   (default: ml/data, fake data excluded)
"""
import csv
import glob
import itertools
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load(path):
    rows = list(csv.DictReader(open(path, newline='', encoding='utf-8-sig')))
    f = lambda x: float(x) if x not in ('', None) else 0.0
    return [{'t': f(r['t_ms']), 'up': f(r['dUp_db']), 'dn': f(r['dDown_db']), 'v': f(r['v_mps']), 'noise': f(r['noise_db']),
             'label': r['label'], 'cue': r.get('cue', ''), 'g': r.get('gesture', '')} for r in rows]


def impulse_vetoes(fr, window_ms=4000, rise_db=6.0, k=3.0, hold_ms=250):
    """Approximation of robust.js's impulse veto: far-band noise jumping above its rolling median."""
    out, hist, veto_until = [], [], -1e9
    for x in fr:
        t = x['t']
        hist = [(ht, hn) for (ht, hn) in hist if ht >= t - window_ms]
        if len(hist) >= 20:
            ns = sorted(hn for _, hn in hist)
            med = ns[len(ns) // 2]
            mad = sorted(abs(n - med) for n in ns)[len(ns) // 2] * 1.4826
            if x['noise'] - med > max(rise_db, k * max(0.4, mad)):
                veto_until = t + hold_ms
        hist.append((t, x['noise']))
        out.append(t < veto_until)
    return out


def burst_detect(fr, a_on=12.0, v_fire=1.3, v_min=0.9, gap_ms=120, max_ms=900, wave_flips=3, lock_ms=150):
    """Return [(t, kind)] fired by the burst rule."""
    out, ev, lock_until = [], None, -1e9
    vetoed = impulse_vetoes(fr)
    for x, vet in zip(fr, vetoed):
        t, active = x['t'], max(x['up'], x['dn']) > a_on
        if vet:
            if ev is not None:
                ev, lock_until = None, t + lock_ms
            continue
        if ev is None:
            if active and t >= lock_until:
                ev = {'start': t, 'last': t, 'vmax': x['v'], 'vmin': x['v'], 'fired': False, 'waved': False, 'flips': 0, 'sign': 0}
            else:
                continue
        if active:
            ev['last'] = t
        ev['vmax'], ev['vmin'] = max(ev['vmax'], x['v']), min(ev['vmin'], x['v'])
        s = 1 if x['v'] > v_min else -1 if x['v'] < -v_min else 0
        if s and ev['sign'] and s != ev['sign']:
            ev['flips'] += 1
        if s:
            ev['sign'] = s
        # a wave may still follow an early push/pull in the same burst (game: push, then shockwave)
        if not ev['waved'] and ev['flips'] >= wave_flips:
            out.append((t, 'wave')); ev['waved'] = ev['fired'] = True
        elif not ev['fired']:
            if x['v'] > v_fire:
                out.append((t, 'push')); ev['fired'] = True
            elif x['v'] < -v_fire:
                out.append((t, 'pull')); ev['fired'] = True
        cap = 3000 if ev['flips'] >= 2 else max_ms  # a wave keeps going; don't chop it into extra pushes/pulls
        ended = (t - ev['last'] > gap_ms) or (t - ev['start'] > cap)
        if ended:
            if not ev['fired'] and max(ev['vmax'], -ev['vmin']) >= v_min:
                out.append((t, 'push' if ev['vmax'] >= -ev['vmin'] else 'pull'))
            ev, lock_until = None, t + lock_ms
    return out


def score(fr, fired, window_ms=1500):
    cues = [(x['t'], x['cue']) for x in fr if x['cue'] in ('push', 'pull')]
    hit = wrong = 0
    for ct, kind in cues:
        got = [k for (t, k) in fired if ct <= t <= ct + window_ms]
        if got and got[0] == kind:
            hit += 1
        elif got:
            wrong += 1
    # false triggers while typing / moving ('other') and in the quiet idle blocks at the very start and end
    first_gesture_t = next((x['t'] for x in fr if x['label'] != 'idle'), None)
    last_gesture_t = max((x['t'] for x in fr if x['label'] != 'idle'), default=None)
    def quiet(t, label):
        return label == 'other' or (label == 'idle' and first_gesture_t is not None and (t < first_gesture_t or t > last_gesture_t + 2000))
    lab_at = {x['t']: x['label'] for x in fr}
    fp = sum(1 for (t, k) in fired if quiet(t, lab_at.get(t, '')))
    quiet_s = sum(1 for x in fr if quiet(x['t'], x['label'])) / 60.0
    return {'cues': len(cues), 'hit': hit, 'wrong': wrong, 'fp': fp, 'quiet_min': quiet_s / 60.0}


def main():
    args = sys.argv[1:] or [os.path.join(HERE, 'data')]
    paths = []
    for a in args:
        paths += sorted(glob.glob(os.path.join(a, '*.csv'))) if os.path.isdir(a) else [a]
    paths = [p for p in paths if os.sep + 'fake' not in p]
    sessions = [(os.path.basename(p), load(p)) for p in paths]
    sessions = [(n, fr) for n, fr in sessions if any(x['cue'] for x in fr)]
    if not sessions:
        print('no guided-collection CSVs with cues found')
        return
    print('files:', ', '.join(n for n, _ in sessions))

    def total(det):
        acc = {'cues': 0, 'hit': 0, 'wrong': 0, 'fp': 0, 'quiet_min': 0.0}
        for _, fr in sessions:
            s = score(fr, det(fr))
            for k in acc:
                acc[k] += s[k]
        return acc

    def show(name, a):
        print(f"{name:42s} hit {a['hit']:3d}/{a['cues']:<3d} = {a['hit'] / max(1, a['cues']):4.0%}  wrong {a['wrong']:2d}"
              f"  false {a['fp']:2d} in {a['quiet_min']:.1f} min = {a['fp'] / max(1e-9, a['quiet_min']):4.1f}/min")

    show('browser (as recorded)', total(lambda fr: [(x['t'], x['g'].replace('_sim', '')) for x in fr if x['g'] in ('push', 'pull', 'wave')]))
    show('burst default', total(lambda fr: burst_detect(fr)))
    grid = itertools.product([8, 10, 12], [1.1, 1.3, 1.6, 99], [0.5, 0.7, 0.9])
    results = []
    for a_on, v_fire, v_min in grid:
        a = total(lambda fr: burst_detect(fr, a_on=a_on, v_fire=v_fire, v_min=v_min))
        results.append((a['hit'] - a['wrong'] - 0.5 * a['fp'], a_on, v_fire, v_min, a))
    results.sort(key=lambda r: -r[0])
    print('\nbest variants (score = hit - wrong - 0.5 x false):')
    for sc, a_on, v_fire, v_min, a in results[:6]:
        show(f'  a_on {a_on} v_fire {v_fire if v_fire < 99 else "off"} v_min {v_min}', a)


if __name__ == '__main__':
    main()
