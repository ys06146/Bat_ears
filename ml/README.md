# ml/: gesture data and classifier

## 1. Record data (laptop, Chrome)

1. Open `web/index.html`, click ▶ 시작, allow the mic, and keep your hand away for 1.5 s.
2. Open **데이터 기록** and click **● 기록 시작**.
3. Pick a label with the number keys, then do only that motion for about 30 s:
   `1` idle · `2` push · `3` pull · `4` wave · `5` other (typing, moving around, walking by).
4. Click **■ 기록 정지** → **CSV 저장**, and put the file in `ml/data/`.
5. Record several sessions (10 / 20 / 30 cm, different people). Each CSV is one session.

## 2. Train and evaluate

```
python train.py              # every CSV under ml/data (fake data included if present)
python train.py data/real    # only one folder
python make_fake_data.py     # fake sessions in ml/data/fake, to test the pipeline
```

- Only the standard library is needed. If scikit-learn is installed, the script also runs a random forest.
- Evaluation leaves one session out at a time, so it never tests on a session it trained on.
- The output shows a confusion matrix, per-class precision and recall, and a comparison with the browser's rule-based detector on push/pull and on false push/pull during idle and other.
- `model.json` holds the softmax weights plus normalization, so the same model can run in the browser later.

## Features (one row per gesture candidate)

A candidate is an "active segment": a stretch where max(dUp, dDown) > 4 dB, with gaps up to about 100 ms merged. Quiet windows from idle blocks are added as `idle` examples.

`dur_ms, up_max, down_max, up_mean, down_mean, asym_mean/max/min, v_mean/max/min, v_sign_changes, peak_order, snr_mean`, plus the echo energy in 6 sub-bands above (u1–u6) and below (d1–d6) the carrier, each relative to the session's quiet level.
