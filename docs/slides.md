# Slide outline (6 slides)

The video script and the live order are in [demo-script.md](demo-script.md); the 1-minute pitch in [pitch.md](pitch.md).

1. **Title:** Bat Ears 🦇 "Your laptop hears where your hand is, in 3D." A photo of a taped-over webcam next to the hologram hand, plus the team names.
2. **Problem:** hand tracking needs a camera (privacy, darkness) or a special sensor. Every laptop already has speakers and a mic.
3. **How it works:** two speakers play 18 / 19.5 kHz → the hand → the mic. Each echo path's length is followed from its phase (LLAP-style, in an AudioWorklet). A 2½-minute webcam session (MediaPipe) teaches a map from path changes to 3D movement; then the camera is off. Everything runs in the browser.
4. **Live demo:** `hologram.html`, the holographic hand following the real one, camera taped over. Fallback: Force Push.
5. **Results (honest):** on sittings the model never saw (8 sittings, leave-one-sitting-out, laptop speakers only, hand within about 45 cm of the webcam), the error of the hand's 250 ms movement is left-right 4.1 / toward-away 4.3 / up-down 2.6 cm RMS, against movements of 5.5 / 5.8 / 3.0 cm (correlation 0.67 / 0.68 / 0.54): height is weak, and phones didn't fix it yet. One person, one laptop so far. Gestures: push/pull 81% (268 of 332 prompts, 17 sessions, Windows and MacBooks, 20–60 cm), about 0.6 false triggers per minute.
6. **What's next:** a better source layout for height (our first phone placements didn't help), more people and laptops, absolute position. Close with "Trained with a camera, runs without one."
