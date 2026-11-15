# 2-minute demo script (video and live)

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
