"""Bat Ears - Doppler hand-gesture prototype (single tone + mic + FFT).

Plays a steady tone, listens with the mic, and watches the +/-500 Hz around the tone.
A hand moving TOWARD the device shifts echoes up (push), AWAY shifts them down (pull).

modes
  devices                     list audio devices
  probe  --freqs 15000 18500  per frequency: tone SNR, noise floor, ambient, static false alarms
  run    --freq 18500         live push/pull detection printed to the console (+ CSV log)
"""
from __future__ import annotations

import argparse
import csv
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np
import sounddevice as sd

C_SOUND = 343.0
HERE = Path(__file__).resolve().parent


# ----------------------------------------------------------------- audio I/O
class Tone:
    """Continuous sine on an output device (phase-continuous, stoppable)."""

    def __init__(self, freq: float, device, sr: int, amp: float):
        self.freq, self.sr, self.amp, self.phase = freq, sr, amp, 0.0
        self.on = True
        self.stream = sd.OutputStream(device=device, samplerate=sr, channels=2, dtype="float32",
                                      callback=self._cb, blocksize=0)

    def _cb(self, out, frames, t, status):
        if not self.on:
            out[:] = 0
            return
        ph = self.phase + 2 * np.pi * self.freq / self.sr * np.arange(1, frames + 1)
        self.phase = float(ph[-1] % (2 * np.pi))
        s = (self.amp * np.sin(ph)).astype(np.float32)
        out[:, 0] = s
        out[:, 1] = s

    def __enter__(self):
        self.stream.start()
        return self

    def __exit__(self, *a):
        self.stream.stop()
        self.stream.close()


class Mic:
    def __init__(self, device, sr: int, block: int = 512):
        self.q: queue.Queue = queue.Queue()
        self.stream = sd.InputStream(device=device, samplerate=sr, channels=1, dtype="float32",
                                     blocksize=block, callback=lambda d, f, t, s: self.q.put(d[:, 0].copy()))

    def __enter__(self):
        self.stream.start()
        return self

    def __exit__(self, *a):
        self.stream.stop()
        self.stream.close()

    def record(self, secs: float, sr: int) -> np.ndarray:
        n, chunks = int(secs * sr), []
        while sum(len(c) for c in chunks) < n:
            chunks.append(self.q.get())
        return np.concatenate(chunks)[:n]


# ----------------------------------------------------------------- analysis
class Doppler:
    def __init__(self, sr: int, freq: float, nfft: int, band: float = 500.0, guard_hz: float = 25.0):
        self.sr, self.nfft = sr, nfft
        self.win = np.hanning(nfft).astype(np.float32)
        self.freqs = np.fft.rfftfreq(nfft, 1 / sr)
        self.df = self.freqs[1]
        self.nominal, self.band, self.guard = freq, band, guard_hz
        self.f0 = freq
        self.baseline = None

    def spectrum(self, x: np.ndarray) -> np.ndarray:
        X = np.fft.rfft(x[-self.nfft:] * self.win)
        return (np.abs(X) ** 2) / (np.sum(self.win) ** 2) * 4  # ~ amplitude^2 of a sine

    def locate_carrier(self, P: np.ndarray) -> float:
        m = (self.freqs > self.nominal - 80) & (self.freqs < self.nominal + 80)
        idx = np.flatnonzero(m)
        return float(self.freqs[idx[np.argmax(P[idx])]])

    def band_idx(self):
        off = self.freqs - self.f0
        inband = np.abs(off) <= self.band
        side = inband & (np.abs(off) >= self.guard)
        return off, inband, side

    def calibrate(self, frames: list[np.ndarray]):
        Ps = np.array(frames)
        self.f0 = self.locate_carrier(np.median(Ps, axis=0))
        self.baseline = np.median(Ps, axis=0) + 1e-20
        # spread of the static spectrum, used to make thresholds per bin
        self.base_db_sd = np.std(10 * np.log10(Ps + 1e-20), axis=0)

    def measure(self, P: np.ndarray, thr_db: float):
        off, inband, side = self.band_idx()
        carrier = P[np.argmin(np.abs(off))] + 1e-20
        ratio_db = 10 * np.log10((P + 1e-20) / self.baseline)
        hot = side & (ratio_db > thr_db + 2 * self.base_db_sd)
        excess = np.where(hot, P - self.baseline, 0.0)
        up = excess[off > 0].sum()
        dn = excess[off < 0].sum()
        tot = up + dn
        shift = float((excess * off).sum() / tot) if tot > 0 else 0.0
        return {
            "up_db": 10 * np.log10(up / carrier + 1e-20),
            "dn_db": 10 * np.log10(dn / carrier + 1e-20),
            "shift_hz": shift,
            "v": shift * C_SOUND / (2 * self.f0),
            "carrier_db": 10 * np.log10(carrier),
            "n_hot": int(hot.sum()),
        }


def noise_stats(P: np.ndarray, freqs: np.ndarray, f0: float, band=500.0, guard=50.0):
    off = freqs - f0
    side = (np.abs(off) <= band) & (np.abs(off) >= guard)
    peak = P[np.argmin(np.abs(off))]
    return 10 * np.log10(peak + 1e-20), 10 * np.log10(np.median(P[side]) + 1e-20)


# ----------------------------------------------------------------- modes
def cmd_devices(_):
    sys.stdout.reconfigure(encoding="utf-8")
    for i, d in enumerate(sd.query_devices()):
        api = sd.query_hostapis(d["hostapi"])["name"]
        print(f"{i:2d} {api[:14]:14s} in={d['max_input_channels']} out={d['max_output_channels']} "
              f"sr={d['default_samplerate']:.0f}  {d['name']}")


def cmd_probe(a):
    print(f"mic dev={a.in_dev} sr={a.in_sr}  |  speaker dev={a.out_dev} sr={a.out_sr}  amp={a.amp}")
    print(f"Nyquist of mic = {a.in_sr / 2:.0f} Hz")
    det_nfft = a.nfft
    with Mic(a.in_dev, a.in_sr) as mic:
        mic.record(0.5, a.in_sr)  # warm-up
        amb = mic.record(a.secs, a.in_sr)  # tone off: ambient
        freqs = np.fft.rfftfreq(det_nfft, 1 / a.in_sr)
        an = Doppler(a.in_sr, 0, det_nfft)
        for f in a.freqs:
            if f >= a.in_sr / 2:
                print(f"\n== {f:.0f} Hz: above mic Nyquist ({a.in_sr / 2:.0f} Hz) -> cannot be captured at all")
                continue
            with Tone(f, a.out_dev, a.out_sr, a.amp):
                mic.record(0.4, a.in_sr)  # let it settle
                x = mic.record(a.secs, a.in_sr)
            # average spectra over hops
            hop = det_nfft // 2
            frames = [an.spectrum(x[i:i + det_nfft]) for i in range(0, len(x) - det_nfft, hop)]
            P = np.median(frames, axis=0)
            Pa = np.median([an.spectrum(amb[i:i + det_nfft]) for i in range(0, len(amb) - det_nfft, hop)], axis=0)
            fpk = freqs[np.argmax(np.where(np.abs(freqs - f) < 80, P, 0))]
            pk, floor = noise_stats(P, freqs, fpk)
            apk, afloor = noise_stats(Pa, freqs, f)
            # static false alarms: calibrate on first 1.5 s, test the rest
            d = Doppler(a.in_sr, f, det_nfft)
            ncal = int(1.5 * a.in_sr / hop)
            d.calibrate(frames[:ncal])
            hits = [d.measure(Pf, a.thr_db) for Pf in frames[ncal:]]
            fa = sum(1 for h in hits if max(h["up_db"], h["dn_db"]) > a.energy_db) / max(1, len(hits))
            print(f"\n== {f:.0f} Hz (peak found at {fpk:.1f} Hz)")
            print(f"   tone on : peak {pk:6.1f} dBFS | floor(+-50..500Hz) {floor:6.1f} dBFS | SNR {pk - floor:5.1f} dB")
            print(f"   tone off: level at {f:.0f} Hz {apk:6.1f} dBFS | floor {afloor:6.1f} dBFS")
            print(f"   tone rise over ambient: {pk - apk:5.1f} dB | static false-alarm frames: {100 * fa:4.1f}%")


def cmd_run(a):
    hop = a.hop
    d = Doppler(a.in_sr, a.freq, a.nfft)
    log_path = HERE / f"run_{time.strftime('%H%M%S')}_{int(a.freq)}.csv"
    print(f"Bat Ears  tone {a.freq:.0f} Hz  mic sr {a.in_sr}  nfft {a.nfft} ({a.nfft / a.in_sr * 1000:.0f} ms)  "
          f"bin {a.in_sr / a.nfft:.1f} Hz  hop {hop}")
    print(f"log -> {log_path}")
    buf = np.zeros(a.nfft, dtype=np.float32)
    events, last_ev, streak, streak_lbl = [], -9.0, 0, None
    t_start = time.time()
    with Tone(a.freq, a.out_dev, a.out_sr, a.amp), Mic(a.in_dev, a.in_sr, hop) as mic, \
            log_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "up_db", "dn_db", "shift_hz", "v", "carrier_db", "n_hot", "label"])
        print("calibrating... keep still for 2 s")
        cal, t_cal_end = [], time.time() + 2.0
        while time.time() < t_cal_end:
            blk = mic.q.get()
            buf = np.concatenate([buf[len(blk):], blk])
            cal.append(d.spectrum(buf))
        d.calibrate(cal[len(cal) // 4:])
        print(f"carrier at {d.f0:.1f} Hz. GO! push toward / pull away. ({a.secs:.0f} s)\n")
        while time.time() - t_start < a.secs:
            blk = mic.q.get()
            buf = np.concatenate([buf[len(blk):], blk])
            m = d.measure(d.spectrum(buf), a.thr_db)
            t = time.time() - t_start
            energy = max(m["up_db"], m["dn_db"])
            label = ""
            if energy > a.energy_db:
                if m["up_db"] > m["dn_db"] + a.dir_db:
                    label = "PUSH"
                elif m["dn_db"] > m["up_db"] + a.dir_db:
                    label = "PULL"
            streak = streak + 1 if (label and label == streak_lbl) else (1 if label else 0)
            streak_lbl = label or None
            w.writerow([f"{t:.3f}", f"{m['up_db']:.1f}", f"{m['dn_db']:.1f}", f"{m['shift_hz']:.1f}",
                        f"{m['v']:.3f}", f"{m['carrier_db']:.1f}", m["n_hot"], label])
            bar_n = int(np.clip((energy - a.energy_db + 12) / 3, 0, 12)) if energy > -200 else 0
            bar = (">" * bar_n if m["shift_hz"] > 0 else "<" * bar_n).ljust(12)
            sys.stdout.write(f"\r t={t:5.1f}s  [{bar}]  shift={m['shift_hz']:+6.1f} Hz  v={m['v']:+.2f} m/s   ")
            if streak == a.min_frames and t - last_ev > a.refractory:
                last_ev = t
                events.append((round(t, 2), label, round(m["v"], 2)))
                arrow = "  >>>>>  PUSH (toward)" if label == "PUSH" else "  <<<<<  PULL (away)"
                sys.stdout.write(f"\n[{t:5.1f}s] {arrow}   v={m['v']:+.2f} m/s\n")
            sys.stdout.flush()
    print("\n\nevents:", events)
    print(f"total: PUSH={sum(e[1] == 'PUSH' for e in events)}  PULL={sum(e[1] == 'PULL' for e in events)}")


CUES = (
    [(0.0, "STAY STILL (hands away)")]
    + [(3.0 + 2.0 * i, f"PUSH #{i + 1}  >>>") for i in range(5)]
    + [(13.0, "get ready to PULL (hand close to the monitor)")]
    + [(15.0 + 2.0 * i, f"PULL #{i + 1}  <<<") for i in range(5)]
    + [(25.0, "hands away, TALK or CLAP"), (31.0, "done")]
)


def cmd_take(a):
    """Record raw audio with the tone on while printing timed cues (ground truth for scoring)."""
    from scipy.io import wavfile

    stamp = time.strftime("%H%M%S")
    wav_path = HERE / f"take_{stamp}_{int(a.freq)}.wav"
    cue_path = HERE / f"take_{stamp}_{int(a.freq)}_cues.csv"
    print(f"Bat Ears TAKE  tone {a.freq:.0f} Hz  -> {wav_path.name}\n")
    chunks, cues_done = [], []
    with Tone(a.freq, a.out_dev, a.out_sr, a.amp), Mic(a.in_dev, a.in_sr, 1024) as mic:
        mic.record(0.5, a.in_sr)  # settle
        n_total, n = int(CUES[-1][0] * a.in_sr), 0
        nxt = 0
        while n < n_total:
            blk = mic.q.get()
            chunks.append(blk)
            n += len(blk)
            t = n / a.in_sr
            while nxt < len(CUES) and t >= CUES[nxt][0]:
                print(f"[{CUES[nxt][0]:4.1f}s]  {CUES[nxt][1]}", flush=True)
                cues_done.append((round(t, 3), CUES[nxt][1]))
                nxt += 1
    x = np.concatenate(chunks)
    wavfile.write(wav_path, a.in_sr, (np.clip(x, -1, 1) * 32767).astype(np.int16))
    with cue_path.open("w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows([("t", "cue"), *cues_done])
    print(f"\nsaved {wav_path.name} ({len(x) / a.in_sr:.1f} s). Done! You can close the window.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["devices", "probe", "run", "take"])
    ap.add_argument("--freq", type=float, default=18500)
    ap.add_argument("--freqs", type=float, nargs="+", default=[18500])
    ap.add_argument("--in-dev", type=int, default=None)
    ap.add_argument("--out-dev", type=int, default=None)
    ap.add_argument("--in-sr", type=int, default=48000)
    ap.add_argument("--out-sr", type=int, default=48000)
    ap.add_argument("--amp", type=float, default=0.3)
    ap.add_argument("--secs", type=float, default=4.0)
    ap.add_argument("--nfft", type=int, default=4096)
    ap.add_argument("--hop", type=int, default=512)
    ap.add_argument("--thr-db", type=float, default=6.0, help="per-bin rise over static baseline")
    ap.add_argument("--energy-db", type=float, default=-50.0, help="sideband energy rel. carrier to count")
    ap.add_argument("--dir-db", type=float, default=3.0, help="up vs down margin for a direction")
    ap.add_argument("--min-frames", type=int, default=3)
    ap.add_argument("--refractory", type=float, default=0.5)
    a = ap.parse_args()
    {"devices": cmd_devices, "probe": cmd_probe, "run": cmd_run, "take": cmd_take}[a.mode](a)


if __name__ == "__main__":
    main()
