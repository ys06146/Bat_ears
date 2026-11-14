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


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'data')
    paths = [p for p in sorted(glob.glob(os.path.join(folder, '*.csv'))) if os.sep + 'fake' not in p]
    rows, tot = [], {'cues': 0, 'live': 0, 'live_n': 0, 'hit': 0, 'wrong': 0, 'fp': 0, 'quiet_min': 0.0}
    lr_rows = []
    for p in paths:
        name = os.path.basename(p)[len('batears_'):-4]
        m = meta_of(p)
        fr = rb.load(p)
        cues = [x for x in fr if x['cue'] in ('push', 'pull')]
        dev = m.get('device') or '(old)'  # sessions before the metadata JSON existed
        dm = re.search(r'_d(\d+)_', '_' + name + '_')
        dist = m.get('dist') or (dm.group(1) if dm else '')
        if m.get('swipeOnly') or '_lr_' in name:
            c = m.get('lrCheck') or {}
            lr_rows.append(f"| {name[:15]} | {dev} | {dist} | {'/'.join(str(f // 1000) + ('.5' if f % 1000 else '') for f in (m.get('stereoPair') or [])) or '–'}k "
                           f"| {c.get('nL', '–')}+{c.get('nR', '–')} | {c.get('looAcc', '–')} | {c.get('looWrong', '–')} "
                           f"| {c.get('fpRate', '–')} | {'✅' if c.get('ok') else '❌'} {c.get('version', 1)} |")
            continue
        if len(cues) < 5:
            continue  # aborted / test runs
        s = rb.score(fr, rb.burst_detect(fr))
        live = m.get('live') or {}
        lh = live.get('hits')
        ln = live.get('trials')
        miss = s['cues'] - s['hit'] - s['wrong']
        fpm = s['fp'] / s['quiet_min'] if s['quiet_min'] > 0 else 0.0
        note = []
        if m.get('foreignTones'):
            note.append('other ultrasound ' + ','.join(map(str, m['foreignTones'])) + ' kHz')
        if m.get('stereo'):
            note.append('stereo')
        rows.append(f"| {name[:15]} | {dev} | {dist} | {s['cues']} | {f'{lh}/{ln}' if lh is not None else '–'} "
                    f"| {s['hit']}/{s['cues']} ({pct(s['hit'], s['cues'])}) | {s['wrong']} | {miss} | {fpm:.1f} | {'; '.join(note)} |")
        for k, v in (('cues', s['cues']), ('hit', s['hit']), ('wrong', s['wrong']), ('fp', s['fp']), ('quiet_min', s['quiet_min'])):
            tot[k] += v
        if lh is not None and ln:
            tot['live'] += lh
            tot['live_n'] += ln
    print('### Push / pull (guided prompts, burst rule)\n')
    print('| session | device | cm | prompts | live hit | replay hit | wrong | missed | false/min | note |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        print(r)
    fpm = tot['fp'] / tot['quiet_min'] if tot['quiet_min'] > 0 else 0.0
    print(f"| **all** | | | {tot['cues']} | {tot['live']}/{tot['live_n']} | **{tot['hit']}/{tot['cues']} ({pct(tot['hit'], tot['cues'])})** "
          f"| {tot['wrong']} | {tot['cues'] - tot['hit'] - tot['wrong']} | {fpm:.1f} | |")
    if lr_rows:
        print('\n### Left / right check sessions (swipe.js; leave-one-out with the live rule)\n')
        print('| session | device | cm | tones | swipes L+R | hit | reversed | push/pull read as swipe | usable / version |')
        print('|---|---|---|---|---|---|---|---|---|')
        for r in lr_rows:
            print(r)


if __name__ == '__main__':
    main()
