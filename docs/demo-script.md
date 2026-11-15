# 2-minute demo script (video and live)

## Main candidate: Bat Ears 3D (`web/3d.html`)

Before judging (once):
1. Phones run `web/tone.html`. iPhones can't play above about 20 kHz.
   - ⬇️ Overhead (bravo's recommendation, for height): 📱A **17000 Hz** straight above the hand spot, at the laptop's centre line, 30 cm in front of the hinge and 45 cm above the desk. Stand it upright with the bottom speaker pointing down at the hand, fixed to a stand, a selfie stick or a lamp arm. It stays out of the webcam's view. 📱B (18750 Hz) is optional (left side, 40 cm high, full volume).
   - ↔ Side (first plan): 📱A 17000 Hz on the right (25 cm right, 25 cm high), 📱B 18750 Hz on the left (25 cm left, 40 cm high), both facing the hand, B at full volume.
2. Close every other Bat Ears tab and laptop. A stray 20 kHz tone sat right next to the laptop's 19.5 kHz band in all three teach sessions.
3. Open `web/teach.html`, press ①, and use the preview to find the hand spot: above the laptop's front edge, 18-25 cm above the desk, '📏 웹캠에서 25~45cm' green. **Mark it on the desk with tape.** The calibration was learned in that range.
4. Re-teach (② session, about 2.5 min) only if the laptop or the room changed. The Galaxy Book calibration from four sittings is built into 3d.html.

Live (30 s per judge):
1. Tape over the webcam. Open `web/3d.html` and press ▶ 마이크로 시작 (기본 보정 and 학습 지도 are on by default).
2. Hand over the tape mark, press ◎ 원점, then move left/right and toward/away (keep up/down small). The dot follows. It adds up 250 ms movements, so it slowly drifts: bring the hand back to the mark and press ◎ 원점 again.
3. Honest numbers on screen: x ±4.0 · y ±3.1 · z ±4.5 cm. That's the RMS error of the hand's 250 ms movement on a sitting the model never saw (four webcam-taught sittings, each left out once; laptop speakers only, hand 25-45 cm from the webcam). For scale, the movements themselves were 7.0 / 3.6 / 6.4 cm RMS. Left-right (r 0.82) and depth (0.72) track well; height (0.47) is still weak with the laptop speakers alone. With the phones it needs that session's calibration file (📥), otherwise it falls back to the physics solver.
4. Fallback: the Force Push game below.

## Fallback: Force Push (`web/index.html`)

Setup: laptop on the table, volume ≥ 50%, built-in speaker and mic, tape over the webcam, `web/index.html` open and ▶ already started (calibrated).

| Time | Show | Say |
|---|---|---|
| 0:00–0:10 | Put tape over the webcam on camera. | "What if your laptop could see your hands without a camera? Like a bat." |
| 0:10–0:25 | A short shot of someone cooking with messy hands, or a dark room (optional). | "Touchless control today needs a camera, which has privacy issues and fails in the dark, or extra hardware. Every laptop already has a speaker and a mic." |
| 0:25–1:05 | Live: push your palm toward the screen and a meteor explodes. Pull, and a star flies in. Do it 4–5 times, varying speed. Point at the spectrum panel as it bends. | "The speaker is playing a 20 kHz tone you can't hear. When my hand moves toward the screen, the echo comes back slightly higher in pitch; when it moves away, lower. That's the Doppler effect, and you can see it right here. A harder push scores more, because we measure the hand's speed too." |
| 1:05–1:30 | A diagram slide: speaker → hand → mic, Δf = 2vf₀/c. Then the confusion matrix or accuracy number. | "Everything runs in the browser. We turn off the browser's voice filters, which were erasing the ultrasound. Then we read an FFT about 60 times a second and classify each motion. On seventeen recordings, push and pull were recognized 81% of the time, with less than one false trigger a minute while typing." |
| 1:30–1:50 | Quick montage: kitchen, hospital, accessibility. | "No camera means privacy by design, and it works in the dark. It could serve cooks with messy hands, sterile rooms, and people who can't easily use a mouse." |
| 1:50–2:00 | The team on camera. | "Bat Ears: no camera, no extra hardware, just sound. I'm 서진, with 재윤, 서희 and 소연." |

## Live judging (30 s per judge)
1. "The camera is covered. Hold your palm about 20 cm from the screen."
2. "Push toward the screen." (meteor explodes) "Now pull back." (star flies in)
3. "That was [x] m/s." Point at the spectrum: "This bump is your hand's echo."
4. If it misfires: "It's very sensitive to body motion. Keep your elbow still and move just your palm." Lower the sensitivity in the panel if needed.

## Backup plan
- If the room is too loud or the laptop speaker struggles, lower the frequency to 19 kHz or 18 kHz with the slider.
- If nothing works, show the recorded video, then the ↑/↓ keyboard mode for the game.
- Run only one laptop with the page open: a second laptop's tone spoils detection on both (the page warns about other ultrasound).
