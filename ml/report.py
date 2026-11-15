"""Per-session accuracy table for the guided-collection sessions in ml/data (markdown, printed to the terminal).

Push/pull rows: prompts hit by the browser as recorded (live) and by the current burst rule replayed offline
(replay_burst.py), wrong direction, missed, and false triggers per minute while typing / idle at the ends.
Left/right check sessions (_lr) show the swipe.js v2 check from the session JSON instead.

usage: python ml/report.py [folder]          (default ml/data; copy the table into docs/devpost.md or experiments/)
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import replay_burst as rb  # noqa: E402


def meta_of(csv_path):
    j = csv_path[:-4] + '.json'
    if not os.path.exists(j):
        return {}
    try:
        return json.load(open(j, encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def pct(a, b):
    return f'{100 * a / b:.0f}%' if b else '–'


# Sessions we know were spoiled, with the reason (kept in the table, left out of the 'all but spoiled' total)
SPOILED = {'20261114_164412': 'spoiled: a second laptop was running Bat Ears (suspected)'}


# ---- left/right: a mirror of web/swipe.js v2 (fit, classify, the leave-one-out check) ----
KEYS = ('ilat', 'balDelta')


def _ok(x):
    return isinstance(x, (int, float)) and x == x and abs(x) != float('inf')


def lr_feats(meta):
    """[(kind, feat)] for trials that carry swipe features; balDelta = balSlope x ms for v1 files."""
    out = []
    for t in meta.get('trials') or []:
        f = dict(t.get('swipe') or {})
        if not f:
            continue
        if not _ok(f.get('balDelta')) and _ok(f.get('balSlope')) and _ok(f.get('ms')):
            f['balDelta'] = f['balSlope'] * f['ms'] / 1000
        out.append((t.get('kind'), f))
    return out


def lr_fit(L, R):
    m = {}
    for k in KEYS:
        a = [x[k] for x in L if _ok(x.get(k))]
        b = [x[k] for x in R if _ok(x.get(k))]
        if not a or not b:
            continue
        ma, mb = sum(a) / len(a), sum(b) / len(b)
        var = sum((x - ma) ** 2 for x in a) + sum((x - mb) ** 2 for x in b)
        sd = max(1e-6, (var / max(1, len(a) + len(b) - 2)) ** 0.5)
        m[k] = {'mid': (ma + mb) / 2, 'half': (mb - ma) / 2, 'sd': sd, 'd': (mb - ma) / sd}
    return m


def lr_classify(f, m, z_min=0.6, min_ms=350):
    s = d2 = 0.0
    for k in KEYS:
        p = m.get(k)
        if not p or abs(p['d']) < 1 or not _ok(f.get(k)):
            continue
        sign = (p['half'] > 0) - (p['half'] < 0)
        s += abs(p['d']) * sign * (f[k] - p['mid']) / p['sd']
        d2 += p['d'] ** 2
    if not d2 or not (f.get('ms', 0) >= min_ms):
        return None
    z = s / (d2 / 2)
    return 'right' if z >= z_min else 'left' if z <= -z_min else None


def lr_score(test, model):
    """swipes: hit / reversed / undecided; push/pull: how many the model would call left or right."""
    r = {'n': 0, 'hit': 0, 'wrong': 0, 'pp': 0, 'pp_fp': 0}
    for kind, f in test:
        d = lr_classify(f, model)
        if kind in ('left', 'right'):
            r['n'] += 1
            r['hit'] += d == kind
            r['wrong'] += bool(d) and d != kind
        else:
            r['pp'] += 1
            r['pp_fp'] += bool(d)
    return r


def lr_fit_all(feats):
    return lr_fit([f for k, f in feats if k == 'left'], [f for k, f in feats if k == 'right'])


def lr_loo(feats):
    """The in-session check, scored like LRCheck: leave-one-out for swipes, push/pull against the full model."""
    sw = [(k, f) for k, f in feats if k in ('left', 'right')]
    hit = wrong = n = 0
    for i, (kind, f) in enumerate(sw):
        rest = [x for j, x in enumerate(sw) if j != i]
        if not any(k == 'left' for k, _ in rest) or not any(k == 'right' for k, _ in rest):
            continue
        n += 1
        d = lr_classify(f, lr_fit_all(rest))
        hit += d == kind
        wrong += bool(d) and d != kind
    full = lr_score(feats, lr_fit_all(sw))
    return {'n': n, 'hit': hit, 'wrong': wrong, 'pp': full['pp'], 'pp_fp': full['pp_fp']}


def lr_row(name, dev, dist, m, feats, seen):
    """One table row; 'unseen data' = the model fitted on earlier sessions of the same device and tones."""
    pair = tuple(m.get('stereoPair') or ())
    tones = '/'.join(f'{f / 1000:g}' for f in pair) + 'k' if pair else '–'
    nl = sum(k == 'left' for k, _ in feats)
    nr = sum(k == 'right' for k, _ in feats)
    c = lr_loo(feats)
    ok = bool(c['n']) and c['hit'] / c['n'] >= 0.6 and c['wrong'] / c['n'] <= 0.1 and (not c['pp'] or c['pp_fp'] / c['pp'] <= 0.15)
    prev = [f for key, fs in seen if key == (dev, pair) for f in fs]
    unseen = '–'
    if prev:
        u = lr_score(feats, lr_fit_all(prev))
        unseen = f"{u['hit']}/{u['n']} ({pct(u['hit'], u['n'])}), {u['wrong']} reversed"
        if u['pp']:
            unseen += f", push/pull {u['pp_fp']}/{u['pp']}"
    seen.append(((dev, pair), feats))
    pp = f"{c['pp_fp']}/{c['pp']}" if c['pp'] else '–'
    return (f"| {name[:15]} | {dev} | {dist} | {tones} | {nl}+{nr} | {c['hit']}/{c['n']} ({pct(c['hit'], c['n'])}) "
            f"| {c['wrong']} | {c['n'] - c['hit'] - c['wrong']} | {pp} | {unseen} | {'✅' if ok else '❌'} |")


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'data')
    paths = [p for p in sorted(glob.glob(os.path.join(folder, '*.csv'))) if os.sep + 'fake' not in p]
    rows = []
    zero = lambda: {'cues': 0, 'live': 0, 'live_n': 0, 'hit': 0, 'wrong': 0, 'fp': 0, 'quiet_min': 0.0}
    tot, clean = zero(), zero()
    lr_rows, lr_seen = [], []
    for p in paths:
        name = os.path.basename(p)[len('batears_'):-4]
        m = meta_of(p)
        fr = rb.load(p)
        cues = [x for x in fr if x['cue'] in ('push', 'pull')]
        dev = m.get('device') or '(old)'  # sessions before the metadata JSON existed
        dm = re.search(r'_d(\d+)_', '_' + name + '_')
        dist = m.get('dist') or (dm.group(1) if dm else '')
        feats = lr_feats(m)
        if feats:
            lr_rows.append(lr_row(name, dev, dist, m, feats, lr_seen))
        if m.get('swipeOnly') or '_lr_' in name:
            continue
        if len(cues) < 5:
            continue  # aborted / test runs
        s = rb.score(fr, rb.burst_detect(fr))
        live = m.get('live') or {}
        bg = live.get('byGesture') or {}
        if bg.get('push') or bg.get('pull'):  # push/pull only: sessions with swipes count those in live.hits too
            lh = sum((bg.get(k) or {}).get('hit', 0) for k in ('push', 'pull'))
            ln = sum((bg.get(k) or {}).get('n', 0) for k in ('push', 'pull'))
        else:
            lh, ln = live.get('hits'), live.get('trials')
        miss = s['cues'] - s['hit'] - s['wrong']
        fpm = s['fp'] / s['quiet_min'] if s['quiet_min'] > 0 else 0.0
        note = []
        if m.get('foreignTones'):
            note.append('other ultrasound ' + ','.join(map(str, m['foreignTones'])) + ' kHz')
        if m.get('stereo'):
            note.append('stereo')
        if name[:15] in SPOILED:
            note.append(SPOILED[name[:15]])
        rows.append(f"| {name[:15]} | {dev} | {dist} | {s['cues']} | {f'{lh}/{ln}' if lh is not None else '–'} "
                    f"| {s['hit']}/{s['cues']} ({pct(s['hit'], s['cues'])}) | {s['wrong']} | {miss} | {fpm:.1f} | {'; '.join(note)} |")
        for t in (tot, clean) if name[:15] not in SPOILED else (tot,):
            for k, v in (('cues', s['cues']), ('hit', s['hit']), ('wrong', s['wrong']), ('fp', s['fp']), ('quiet_min', s['quiet_min'])):
                t[k] += v
            if lh is not None and ln:
                t['live'] += lh
                t['live_n'] += ln
    print('### Push / pull (guided prompts, burst rule)\n')
    print('| session | device | cm | prompts | live hit | replay hit | wrong | missed | false/min | note |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        print(r)
    for label, t in (('all', tot), ('all but spoiled', clean)):
        fpm = t['fp'] / t['quiet_min'] if t['quiet_min'] > 0 else 0.0
        print(f"| **{label}** | | | {t['cues']} | {t['live']}/{t['live_n']} | **{t['hit']}/{t['cues']} ({pct(t['hit'], t['cues'])})** "
              f"| {t['wrong']} | {t['cues'] - t['hit'] - t['wrong']} | {fpm:.1f} | |")
    if lr_rows:
        print('\n### Left / right (web/swipe.js v2 rule; in-session = leave-one-out, unseen data = model from earlier sessions)\n')
        print('| session | device | cm | tones | swipes L+R | in-session hit | reversed | undecided | push/pull read as swipe | unseen data | check |')
        print('|---|---|---|---|---|---|---|---|---|---|---|')
        for r in lr_rows:
            print(r)


if __name__ == '__main__':
    main()
