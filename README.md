# Bat Ears 🦇

Touchless hand gestures with no camera: your laptop plays an inaudible ~20 kHz tone and listens to the Doppler shift of your hand's echo, like a bat. Built at MadHacks 2026.

**Try it:** https://ys06146.github.io/nhng/web/ (Chrome on a laptop, built-in speaker and mic)

## Run

1. Open the link above in Chrome. You can also open `web/index.html` from a clone. There's nothing to install and no server to run.
2. Click **▶ 시작 (Start)**, allow the microphone, and keep your hand away for 1.5 s while it calibrates.
3. From 20–30 cm in front of the screen, push your palm toward it fast to blast meteors, pull it back to grab stars, or wave for a shockwave. Without a mic, use ↑ ↓ ← → and W.

Requirements:
- Use the built-in speaker and mic (no headphones or Bluetooth) and set the volume to 50% or more.
- The mic must run at 44.1 kHz or higher.
- The page turns off echo cancellation, noise suppression and auto gain, because Chrome removes the 20 kHz tone when they are on.
- Run one laptop at a time. Two laptops playing tones in the same room spoil each other, and the page warns you when it hears another device's ultrasound.

## What's in the page

| Tab | What it does |
|---|---|
| 🎮 게임 | **Force Push**: push to blast meteors, pull to grab stars, wave for a shockwave. Scoreboard and presentation mode. |
| 🛰️ 소나 뷰 | A hologram hand and a 5-second graph of hand speed, with an optional webcam view for comparison. |
| 🎯 스피드건 | A Doppler speed gun mini game: top speed, target speed, three rounds in the dark. |
| ↔ 좌우 테스트 | Experimental stereo mode (18 kHz left, 19.5 kHz right). It shows each speaker's SNR, and **🧭 좌우 점검** checks whether this laptop can tell left from right. |

Below the tabs, **🎯 데이터 수집** runs guided collection. A person drawn from behind demonstrates each gesture in time with a 3-2-1 countdown, and each prompt is scored live (✅/❌). The CSV and a JSON of conditions save into a folder automatically, and the experiment log keeps one row per run.

Other pages:

| Page | What it does |
|---|---|
| 🔐 `key.html` | **Gesture key**: a sequence of gestures is the password, your rhythm and style are the key. Enroll 1 practice + 5-10 repetitions, then unlock; the verdict says why (order, rhythm, speed, length, shape). Matcher in `web/auth.js`; attempt logs feed `python ml/auth_report.py` (FAR / FRR / EER). |
| 🧪 `experiment-live.html` | Countdown-free live experiments (free gestures, continuous push -> pull sets), a 📢 jammer mode and a one-click interference test. |
| 📢 `tone.html` | A mobile tone player, to use a phone as an extra sound source. |
| 🧪 `3d.html` | 3D hand tracking (the new main demo candidate): the I/Q phase of every source, i.e. the laptop's two speakers plus phones A (20.5 kHz) and B (21.5 kHz), solved for the hand's position. It can load a calibration fitted from teach sessions. |
| 🦇 `hologram.html` | **Sound-only hologram** (the 3D demo): the hand position from bravo's engine (`web/bat3d.js`, the same estimator as 3d.html) shown as a holographic hand in three.js, with a One Euro filter (Casiez et al., CHI 2012), a slow return to the centre (sound measures movement, not absolute position) and the honest held-out error on screen. 📂 replays a teach session; picking its `_vision.csv`, `.json` and `.calib.json` too overlays the webcam truth as a green hand (`web/vision3d.browser.js`). Sources and licenses: the ⓘ panel. |
| 📷 `teach.html` | **Teacher mode** (experimental): the webcam's MediaPipe hand landmarks mark where the hand is while the engine records the stereo features, the I/Q path changes and the raw WAV, all on one clock, during a 2.5-minute guided session. Phones running `tone.html` add sources. Files go to `ml/data/teach/` to train the audio to 3D position mapping. The camera is only for training, and no video or image is stored. |

`web/batears.html` is the original single-file test page, with a band check.

## How it works

The speaker plays a sine (Web Audio `OscillatorNode`) and the mic feeds an `AnalyserNode` FFT (8192 points, about 5.9 Hz per bin at 48 kHz). A hand moving toward the laptop shifts its echo up in frequency, and moving away shifts it down: Δf = 2·v·f₀/c, about 58 Hz at 0.5 m/s.

- **Push and pull:** adaptive noise floors on each side of the carrier, then each motion burst is judged by the direction of its **largest** hand speed. People wind up before a pull and swing back after a push, so the first threshold crossing is often the wrong direction.
- **Filters:** an impulse veto drops bursts that coincide with claps, which lift the far noise band too. It is skipped in very quiet rooms, where a fast hand's own spill would block real gestures. A burst that runs too long is body motion, and several direction flips in a short window are a wave.
- **Left and right (experimental):** a sideways hand changes its distance to the two speakers by only about a fifth of its speed, so a single frame can't tell left from right. `web/swipe.js` judges the whole burst and learns its cues per laptop in the 🧭 check. It turns left/right on only if leave-one-out scoring with the live rule passes.

## Layout

- `web/dsp.js`: the gesture engine (its API and events are documented at the top of the file)
- `web/robust.js`, `web/swipe.js`: noise floors and the impulse veto; per-burst left/right
- `web/game.js`, `speed.js`, `sonar.js`, `lr.js`: the game, speed gun, sonar view and left/right test tab
- `web/collect.js`, `coach.js`, `recorder.js`, `explog.js`: guided collection, the motion guide, the CSV logger and the experiment log
- `web/index.html`, `style.css`, `app.js`: the page and UI glue
- `ml/`: real recordings (`ml/data/`) and the Python tools
  - `python ml/report.py`: per-session accuracy table
  - `python ml/replay_burst.py`: replays the live rule on every recording
  - `python ml/train.py`: the learned classifier with leave-one-session-out scoring
- `tools/selftest/`: synthetic microphone input for headless Chrome tests. `tools/robust-tests/` and `tools/lr-tests/` hold unit tests for the detectors, and `tools/reference/` holds the early Python prototypes.
- `tools/stamp.py`: run it after changing any `.js` or `.css` file, so GitHub Pages visitors get the new version.
- `docs/`: the Devpost draft, demo script, slides and judge Q&A. [TEAM.md](TEAM.md) has roles and status.
