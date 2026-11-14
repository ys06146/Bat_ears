"""Turn recorder CSVs (web/recorder.js) into one feature row per gesture candidate.

A candidate is a stretch where the echo rises above the baseline on either side (an "active segment").
Each one is labeled with the majority recording label inside it. Quiet windows from idle blocks
are added as 'idle' examples, so the classifier also learns "nothing happened".
Standard library only.
"""
import csv
import glob
import math
import os
import random
import statistics

ACT_DB = 4.0          # frame is active if max(dUp, dDown) exceeds this
# Durations are in ms and converted per session, because the browser records one row per screen
# refresh (60, 120, 144 Hz laptops all exist).
MERGE_GAP_MS = 100    # merge segments separated by gaps up to this long
MIN_LEN_MS = 50       # drop shorter segments
MAX_LEN_MS = 2500     # cap segment length
IDLE_WIN_MS = 300     # sampled idle window length
IDLE_PER_MIN = 40     # idle windows sampled per minute of idle recording
BANDS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']

FEATURES = [
    'dur_ms', 'up_max', 'down_max', 'up_mean', 'down_mean', 'asym_mean', 'asym_max', 'asym_min',
    'v_mean', 'v_max', 'v_min', 'v_sign_changes', 'peak_order', 'snr_mean',
] + [f'{b}_ex' for b in BANDS]


def _f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else 0.0
    except (TypeError, ValueError):
        return 0.0


def load_rows(paths):
    """Read recorder CSVs and group the rows by session, sorted by time."""
    sessions = {}
    for p in paths:
        with open(p, newline='', encoding='utf-8-sig') as f:
            for r in csv.DictReader(f):
                key = f"{os.path.basename(p)}::{r.get('session', '')}"
                sessions.setdefault(key, []).append(r)
    for rows in sessions.values():
        rows.sort(key=lambda r: _f(r['t_ms']))
    return sessions


def band_baseline(rows):
    """Per-band quiet level: the 20th percentile of each sub-band over the session."""
    base = {}
    for b in BANDS:
        vals = sorted(_f(r.get(b)) for r in rows)
        base[b] = vals[int(0.2 * (len(vals) - 1))] if vals else 0.0
    return base


def session_fps(rows):
    """Frames per second of one recording, from the median gap between rows (60 if unknown)."""
    t = [_f(r['t_ms']) for r in rows]
    gaps = sorted(b - a for a, b in zip(t, t[1:]) if b > a)
    return 1000.0 / gaps[len(gaps) // 2] if gaps else 60.0


def frames_for(ms, fps, at_least=1):
    return max(at_least, int(round(ms * fps / 1000.0)))


def segments(rows, fps=60.0):
    """Index ranges [i, j) of active stretches."""
    merge_gap, min_len, max_len = frames_for(MERGE_GAP_MS, fps), frames_for(MIN_LEN_MS, fps, 2), frames_for(MAX_LEN_MS, fps)
    act = [max(_f(r['dUp_db']), _f(r['dDown_db'])) > ACT_DB for r in rows]
    segs, i, n = [], 0, len(rows)
    while i < n:
        if not act[i]:
            i += 1
            continue
        j = i
        gap = 0
        while j < n and (act[j] or gap < merge_gap):
            gap = 0 if act[j] else gap + 1
            j += 1
        j -= gap
        if j - i >= min_len:
            segs.append((i, min(j, i + max_len)))
        i = j + 1
    return segs


def featurize(rows, base):
    up = [_f(r['dUp_db']) for r in rows]
    dn = [_f(r['dDown_db']) for r in rows]
    v = [_f(r['v_mps']) for r in rows]
    asym = [a - b for a, b in zip(up, dn)]
    t = [_f(r['t_ms']) for r in rows]
    sign_changes, prev = 0, 0
    for x in v:
        s = 1 if x > 0.05 else -1 if x < -0.05 else 0
        if s and prev and s != prev:
            sign_changes += 1
        if s:
            prev = s
    i_up = max(range(len(up)), key=up.__getitem__)
    i_dn = max(range(len(dn)), key=dn.__getitem__)
    span = max(1, len(rows) - 1)
    feats = {
        'dur_ms': t[-1] - t[0] if len(t) > 1 else 0.0,
        'up_max': max(up), 'down_max': max(dn),
        'up_mean': statistics.fmean(up), 'down_mean': statistics.fmean(dn),
        'asym_mean': statistics.fmean(asym), 'asym_max': max(asym), 'asym_min': min(asym),
        'v_mean': statistics.fmean(v), 'v_max': max(v), 'v_min': min(v),
        'v_sign_changes': float(sign_changes),
        'peak_order': (i_dn - i_up) / span,  # > 0: the up-shift peaked first (push, then the hand returns)
        'snr_mean': statistics.fmean(_f(r['snr_db']) for r in rows),
    }
    for b in BANDS:
        feats[f'{b}_ex'] = statistics.fmean(_f(r.get(b)) for r in rows) - base[b]
    return feats


def majority(labels):
    return max(set(labels), key=labels.count)


def build_dataset(paths, seed=0):
    """Return (X, y, groups, meta). meta holds the rule-based detector's call for each sample."""
    rng = random.Random(seed)
    X, y, groups, meta = [], [], [], []
    for key, rows in load_rows(paths).items():
        if len(rows) < 10:
            continue
        base = band_baseline(rows)
        fps = session_fps(rows)
        segs = segments(rows, fps)
        for (i, j) in segs:
            part = rows[i:j]
            lab = majority([r['label'] for r in part])
            if lab == 'skip':  # trial undone during guided collection
                continue
            feats = featurize(part, base)
            X.append([feats[k] for k in FEATURES])
            y.append(lab)
            groups.append(key)
            fired = [r['gesture'].replace('_sim', '') for r in part if r.get('gesture')]
            meta.append({'rule': fired[0] if fired else 'none', 'start_ms': _f(part[0]['t_ms'])})
        # quiet idle windows (outside any active segment)
        busy, pad, idle_win = set(), frames_for(100, fps), frames_for(IDLE_WIN_MS, fps, 3)
        for (i, j) in segs:
            busy.update(range(max(0, i - pad), j + pad))
        idle_idx = [k for k, r in enumerate(rows) if r['label'] == 'idle' and k not in busy]
        idle_set = set(idle_idx)
        n_win = int(len(idle_idx) / fps / 60 * IDLE_PER_MIN) + 1
        starts = [k for k in idle_idx if all((k + d) in idle_set for d in range(idle_win))]
        for k in rng.sample(starts, min(n_win, len(starts))):
            part = rows[k:k + idle_win]
            feats = featurize(part, base)
            X.append([feats[f] for f in FEATURES])
            y.append('idle')
            groups.append(key)
            meta.append({'rule': 'none', 'start_ms': _f(part[0]['t_ms'])})
    return X, y, groups, meta


def find_csvs(folder):
    return sorted(glob.glob(os.path.join(folder, '**', '*.csv'), recursive=True))
