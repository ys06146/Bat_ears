# Slide outline (6 slides)

1. **Title:** Bat Ears 🦇 "Your laptop hears your hands." A photo of a taped-over webcam, plus the team names.
2. **Problem:** touchless control needs cameras (privacy, darkness) or special sensors. Every laptop already has a speaker and a mic.
3. **How it works:** a diagram of speaker → 20 kHz tone → hand → echo → mic. Doppler: toward = higher pitch, away = lower, Δf = 2vf₀/c (0.5 m/s ≈ 58 Hz at 20 kHz). Runs in the browser, and the browser's voice filters are turned off.
4. **Live demo:** Force Push, plus the live spectrum.
5. **Results:** accuracy by distance (10 / 20 / 30 cm) and gesture, false triggers per minute when idle, the classifier's confusion matrix, and rule-based vs ML. [TBD from experiments/ and ml/]
6. **What's next:** left/right swipes with stereo tones, the in-browser classifier, real-world uses (kitchen, sterile rooms, accessibility), and phones. Close with "No camera. No extra hardware. Just sound."
