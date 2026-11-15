# Team roles and to-dos (MadHacks 2026 · Bat Ears)

🌐 Site: https://ys06146.github.io/nhng/web/ · 🧭 Owner: Alpha (AI teammate) looks after code, docs and progress, and reports in #alpha

## Status (11/15 10:50 CST)
- 🧊 **The main feature is 3D hand tracking, including height** (Seojin's decision, 11/15 03:15). 🦇 `web/hologram.html` is the demo screen, and 🧪 `web/3d.html` is the engineering screen. The push/pull/wave game stays as the proven fallback demo, and the gesture key is a supporting feature
  - Sound sources: the laptop's 18/19.5 kHz stereo is the default. 📱 Phones (`tone.html`, A 17 kHz · B 18.75 kHz; iPhones can't play above 20 kHz) are experimental. A phone at the side raised height correlation by 0.05 or less, and a phone placed above the hand, pointing down, gave a path that didn't follow the hand (Bravo's analysis)
  - 🦇 **Sound hologram** `web/hologram.html` (demo screen): shows the hand's position as a hologram hand from sound alone, with no webcam. Bravo's engine (`web/bat3d.js`) + One Euro filter + three.js glow. 📂 replays a teach session so you can compare with the webcam ground truth (green hand). Accuracy is shown honestly on screen
  - 📷 **Teacher mode** `web/teach.html`: records the laptop webcam's MediaPipe hand joints (ground truth) together with the stereo sound features, I/Q and raw WAV on the same clock, for about 2 min 30 s (still → left-right, up-down, toward-away → horizontal and vertical circles → push and pull → wave → free). It saves to `ml/data/teach/`, and Bravo learns sound → 3D position (`teach_fit.js` → `<session>.calib.json`, loaded by 3d.html). The camera is used only for teaching and is off in the demo. 📹 The raw video is saved by default in the same folder as `.webm` (+ frame times `_frames.csv`). It stays on this computer only and `.gitignore` keeps it out of git
  - Layout: screen almost upright (about 95°), hand 18–25 cm above the desk and 15–30 cm in front of the screen. Stretches where the webcam can't see the hand have no ground truth and are dropped
  - Measured (Bravo; 17 sittings, 8 teach + 9 compare, each held out in turn as the test, laptop only, hand within about 45 cm of the webcam, 250 ms movement): gated neural map (default since 11:52, retrained 12:43) error left-right 3.3 · toward-away 4.2 · height 2.9 cm; actual movement 5.2 · 5.7 · 3.6 cm; correlation 0.78 · 0.70 · 0.62 (the linear v15 map: 0.74 · 0.70 · 0.59 on the first 15). The screen draws movement at 90 · 85 % (left-right · depth) and height at true size
- The push/pull/wave game is the proven feature we locked in as the demo at 11/14 21:15. Left/right stays an experimental tab only
- 🔐 **Gesture key** (`web/key.html`, early 11/15): the order of moves is the password, and your own rhythm, speed and shape are the key. Enrollment is 1 practice + 5–10 repetitions, and unlocking shows ✅/❌ with the reason (order, rhythm, speed, length, shape)
  - Decision: `web/auth.js` (Bravo v2: rhythm is measured at the centre time of each move; the threshold is the median of the enrollment repetitions + 3·MAD). Consecutive moves are each caught separately by the engine's "continuous gesture mode"
  - Evaluation: each attempt is saved to `ml/data/batears_auth_<device>.json`, and `python ml/auth_report.py` gives FAR, FRR and EER (Charlie's protocol: 10 genuine attempts, 10 by someone who knows the order)
  - Measured: on Seojin's Galaxy Book, all 3 attempts where every move was caught passed (0.84, 0.85, 1.40). Circle tokens 🔃/🔄 are only on with `key.html?circles=1` (Bravo offline 18/20)
- Experiment pages: 🧪 `experiment-live.html` (experiments without a countdown, Soyeon and Jaeyun, 📢 jamming mode and 🧪 interference test) · 📢 `tone.html` (phone tone player) · 🧪 `3d.html` (Bravo's 3D experiment, phone sources)
- Interference test (11/15 01:40): jamming on the same 20 kHz causes many false detections. Automatic avoidance couldn't find a substitute frequency, so it's off on the demo page. Run only one device during the demo
- Features: push and pull (burst decision), wave (shockwave), sonar view (hologram and 5-second graph), 🎯 guided data collection (auto-save to Drive, automatic metadata, a figure demonstrating each gesture `web/coach.js`), ↔ left/right test tab, experiment log (Seohee), Force Push game, speed gun
- Left/right swipes: Bravo's `web/swipe.js` v2 (whole-burst ilat·balDelta + per-laptop learning) and `🧭 Left/right check`. Seojin's Galaxy Book second run (20:58, 20 swipes + 20 pushes/pulls) got 75% of swipes within the same session, but the model learned in the first run got 35%, and it read 9 of 20 pushes/pulls as left/right. balDelta flipped sign between sessions
  - Bonus goal (Bravo, by 11/15 08:00): if it reaches 70% or more on unseen data, with no more than 2 of 20 pushes/pulls misread, it goes into the demo as a bonus. To test Charlie's suggestion of phase integration (LLAP-style), Alpha is making the check also save the raw mic audio
- A warning appears when another device's ultrasound is heard (two laptops running together spoil each other). 18.8 kHz was picked up once in the 20:58 session (cause unconfirmed)
- Real data: 18 push/pull sessions (20 cm ×7 · 30 cm ×4 · 35 cm ×1 · 55 cm ×1 · 60 cm ×5, on Seojin's Windows laptop and teammates' MacBooks) + 6 left/right check sessions, in `ml/data/`. Teammates save straight into the shared Drive folder. WAVs don't go into git; Alpha backs them up to work\batears\wav_backup
- Results (`python ml/report.py`, 23:55): push/pull 268 of 332 (81%), 0.6 false triggers per minute, 12 in the wrong direction. Including the spoiled 16:44 session, 269 of 352 (76%). MacBook Air: 19/20 at 55 cm, 86/100 over five sessions at 60 cm. In a noisy room (speech band 43 dB louder), the noise next to the tone rose by less than 1 dB
- Decision log
  - People push the hand forward before pulling, and come back after pushing. So we judge by "the direction of the fastest speed within the movement"
  - In a quiet room the impulse veto blocked real gestures too (MacBook 35 cm 0/20). We changed it so it doesn't veto when the far band is more than 50 dB below the tone (`config.burst.vetoSnrDb`, same session 15/20)
  - Two laptops running at once mix their ultrasound. Collection and demos use only one at a time

## Milestones
| Time (CST) | Goal |
|---|---|
| 11/14 22:00 | **MVP**: game and sonar view demo on a real laptop · accuracy table from 3+ sessions · Devpost draft 80% |
| 11/15 08:00–10:30 | 2-minute video, slides, rehearsal |
| 11/15 11:30 | **Devpost submission**: repo and site links, video |
| 11/15 13:00 | Judging demo |

## To-do checklist (check off and commit when done)

### Jaeyun Lee · signal processing and gesture engine (`web/dsp.js`, branch `dsp-continuous-pull`)
- [ ] When new guided-collection CSVs come in, compare the default with the candidate using `python ml/replay_burst.py <validation CSV> --candidate 8 0.9 1.1`, and if adopted, update `config.burst` and the Python defaults together.
  The current candidate went from 62/103 → 64/103 on the earlier 6 sessions, wrong direction 9 → 11, with false triggers unchanged at 2.4/min. On the latest 2 sessions it went 6/12 → 8/12, with wrong direction unchanged at 1. Given the extra wrong-direction calls and the small validation sample, we kept the default.
- [ ] On the demo laptop, train with **🧭 Left/right check** (left/right 6+6, push/pull 5+5) and record correct, wrong-direction and held results on new moves. If wrong-direction repeats, check the collection direction and retrain. Retrain whenever the frequency pair changes too.
- [x] At start, measure outside tones with our tone off, and exclude those FFT bins from the Doppler calculation for calibration and detection. `BatEars.config.maskForeignTones = false` allows comparison from the next start.
- [x] When a single tone starts with interference in the requested band, try candidates, recheck the chosen band with no output, then calibrate. Automatic volume uses the current setting as its ceiling. Turning off **single-tone interference auto-avoid** in free experiment mode allows comparison on the same device.
- [x] In free experiment mode, **continuous Push→Pull** detects the follow-up Pull from the opposite-direction Doppler and displacement after a Push. With I/Q, a weak Pull is also confirmed if the path grows enough after reversal; without I/Q, it needs strong FFT evidence. An experiment checkbox turns the feature off for comparison.
- [ ] Test sequential and simultaneous starts on two real laptops on the same frequency, recording chosen frequency, volume and start time. At the same distance, record frontal and diagonal continuous Push→Pull, Push followed by a normal return, and waves, and compare detection and misreads with correction on and off.

### Seohee Choi · game and UI (`web/game.js`, `index.html`, `app.js`, `style.css`, branch `game`)
- [x] Start overlay: "Cover the webcam → ▶ Start → keep your hand away for 1.5 s"
- [x] Sound effects: short, quiet synthesized sounds below 8 kHz (so they don't disturb ultrasonic sensing)
- [x] Scoreboard: name entry + top 10 (localStorage)
- [x] Presentation screen: full-screen button, large text
- [x] (Extra) 🎯 Doppler speed gun mini game: top speed · target speed · three rounds in the dark, Doppler math shown, name + top 10

### Soyeon Kang · experiments, accuracy and thresholds (`experiments/`, branch `exp`)
- [ ] Run 🎯 Data collection at 10, 20 and 30 cm × 2 or more people (auto-saves to Drive nhng/ml/data)
- [ ] Build the `experiments/results.md` table from `python ml/replay_burst.py` · `python ml/train.py`: hit rate by distance and person, wrong direction, false triggers per minute, 95% confidence intervals
- [ ] Latency: roughly measure, on the sonar view graph, the time from when the hand starts moving to the detection line

### Seojin Bae · data and classification, lead and pitch (`ml/`, `docs/`, branch `ml`)
- [x] Collect 1 real-data session
- [ ] Fill the [TBD]s in `docs/devpost.md` from Soyeon's results table
- [ ] Film the 2-minute video (`docs/demo-script.md`), slides (`docs/slides.md`)
- [ ] Practise the expected questions (`docs/judge-qa.md`)
- [ ] Submit to Devpost before 11:30

### Alpha (AI teammate)
- [x] Burst detection, sonar view, data collection and auto-save, analysis tools, doc drafts, merged Bravo's robust.js
- [x] Accuracy table `ml/report.py` (push/pull + left/right, same session / unseen data), README update, merged Charlie's pitch material into `docs/pitch.md`
- [ ] Save raw mic WAV during the left/right check (for offline testing of the phase method)
- [ ] Analyse new data automatically when it arrives and report to Edith
- [ ] 22:00 MVP check, final check before the deadline (links, README, rehearsal checklist)

## Rules
- Keep `main` demoable at all times (the site deploys straight from main). Work on your own branch, check it on a laptop, then merge into `main`.
- Only edit your own part's files. Talk to the game/UI owner before changing shared files (`index.html`, `app.js`).
- The engine and the game connect only through the `BatEars.on('gesture', ...)` event (see the comment at the top of `web/dsp.js`). When developing without a mic: ↑ push, ↓ pull, ← → swipe, W wave.
- Testing: `tools/selftest/make_wav.py` makes fake microphone audio to run in headless Chrome. `tools/robust-tests/` holds the detector unit tests.
- If you changed `.js` or `.css`, run `python tools/stamp.py` before committing. GitHub Pages caches files for 10 minutes, so without it people get old code.
- Put large files like video on Drive instead of git. Don't commit secrets (.env, keys) or personal contact details.
