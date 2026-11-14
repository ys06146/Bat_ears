"""Summarize a run_*.csv: timeline of sideband energy, Doppler shift, and detected events."""
import csv
import sys

import numpy as np

path = sys.argv[1]
energy_thr = float(sys.argv[2]) if len(sys.argv) > 2 else -50.0
rows = list(csv.DictReader(open(path, encoding="utf-8")))
t = np.array([float(r["t"]) for r in rows])
up = np.array([float(r["up_db"]) for r in rows])
dn = np.array([float(r["dn_db"]) for r in rows])
sh = np.array([float(r["shift_hz"]) for r in rows])
v = np.array([float(r["v"]) for r in rows])
car = np.array([float(r["carrier_db"]) for r in rows])
lab = [r["label"] for r in rows]
print(f"{path}: {len(rows)} frames over {t[-1]:.1f}s ({len(rows) / max(t[-1], 1e-9):.0f} fps)")
print(f"carrier level median {np.median(car):.1f} dBFS (min {car.min():.1f}, max {car.max():.1f})")
e = np.maximum(up, dn)
print(f"sideband energy rel. carrier: p10 {np.percentile(e, 10):.1f}  p50 {np.median(e):.1f}  p90 {np.percentile(e, 90):.1f}  max {e.max():.1f} dB")
print("\ntime   up_db  dn_db  shift_Hz  v_m/s  labels  (0.5 s bins, max energy frame)")
for s in np.arange(0, t[-1], 0.5):
    m = (t >= s) & (t < s + 0.5)
    if not m.any():
        continue
    i = np.flatnonzero(m)[np.argmax(e[m])]
    labs = "".join("P" if lab[j] == "PUSH" else ("L" if lab[j] == "PULL" else ".") for j in np.flatnonzero(m))
    bar = ("+" if sh[i] > 0 else "-") * int(np.clip((e[i] - energy_thr + 12) / 3, 0, 15))
    print(f"{s:5.1f}  {up[i]:6.1f} {dn[i]:6.1f}  {sh[i]:+7.1f}  {v[i]:+5.2f}  {labs[:32]:32s} {bar}")
