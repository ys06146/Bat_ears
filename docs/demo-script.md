# Demo script (2-minute video and live judging)

## Main: Bat Ears 3D (`web/hologram.html`)

### 2-minute video

| Time | Shot | Narration |
|---|---|---|
| 0:00–0:12 | A hand hovering over a laptop, then a close-up of the webcam with tape on it. | "What if your laptop knew where your hand was, in 3D, without a camera?" |
| 0:12–0:22 | Title card: **Bat Ears 3D**. "Trained with a camera, runs without one." | "Bats see with sound. So does this laptop." |
| 0:22–0:40 | **Teach.** `teach.html` with the camera on and the hand skeleton overlaid. Show the 2½-minute guided session as a time-lapse with an on-screen clock (left-right, up-down, toward-away, circles, push, pull, wave). | "For two and a half minutes, the webcam teaches the sound where my hand really is. Nothing leaves this laptop." |
| 0:40–1:10 | **Money shot.** Tape over the camera, its light off. Open `hologram.html`: the holographic hand moves with the real hand, driven by sound alone. Split screen, real hand and hologram, at the taped hand spot. Lead with left-right and toward-away; keep up-down small. | "Now the camera is off. That hand on screen is driven by sound alone: the laptop's speakers play tones you can't hear, and the mic follows how each echo path to my hand stretches and shrinks." |
| 1:10–1:30 | **How + honesty.** Diagram: two speakers → hand → mic, paths stretching. Then the accuracy card from the page. | "A model taught by the camera turns those path changes into 3D. On sittings it never saw, it tracks left-right and depth to about four centimetres; height is still our weak axis, and the screen says so." |
| 1:30–1:45 | **Extras.** Quick cuts of push to blast in Force Push and the gesture key. | "The same engine does push, pull and wave, a game, and a gesture key in your own rhythm." |
| 1:45–2:00 | End card: the URL and "No camera. No install. Nothing sent." Team on camera. | "Bat Ears: your laptop hears where your hand is. I'm 서진, with 재윤, 서희 and 소연." |

Filming tips: record the teach step and the camera-off step in one take, so nobody suspects a cut. The "difference from the webcam" readout only appears when replaying a recording, so don't plan a live shot around it. In `hologram.html`, 🎬 촬영 모드 hides the panels (H toggles them, F is full screen, space re-centres) and keeps a caption with the honest numbers.

### Before filming or judging (once)
1. **Power, light and phones:** charger plugged in, screen brightness fixed at maximum, phones away from the laptop (or in airplane mode). Two sittings with a phone above the laptop picked up a 375 Hz modulation of the tones; check the page's 🔎 peaks for 17.62 / 18.38 / 19.14 / 19.86 kHz and remove the cause (a phone nearby, the charger, brightness, a vibrating stand).
2. **No stray ultrasound:** close every other Bat Ears tab (look for 🔊 on Chrome tabs) and other laptops running it. A stray 20 kHz tone spoiled hours of recordings.
3. **The hand spot:** open `teach.html`, press ①, and find the spot in the preview: above the laptop's front edge, 18-25 cm above the desk, '📏 웹캠에서 25~45cm' green. **Mark it on the desk with tape.** The calibration was learned there.
4. **Phones: leave them out of the demo.** We measured them: a phone above the hand gave an echo path that didn't follow the hand, and phones beside the laptop added at most 0.05 to height correlation. Laptop-only is the calibrated default (`hologram.html?preset=above` stays as a labelled experiment).
5. Re-teach (`teach.html`, ② session, 2½ min) only if the laptop, the room or the hand spot changed.

### Live (30 s per judge)
1. Tape over the webcam. Open `hologram.html` and press ▶ 시작. Tone volume 1.2 (the teach level) is the default; 🔍 진단 shows the tone level against the teach sessions.
2. Hand over the tape mark, press ◎ 가운데 (or space), then move left-right and toward-away briskly (about 20 cm a second). The hologram follows. Sound measures movement, not position, so the hand drifts back to the centre when you stop.
3. Honest numbers on screen (default 'balanced' size): left-right ±4.1 · toward-away ±4.3 · up-down ±2.6 cm. That's the RMS error of the hand's 250 ms movement on a sitting the model never saw (seven webcam-taught sittings, each left out once; laptop speakers only; hand within about 45 cm of the webcam; one person, one laptop). The movements themselves were 5.5 / 5.7 / 3.0 cm RMS, and the screen draws them at 76 / 81 / 72 % of their true size: a least-squares map draws motion at (correlation × true size), so the weak axis looks small. ⚙ 'real size' draws ~100 % at about 10 % more error.
4. For engineers: `3d.html` shows the per-path quality bars, the geometry and the circle calls.
5. If 3D misbehaves: Force Push below.

## Fallback: Force Push (`web/index.html`)

Setup: laptop on the table, volume ≥ 50%, built-in speaker and mic, tape over the webcam, `web/index.html` open and ▶ already started (calibrated).

| Time | Show | Say |
|---|---|---|
| 0:00–0:10 | Put tape over the webcam on camera. | "What if your laptop could see your hands without a camera? Like a bat." |
| 0:10–0:25 | A short shot of someone cooking with messy hands, or a dark room (optional). | "Touchless control today needs a camera, which has privacy issues and fails in the dark, or extra hardware. Every laptop already has a speaker and a mic." |
| 0:25–1:05 | Live: push your palm toward the screen and a meteor explodes. Pull, and a star flies in. Do it 4–5 times, varying speed. Point at the spectrum panel as it bends. | "The speaker is playing a 20 kHz tone you can't hear. When my hand moves toward the screen, the echo comes back slightly higher in pitch; when it moves away, lower. That's the Doppler effect, and you can see it right here. A harder push scores more, because we measure the hand's speed too." |
| 1:05–1:30 | A diagram slide: speaker → hand → mic, Δf = 2vf₀/c. Then the accuracy number. | "Everything runs in the browser. We turn off the browser's voice filters, which were erasing the ultrasound. On seventeen recordings, push and pull were recognized 81% of the time, with less than one false trigger a minute while typing." |
| 1:30–1:50 | Quick montage: kitchen, hospital, accessibility. | "No camera means privacy by design, and it works in the dark. It could serve cooks with messy hands, sterile rooms, and people who can't easily use a mouse." |
| 1:50–2:00 | The team on camera. | "Bat Ears: no camera, no extra hardware, just sound. I'm 서진, with 재윤, 서희 and 소연." |

### Live judging (30 s per judge)
1. "The camera is covered. Hold your palm about 20 cm from the screen."
2. "Push toward the screen." (meteor explodes) "Now pull back." (star flies in)
3. "That was [x] m/s." Point at the spectrum: "This bump is your hand's echo."
4. If it misfires: "It's very sensitive to body motion. Keep your elbow still and move just your palm." Lower the sensitivity in the panel if needed.

### Backup plan
- If the room is too loud or the laptop speaker struggles, lower the frequency to 19 kHz or 18 kHz with the slider.
- If nothing works, show the recorded video, then the ↑/↓ keyboard mode for the game.
- Run only one laptop with the page open: a second laptop's tone spoils detection on both (the page warns about other ultrasound).
