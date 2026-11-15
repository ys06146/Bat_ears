# Slide outline (6 slides)

A fuller draft with numbers, the video script and the 1-minute pitch is in [pitch.md](pitch.md).

1. **Title:** Bat Ears 🦇 "Your laptop hears your hands." A photo of a taped-over webcam, plus the team names.
2. **Problem:** touchless control needs cameras (privacy, darkness) or special sensors. Every laptop already has a speaker and a mic.
3. **How it works:** a diagram of speaker → 20 kHz tone → hand → echo → mic. Doppler: toward = higher pitch, away = lower, Δf = 2vf₀/c (0.5 m/s ≈ 58 Hz at 20 kHz). Runs in the browser, and the browser's voice filters are turned off.
4. **Live demo:** Force Push, plus the live spectrum.
5. **Results:** push/pull 77% (148 of 192 prompts, 10 sessions, Windows and MacBooks, 20–35 cm), about 0.7 false triggers per minute while typing or idle (`python ml/report.py`). Rule-based detection beat the learned classifier (66% leave-one-session-out). Left/right: 15/20 within a session but 7/20 on a new one, so it's experimental. [TBD: 10 cm and more people]
6. **What's next:** left/right swipes from the echo's phase and the second mic, the in-browser classifier, real-world uses (kitchen, sterile rooms, accessibility), and phones. Close with "No camera. No extra hardware. Just sound."
