"""FAR / FRR / EER for the 🔐 gesture key (web/key.html) from its attempt logs in ml/data (batears_auth_*.json).

Each attempt: owner (whose lock), performer, attack (genuine | zero-effort | imitation-watched | imitation-blind),
seq_ok (gesture order matched), style_score and threshold (rhythm / speed / length / shape distance), accepted.

Printed (markdown, with 95% Wilson intervals):
  per owner and overall: genuine attempts rejected (FRR, split into wrong order vs. style) and impostor attempts
  accepted (FAR) per attack type, plus how many impostors got the order right (what a sequence-only lock would let in)
  EER: sweep the threshold multiplier m (accept = order right and score <= m x threshold) until FAR = FRR

usage: python ml/auth_report.py [folder or json ...]   (default ml/data)
"""
import glob
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def wilson(k, n, z=1.96):
    if not n:
        return (float('nan'), float('nan'))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - r) / d), min(1.0, (c + r) / d))


def fmt(k, n):
    if not n:
        return '–'
    lo, hi = wilson(k, n)
    return f'{k}/{n} ({100 * k / n:.0f}%, 95% {100 * lo:.0f}–{100 * hi:.0f}%)'


def load(paths):
    seen, out = set(), []
    for p in paths:
        try:
            j = json.load(open(p, encoding='utf-8'))
        except (OSError, ValueError):
            continue
        for a in j.get('attempts') or []:
            key = (a.get('t'), a.get('owner'), a.get('performer'))
            if key in seen:  # the page re-saves the whole session after every attempt
                continue
            seen.add(key)
            out.append(a)
    return out


def ratio(a):
    s, t = a.get('style_score'), a.get('threshold')
    return s / t if a.get('seq_ok') and s is not None and t else float('inf')


def eer(att):
    gen = [ratio(a) for a in att if a.get('genuine')]
    imp = [ratio(a) for a in att if not a.get('genuine')]
    if not gen or not imp:
        return None
    best = None
    for i in range(1, 801):
        m = i / 100
        frr = sum(r > m for r in gen) / len(gen)
        far = sum(r <= m for r in imp) / len(imp)
        if best is None or abs(far - frr) < abs(best[1] - best[2]):
            best = (m, far, frr)
    return best


def table(att, title):
    gen = [a for a in att if a.get('genuine')]
    imp = [a for a in att if not a.get('genuine')]
    print(f'\n### {title}\n')
    print('| attempts | count | accepted | wrong order | style rejected |')
    print('|---|---|---|---|---|')
    print(f"| genuine (FRR = 1 - accepted) | {len(gen)} | {fmt(sum(a.get('accepted') for a in gen), len(gen))} "
          f"| {sum(not a.get('seq_ok') for a in gen)} | {sum(a.get('seq_ok') and not a.get('accepted') for a in gen)} |")
    for kind in ('zero-effort', 'imitation-watched', 'imitation-blind'):
        xs = [a for a in imp if a.get('attack') == kind]
        if xs:
            print(f"| impostor · {kind} (FAR = accepted) | {len(xs)} | {fmt(sum(a.get('accepted') for a in xs), len(xs))} "
                  f"| {sum(not a.get('seq_ok') for a in xs)} | {sum(a.get('seq_ok') and not a.get('accepted') for a in xs)} |")
    if imp:
        ok = sum(a.get('seq_ok') for a in imp)
        print(f"\nimpostors with the right order (what a sequence-only lock lets in): {fmt(ok, len(imp))}; "
              f"of those, the style check stopped {sum(a.get('seq_ok') and not a.get('accepted') for a in imp)}")
    e = eer(att)
    if e:
        print(f'EER ≈ {100 * (e[1] + e[2]) / 2:.0f}% at {e[0]:.2f} x threshold (FAR {100 * e[1]:.0f}%, FRR {100 * e[2]:.0f}%)')


def main():
    args = sys.argv[1:] or [os.path.join(HERE, 'data')]
    paths = []
    for a in args:
        paths += sorted(glob.glob(os.path.join(a, 'batears_auth_*.json'))) if os.path.isdir(a) else [a]
    att = load(paths)
    if not att:
        print('no gesture-key attempts found (web/key.html saves batears_auth_*.json)')
        return
    print(f'{len(att)} attempts from {len(paths)} files, owners: {sorted({a.get("owner") for a in att})}')
    if any(a.get('simulated') for a in att):
        print(f"note: {sum(bool(a.get('simulated')) for a in att)} attempts used keyboard-simulated gestures (no motion features)")
    table(att, 'all owners')
    for o in sorted({a.get('owner') for a in att}):
        table([a for a in att if a.get('owner') == o], f'lock: {o}')


if __name__ == '__main__':
    main()
