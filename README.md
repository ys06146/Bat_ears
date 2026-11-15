# Bat Ears 🦇

Your laptop hears where your hand is, in 3D, with no camera. Its two speakers play inaudible tones (18 and 19.5 kHz), the mic follows how each echo path to your hand stretches and shrinks, and a map taught once by the webcam (2½ minutes, MediaPipe) turns that into 3D hand movement. Trained with a camera, runs without one. Built at MadHacks 2026.

**Try it** (Chrome on a laptop, built-in speakers and mic):
- 🦇 main demo, the sound-only hologram: https://ys06146.github.io/nhng/web/hologram.html
- 🎮 Force Push and the gesture pages: https://ys06146.github.io/nhng/web/

**Honest numbers:** on sittings the model never saw (13 webcam-taught sittings: 8 guided teach sessions and 5 live comparison sessions; leave-one-sitting-out, laptop speakers only, hand within about 45 cm of the webcam), the RMS error of the hand's 250 ms movement is left-right 3.4 / toward-away 4.2 / up-down 2.8 cm, against movements of 5.3 / 5.8 / 3.6 cm (correlation 0.78 / 0.70 / 0.60). The default engine is a small gated neural map; the linear map it replaced scored 0.75 / 0.70 / 0.57 on the same sittings (`?model=learned` shows it). Height is the weak axis. One person, one laptop so far.

## Run

### 3D hologram (main demo)
1. Tape over the webcam (the page never opens it). Open `hologram.html` in Chrome, with the built-in speakers and mic at 50 % volume or more.
2. Press **▶ Start** and allow the microphone. Hold your hand over the laptop's front edge, about 20 cm up, press **◎** (space), then move it left-right and toward-away briskly.
3. If the hand turns amber it has left the taught zone: come back and press ◎. Sound measures movement, not position, so the hand drifts back to the centre when you stop.
4. No internet: run `python -m http.server 8000` in `web/` and open http://localhost:8000/hologram.html (three.js is bundled).

### Force Push (gestures)
1. Open https://ys06146.github.io/nhng/web/ in Chrome. You can also open `web/index.html` from a clone. There's nothing to install and no server to run.
2. Click **▶ Start**, allow the microphone, and keep your hand away for 1.5 s while it calibrates.
3. From 20–30 cm in front of the screen, push your palm toward it fast to blast meteors, pull it back to grab stars, or wave for a shockwave. Without a mic, use ↑ ↓ ← → and W.

Requirements:
- Use the built-in speaker and mic (no headphones or Bluetooth) and set the volume to 50% or more.
- The mic must run at 44.1 kHz or higher.
- The page turns off echo cancellation, noise suppression and auto gain, because Chrome removes the 20 kHz tone when they are on.
- Run one laptop at a time. Two laptops playing tones in the same room spoil each other, and the page warns you when it hears another device's ultrasound.

## What's in the page

| Tab | What it does |
|---|---|
| 🎮 Game | **Force Push**: push to blast meteors, pull to grab stars, wave for a shockwave. Scoreboard and presentation mode. |
| 🛰️ Sonar view | A hologram hand and a 5-second graph of hand speed, with an optional webcam view for comparison. |
| 🎯 Speed gun | A Doppler speed gun mini game: top speed, target speed, three rounds in the dark. |
| ↔ Left/right test | Experimental stereo mode (18 kHz left, 19.5 kHz right). It shows each speaker's SNR, and **🧭 Left/right check** checks whether this laptop can tell left from right. |

Below the tabs, **🎯 Data collection** runs guided collection. A person drawn from behind demonstrates each gesture in time with a 3-2-1 countdown, and each prompt is scored live (✅/❌). The CSV and a JSON of conditions save into a folder automatically, and the experiment log keeps one row per run.

Other pages:

| Page | What it does |
|---|---|
| 🔐 `key.html` | **Gesture key**: a sequence of gestures is the password, your rhythm and style are the key. Enroll 1 practice + 5-10 repetitions, then unlock; the verdict says why (order, rhythm, speed, length, shape). Matcher in `web/auth.js`; attempt logs feed `python ml/auth_report.py` (FAR / FRR / EER). |
| 🧪 `experiment-live.html` | Countdown-free live experiments (free gestures, continuous push -> pull sets), a 📢 jammer mode and a one-click interference test. |
| 📢 `tone.html` | A mobile tone player, to use a phone as an extra sound source. |
| 🧪 `3d.html` | 3D hand tracking, the engineering view behind the hologram: the I/Q phase of every source (the laptop's two speakers; optional phones A 17 kHz and B 18.75 kHz, an experiment that didn't add accuracy yet) mapped to the hand's movement by a calibration fitted on 8 webcam-taught sittings. |
| 🦇 `hologram.html` | **Sound-only hologram** (the 3D demo): the hand position from bravo's engine (`web/bat3d.js`, the same estimator as 3d.html) shown as a holographic hand in three.js, with a One Euro filter (Casiez et al., CHI 2012), a slow return to the centre (sound measures movement, not absolute position) and the honest held-out error on screen. 📂 replays a teach session; picking its `_vision.csv`, `.json` and `.calib.json` too overlays the webcam truth as a green hand (`web/vision3d.browser.js`). Sources and licenses: the ⓘ panel. |
| 📷 `teach.html` | **Teacher mode** (experimental): the webcam's MediaPipe hand landmarks mark where the hand is while the engine records the stereo features, the I/Q path changes and the raw WAV, all on one clock, during a 2.5-minute guided session. Phones running `tone.html` can add sources (experimental). Files go to `ml/data/teach/` to train the audio to 3D position mapping. The camera is only for training. 📹 By default the raw webcam video is saved there too (`<session>.webm` plus `<session>_frames.csv`, every frame's time on the session clock) for re-analysis; it stays on the laptop, and `.gitignore` keeps it out of the repo. |

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
- `web/bat3d.js` (bravo's 3D engine), `web/hologram.html`, `web/3d.html`, `web/teach.html`, `web/vision3d.browser.js`: the 3D tracker, its pages, the webcam teacher and the webcam-to-laptop geometry
- `ml/`: real recordings (`ml/data/`) and the Python tools
  - `python ml/report.py`: per-session accuracy table
  - `python ml/replay_burst.py`: replays the live rule on every recording
  - `python ml/train.py`: the learned classifier with leave-one-session-out scoring
- `tools/selftest/`: synthetic microphone input for headless Chrome tests. `tools/robust-tests/` and `tools/lr-tests/` hold unit tests for the detectors, and `tools/reference/` holds the early Python prototypes.
- `tools/bravo/`: the offline 3D analysis (calibration fits, leave-one-sitting-out tests).
- `tools/vision_full/`: every-frame hand labels from a teach session's local video (WebCodecs and MediaPipe in headless Chrome).
- `tools/stamp.py`: run it after changing any `.js` or `.css` file, so GitHub Pages visitors get the new version.
- `docs/`: the Devpost draft, demo script, slides and judge Q&A. [TEAM.md](TEAM.md) has roles and status.
