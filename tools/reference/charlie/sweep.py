"""Bat Ears step 1: measure how much ultrasound gets from speaker to mic (Charlie).

Plays short tones from 15 to 22 kHz in 1 kHz steps while recording,
and computes the received level against a silent recording at the same frequency (SNR dB).
1 kHz and 10 kHz are references (to confirm it works at all).

usage: python sweep.py [in_dev out_dev samplerate] ...
default: WASAPI(18,16,48000), MME(1,3,44100), WDM-KS(20,21,48000)
"""
import sys
import numpy as np
import sounddevice as sd

AMP = 0.3          # medium volume (30% of full scale)
TONE_S = 0.6
FADE_S = 0.01
FREQS = [1000, 5000, 7000, 8000, 10000, 12000] + list(range(15000, 23000, 1000))

DEFAULT_CONFIGS = [
    ("WASAPI", 18, 16, 48000),
    ("MME", 1, 3, 44100),
    ("WDM-KS", 20, 21, 48000),
]


def tone(f, sr):
    t = np.arange(int(TONE_S * sr)) / sr
    x = AMP * np.sin(2 * np.pi * f * t)
    n = int(FADE_S * sr)
    ramp = np.linspace(0, 1, n)
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]
    return np.column_stack([x, x]).astype(np.float32)


def band_power(rec, f, sr):
    # analyse only the middle stretch, to stay clear of latency
    seg = rec[int(0.2 * sr):int(0.5 * sr)]
    seg = seg - seg.mean()
    w = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * w)) ** 2
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    m = np.abs(freqs - f) <= 60
    return spec[m].sum() if m.any() else np.nan


def local_snr(rec, f, sr):
    """Within the same recording: power near f (±60 Hz) / mean floor around it (±150–1000 Hz). Less sensitive to timing."""
    seg = rec - rec.mean()
    w = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * w)) ** 2
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    d = np.abs(freqs - f)
    peak = spec[d <= 60].mean()
    floor = np.median(spec[(d >= 150) & (d <= 1000)])
    return 10 * np.log10(peak / max(floor, 1e-20))


def run(label, din, dout, sr):
    print(f"\n=== {label}: in={din} out={dout} sr={sr} ===")
    try:
        silence = np.zeros((int(TONE_S * sr), 2), np.float32)
        base = sd.playrec(silence, samplerate=sr, channels=1,
                          device=(din, dout), blocking=True)[:, 0]
    except Exception as e:
        print(f"  failed: {e}")
        return None
    rows = []
    for f in FREQS:
        if f >= sr / 2:
            rows.append((f, None, "above Nyquist"))
            continue
        rec = sd.playrec(tone(f, sr), samplerate=sr, channels=1,
                         device=(din, dout), blocking=True)[:, 0]
        ps, pn = band_power(rec, f, sr), band_power(base, f, sr)
        snr = 10 * np.log10(ps / max(pn, 1e-20))
        loc = local_snr(rec, f, sr)
        rows.append((f, snr, loc))
        print(f"  {f/1000:5.1f} kHz  SNR(vs silence) {snr:6.1f} dB | peak/local floor {loc:6.1f} dB")
    return rows


def main():
    args = sys.argv[1:]
    if args:
        configs = [("custom", int(args[0]), int(args[1]), int(args[2]))]
    else:
        configs = DEFAULT_CONFIGS
    for label, din, dout, sr in configs:
        run(label, din, dout, sr)


if __name__ == "__main__":
    main()
