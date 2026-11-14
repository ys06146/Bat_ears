"""Bat Ears 1단계: 스피커 -> 마이크 초음파 통과 측정 (찰리).

15~22 kHz를 1 kHz 간격으로 짧게 재생하며 동시에 녹음하고,
같은 주파수에서 무음 녹음 대비 수신 세기(SNR dB)를 계산한다.
1 kHz, 10 kHz는 기준(정상 동작 확인)용.

사용: python sweep.py [in_dev out_dev samplerate] ...
기본: WASAPI(18,16,48000), MME(1,3,44100), WDM-KS(20,21,48000)
"""
import sys
import numpy as np
import sounddevice as sd

AMP = 0.3          # 중간 볼륨 (풀스케일의 30%)
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
    # 지연을 피해 가운데 구간만 분석
    seg = rec[int(0.2 * sr):int(0.5 * sr)]
    seg = seg - seg.mean()
    w = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * w)) ** 2
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    m = np.abs(freqs - f) <= 60
    return spec[m].sum() if m.any() else np.nan


def local_snr(rec, f, sr):
    """같은 녹음 안에서 f 근처(±60Hz) 전력 / 주변(±150~1000Hz) 평균 바닥. 타이밍에 덜 민감."""
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
        print(f"  실패: {e}")
        return None
    rows = []
    for f in FREQS:
        if f >= sr / 2:
            rows.append((f, None, "나이퀴스트 초과"))
            continue
        rec = sd.playrec(tone(f, sr), samplerate=sr, channels=1,
                         device=(din, dout), blocking=True)[:, 0]
        ps, pn = band_power(rec, f, sr), band_power(base, f, sr)
        snr = 10 * np.log10(ps / max(pn, 1e-20))
        loc = local_snr(rec, f, sr)
        rows.append((f, snr, loc))
        print(f"  {f/1000:5.1f} kHz  SNR(vs 무음) {snr:6.1f} dB | 피크/주변 바닥 {loc:6.1f} dB")
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
