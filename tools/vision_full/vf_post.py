"""Turn vision_full.html's per-frame landmarks into <session>_vision_full.csv: the same columns as the live
_vision.csv (v_right, v_up, v_screen and auto left empty), plus frame_idx, pts_ms, t_pts (startPerf + pts) and matched.

Timing: the webm timestamps (pts) follow the camera's capture time, so capture_time = pts + one constant. It is found in
two steps. The whole-frame shift is chosen where the re-extracted palm matches the live _vision.csv palm best (the same
image gives ~2 px, one frame off ~10 px), pairing frames on the regular mediaTime grid of _frames.csv. Then the constant
is the median of capture_time - pts over those pairs (residual std 0.29 ms in our first sitting).
t_cap = the _frames.csv capture_time where the frame had a live callback (matched=1), else pts + that constant.
Use t_cap, not t_pts: the recorder's onstart came 76 ms after the first frame in that sitting.
usage: python vf_post.py <session base> <vf json> [out csv]   (teach folder: $DATA, default ../../ml/data/teach)"""
import csv, json, math, os, sys
import numpy as np

D = os.environ.get('DATA') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'ml', 'data', 'teach')
base, vfj = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(D, base + '_vision_full.csv')
meta = json.load(open(os.path.join(D, base + '.json'), encoding='utf-8'))
V = json.load(open(vfj, encoding='utf-8'))
rows = V['rows']; info = V['info']
W, H = info['w'], info['h']; asp = W / H
start_perf = (meta.get('video') or {}).get('startPerf')

fr = list(csv.DictReader(open(os.path.join(D, base + '_frames.csv'), encoding='utf-8')))
ct = np.array([float(r['capture_time']) for r in fr]); mt = np.array([1000 * float(r['media_time']) for r in fr])
cap_minus_media = float(np.median(ct - mt))

live = {}
for r in csv.DictReader(open(os.path.join(D, base + '_vision.csv'), encoding='utf-8')):
    if r['present'] == '1':
        live[round(float(r['t_cap']), 1)] = (float(r['palm_x']), float(r['palm_y']))

def palm(L):
    P = [0, 5, 9, 13, 17]
    return sum(L[3 * i] for i in P) / 5, sum(L[3 * i + 1] for i in P) / 5

pts = np.array([r[1] for r in rows])
pres = [r[2] == 1 for r in rows]
re_palm = [palm(r[5]) if r[2] == 1 else None for r in rows]
order = np.argsort(mt)

def match(o, tol=5.0):
    """for each webm frame: index into frames.csv rows with |media - (pts + o)| < tol, else -1"""
    m = pts + o
    idx = np.searchsorted(mt[order], m)
    res = np.full(len(m), -1)
    for k in range(len(m)):
        best, bd = -1, tol
        for c in (idx[k] - 1, idx[k]):
            if 0 <= c < len(mt):
                d = abs(mt[order][c] - m[k])
                if d < bd: best, bd = order[c], d
        res[k] = best
    return res

def score(o):
    mj = match(o)
    ds = []
    for k, j in enumerate(mj):
        if j < 0 or not pres[k]: continue
        lv = live.get(round(ct[j], 1))
        if lv is None: continue
        px, py = re_palm[k]
        ds.append(math.hypot((px - lv[0]) * W, (py - lv[1]) * H))
    return (float(np.median(ds)) if len(ds) > 50 else float('inf')), len(ds), int((mj >= 0).sum())

# candidates: the webm's first frame lands on the media grid somewhere within +-1.5 s of the first logged callback
step = float(np.median(np.diff(mt)[np.diff([int(r['presented_frames']) for r in fr]) == 1]))
cands = [mt[0] + n * step - pts[0] for n in range(-45, 46)]
scored = sorted(((score(o), o) for o in cands), key=lambda t: t[0][0])
(best_med, best_n, best_matched), o = scored[0]
print(f'frame step {step:.3f} ms; best offset media = pts + {o:.1f} ms: median palm diff {best_med:.2f} px over {best_n} frames ({best_matched} webm frames have a live callback)')
for (m_, n_, _), o_ in scored[1:4]:
    print(f'  next: offset {o_:.1f} ({(o_ - o) / step:+.0f} frames): median palm diff {m_:.2f} px')
# the frame shift is now known. The webm pts follow the camera's capture time (not the regular media grid), so map
# capture = pts + oc: oc from each callback row's nearest webm frame on the media grid (half a frame window)
kn = np.clip(np.searchsorted(pts + o, mt), 1, len(pts) - 1)
kn = np.where(np.abs(pts[kn - 1] + o - mt) < np.abs(pts[kn] + o - mt), kn - 1, kn)
near = np.abs(mt - (pts[kn] + o)) < step / 2
oc = float(np.median(ct[near] - pts[kn[near]]))
resid = ct[near] - (pts[kn[near]] + oc)
print(f'capture = pts + {oc:.2f} ms: residual std {resid.std():.2f} ms, {np.mean(np.abs(resid) < 3):.1%} of {near.sum()} callback rows within 3 ms')
corder = np.argsort(ct)
def cmatch(tol=3.0):
    m = pts + oc
    idx = np.searchsorted(ct[corder], m)
    res = np.full(len(m), -1)
    for k in range(len(m)):
        best, bd = -1, tol
        for c in (idx[k] - 1, idx[k]):
            if 0 <= c < len(ct):
                d = abs(ct[corder][c] - m[k])
                if d < bd: best, bd = corder[c], d
        res[k] = best
    return res
mj = cmatch()

def fx(v, n):
    return '' if v is None or (isinstance(v, float) and not math.isfinite(v)) else f'{v:.{n}f}'

head = ['t_cap', 't_res', 'cap_src', 'present', 'hand', 'hand_mp', 'score', 'palm_x', 'palm_y', 'scale', 'v_right', 'v_up', 'v_screen', 'auto']
for i in range(21): head += [f'lm{i}_x', f'lm{i}_y', f'lm{i}_z']
for i in range(21): head += [f'wlm{i}_x', f'wlm{i}_y', f'wlm{i}_z']
head += ['frame_idx', 'pts_ms', 't_pts', 'matched']
blank63 = [''] * 63
n_match = 0
with open(out, 'w', encoding='utf-8', newline='') as f:
    f.write(','.join(head) + '\n')
    for k, r in enumerate(rows):
        j = mj[k]
        t_cap = ct[j] if j >= 0 else pts[k] + oc
        n_match += j >= 0
        t_pts = start_perf + pts[k] if start_perf is not None else None
        tail = [str(r[0]), fx(float(pts[k]), 3), fx(t_pts, 2), '1' if j >= 0 else '0']
        if r[2] != 1:
            f.write(','.join([fx(float(t_cap), 2), '', 'webm', '0', '', '', ''] + [''] * 7 + blank63 + blank63 + tail) + '\n')
            continue
        L, Wl = r[5], r[6]
        px, py = palm(L)
        d = lambda a, b: math.hypot((L[3 * a] - L[3 * b]) * asp, L[3 * a + 1] - L[3 * b + 1])
        sc = (d(0, 5) + d(0, 17) + d(5, 17)) / 3
        hand = r[3] or ''
        f.write(','.join([fx(float(t_cap), 2), '', 'webm', '1', hand, hand, fx(r[4], 3) if r[4] != '' else '', fx(px, 4), fx(py, 4), fx(sc, 4), '', '', '', '']
                         + [f'{v:.4f}' for v in L] + ([f'{v:.4f}' for v in Wl] if len(Wl) == 63 else blank63) + tail) + '\n')
print(f'wrote {out}: {len(rows)} frames, present {sum(pres)} ({sum(pres) / len(rows):.1%}), matched to live callbacks {n_match}, '
      f'capture = pts + {oc:.2f} ms, t_cap span {(pts[-1] - pts[0]) / 1000:.1f} s')
