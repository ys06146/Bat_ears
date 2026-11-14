"""Train and evaluate a gesture classifier on recorder CSVs.

usage:
  python train.py                 # all CSVs under ml/data (real recordings)
  python train.py data/fake       # a specific folder (e.g. the fake data)

What it does
  1. features.py turns each recording into one row per gesture candidate (plus quiet idle windows).
  2. Split by session (leave-one-session-out). With only one session it falls back to a random 30% split.
  3. Train softmax (multinomial logistic) regression in pure Python, and a random forest if scikit-learn is installed.
  4. Compare with the browser's rule-based detector on push/pull samples.
  5. Save ml/model.json (logistic weights plus normalization) so the browser can run the same model.
"""
import json
import math
import os
import random
import sys

from features import FEATURES, build_dataset, find_csvs, load_rows

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- pure-Python softmax regression
class Softmax:
    def __init__(self, classes, lr=0.3, epochs=400, l2=1e-3, seed=0):
        self.classes, self.lr, self.epochs, self.l2, self.seed = classes, lr, epochs, l2, seed

    def fit(self, X, y):
        d, k = len(X[0]), len(self.classes)
        self.mu = [sum(c) / len(X) for c in zip(*X)]
        self.sd = [max(1e-6, math.sqrt(sum((x - m) ** 2 for x in c) / len(X))) for c, m in zip(zip(*X), self.mu)]
        Z = [self._norm(x) for x in X]
        idx = [self.classes.index(c) for c in y]
        # class weights so rare classes still count
        counts = [idx.count(i) or 1 for i in range(k)]
        cw = [len(idx) / (k * c) for c in counts]
        self.W = [[0.0] * (d + 1) for _ in range(k)]
        for _ in range(self.epochs):
            grad = [[0.0] * (d + 1) for _ in range(k)]
            for z, t in zip(Z, idx):
                p = self._proba_z(z)
                for c in range(k):
                    g = (p[c] - (1.0 if c == t else 0.0)) * cw[t]
                    row = grad[c]
                    for j in range(d):
                        row[j] += g * z[j]
                    row[d] += g
            n = len(Z)
            for c in range(k):
                for j in range(d + 1):
                    reg = self.l2 * self.W[c][j] if j < d else 0.0
                    self.W[c][j] -= self.lr * (grad[c][j] / n + reg)
        return self

    def _norm(self, x):
        return [(v - m) / s for v, m, s in zip(x, self.mu, self.sd)]

    def _proba_z(self, z):
        d = len(z)
        logits = [sum(w[j] * z[j] for j in range(d)) + w[d] for w in self.W]
        mx = max(logits)
        e = [math.exp(v - mx) for v in logits]
        s = sum(e)
        return [v / s for v in e]

    def predict(self, X):
        out = []
        for x in X:
            p = self._proba_z(self._norm(x))
            out.append(self.classes[max(range(len(p)), key=p.__getitem__)])
        return out

    def to_json(self):
        return {'type': 'softmax', 'features': FEATURES, 'classes': self.classes,
                'mean': self.mu, 'std': self.sd, 'weights': self.W}


# ---------------------------------------------------------------- evaluation helpers
def confusion(y_true, y_pred, classes):
    m = {a: {b: 0 for b in classes} for a in classes}
    for t, p in zip(y_true, y_pred):
        if t in m and p in m[t]:
            m[t][p] += 1
    return m


def report(name, y_true, y_pred, classes):
    acc = sum(t == p for t, p in zip(y_true, y_pred)) / max(1, len(y_true))
    print(f'\n== {name}: accuracy {acc:.3f} on {len(y_true)} samples')
    m = confusion(y_true, y_pred, classes)
    print('true\\pred ' + ' '.join(f'{c:>6}' for c in classes) + '   recall')
    for a in classes:
        row = m[a]
        tot = sum(row.values())
        rec = row[a] / tot if tot else float('nan')
        print(f'{a:>9} ' + ' '.join(f'{row[b]:>6}' for b in classes) + f'   {rec:.2f}')
    prec = {}
    for b in classes:
        col = sum(m[a][b] for a in classes)
        prec[b] = m[b][b] / col if col else float('nan')
    print('precision ' + ' '.join(f'{prec[c]:>6.2f}' for c in classes))
    return acc


def cue_report(paths, window_ms=1500):
    """Guided-collection recordings carry a `cue` column. For each cue: did the browser's rule-based
    detector fire the right gesture within window_ms? Also count false push/pull during idle/other."""
    hits = {'push': [0, 0], 'pull': [0, 0]}
    wrong, fp, quiet_ms = 0, 0, 0.0
    for rows in load_rows(paths).values():
        if not rows or 'cue' not in rows[0]:
            continue
        t = [float(r['t_ms'] or 0) for r in rows]
        cues = [(t[i], r['cue']) for i, r in enumerate(rows) if r.get('cue') in hits]
        events = [(t[i], r['gesture']) for i, r in enumerate(rows) if r.get('gesture') in ('push', 'pull')]
        if not cues:
            continue
        for ct, kind in cues:
            got = [k for (et, k) in events if ct <= et <= ct + window_ms]
            hits[kind][1] += 1
            if kind in got:
                hits[kind][0] += 1
            elif got:
                wrong += 1
        for i in range(1, len(rows)):
            if rows[i]['label'] in ('idle', 'other'):
                quiet_ms += max(0.0, min(100.0, t[i] - t[i - 1]))
        fp += sum(1 for i, r in enumerate(rows) if r.get('gesture') in ('push', 'pull') and r['label'] in ('idle', 'other'))
    total = hits['push'][1] + hits['pull'][1]
    if not total:
        return
    print(f'\n== guided-collection cues (rule-based detector, within {window_ms / 1000:.1f} s)')
    for k, (h, n) in hits.items():
        if n:
            print(f'  {k}: {h}/{n} = {h / n:.0%}')
    print(f'  wrong direction: {wrong}/{total}')
    if quiet_ms > 0:
        print(f'  false push/pull during idle+other: {fp} in {quiet_ms / 60000:.1f} min = {fp / (quiet_ms / 60000):.1f} per min')


def splits(groups, y, seed=0, min_samples=30, k=5):
    """Leave-one-session-out when there are 2+ real sessions; otherwise stratified k-fold (optimistic)."""
    counts = {s: groups.count(s) for s in set(groups)}
    big = sorted(s for s, n in counts.items() if n >= min_samples)
    if len(big) >= 2:
        for s in big:
            test = [i for i, g in enumerate(groups) if g == s]
            train = [i for i, g in enumerate(groups) if g != s]
            yield f'test={s}', train, test
        return
    print(f'fewer than 2 sessions with {min_samples}+ samples: stratified {k}-fold within the data '
          '(optimistic; record more sessions for a fair estimate)')
    rng = random.Random(seed)
    fold = [0] * len(y)
    for c in sorted(set(y)):
        idx = [i for i, lab in enumerate(y) if lab == c]
        rng.shuffle(idx)
        for j, i in enumerate(idx):
            fold[i] = j % k
    for f in range(k):
        yield f'fold {f + 1}/{k}', [i for i in range(len(y)) if fold[i] != f], [i for i in range(len(y)) if fold[i] == f]


def main():
    default = len(sys.argv) <= 1
    folder = sys.argv[1] if not default else os.path.join(HERE, 'data')
    if not os.path.isabs(folder):
        folder = os.path.join(HERE, folder)
    paths = find_csvs(folder)
    if default:
        real = [p for p in paths if os.sep + 'fake' + os.sep not in p]
        if real:
            paths = real  # with real recordings present, leave the fake sessions out
    print('files: ' + ', '.join(os.path.basename(p) for p in paths))
    if not paths:
        print(f'no CSV files under {folder}. Record with web/index.html, or run: python make_fake_data.py')
        return 1
    X, y, groups, meta = build_dataset(paths)
    classes = [c for c in ['idle', 'push', 'pull', 'wave', 'other'] if c in set(y)]
    print(f'{len(paths)} file(s), {len(set(groups))} session(s), {len(X)} samples')
    print('per class: ' + ', '.join(f'{c}={y.count(c)}' for c in classes))

    all_true, all_lr, all_rf, all_rule = [], [], [], []
    have_sklearn = True
    try:
        from sklearn.ensemble import RandomForestClassifier  # optional
    except ImportError:
        have_sklearn = False
        print('(scikit-learn not installed: random forest skipped)')

    for name, tr, te in splits(groups, y):
        Xtr, ytr = [X[i] for i in tr], [y[i] for i in tr]
        Xte, yte = [X[i] for i in te], [y[i] for i in te]
        if not Xte or len(set(ytr)) < 2:
            continue
        lr = Softmax(classes).fit(Xtr, ytr)
        all_true += yte
        all_lr += lr.predict(Xte)
        if have_sklearn:
            rf = RandomForestClassifier(n_estimators=200, random_state=0, class_weight='balanced').fit(Xtr, ytr)
            all_rf += list(rf.predict(Xte))
        all_rule += [meta[i]['rule'] for i in te]

    report('logistic (softmax) regression', all_true, all_lr, classes)
    if have_sklearn and all_rf:
        report('random forest', all_true, all_rf, classes)

    # rule-based detector vs. ML on the samples it is meant for (push/pull)
    pp = [i for i, t in enumerate(all_true) if t in ('push', 'pull')]
    if pp:
        rule_acc = sum(all_rule[i] == all_true[i] for i in pp) / len(pp)
        lr_acc = sum(all_lr[i] == all_true[i] for i in pp) / len(pp)
        print(f'\npush/pull only ({len(pp)} samples): rule-based {rule_acc:.3f}  vs  logistic {lr_acc:.3f}')
    fa = [i for i, t in enumerate(all_true) if t in ('idle', 'other')]
    if fa:
        rule_fa = sum(all_rule[i] in ('push', 'pull') for i in fa) / len(fa)
        lr_fa = sum(all_lr[i] in ('push', 'pull') for i in fa) / len(fa)
        print(f'false push/pull on idle+other ({len(fa)} samples): rule-based {rule_fa:.3f}  vs  logistic {lr_fa:.3f}')

    cue_report(paths)

    final = Softmax(classes).fit(X, y)
    out = os.path.join(HERE, 'model.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(final.to_json(), f, indent=1)
    print(f'\nsaved {out} (trained on all {len(X)} samples)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
