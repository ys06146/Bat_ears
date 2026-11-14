# Bat Ears 🦇

Touchless hand gestures with no camera: your laptop plays an inaudible ~20 kHz tone and listens to the Doppler shift of your hand's echo, like a bat. Built at MadHacks 2026.

## Run

1. Open `web/index.html` in Chrome on a laptop (double-click it or drag it into Chrome). There's nothing to install and no server to run.
2. Click **▶ 시작 (Start)**, allow the microphone, and keep your hand away for 1.5 s while it calibrates.
3. From 10–20 cm in front of the screen, push your palm toward it to blast meteors, or pull it back to grab stars. Without a mic, use the ↑ / ↓ keys.

Requirements:
- Use the built-in speaker and mic (no headphones or Bluetooth) and set the volume to 50% or more.
- The mic must run at 44.1 kHz or higher.
- The page turns off echo cancellation, noise suppression and auto gain, because Chrome removes the 20 kHz tone when they are on.

`web/batears.html` is the original single-file test page, with a band check.

## How it works

The speaker plays a 20 kHz sine (Web Audio `OscillatorNode`) and the mic feeds an `AnalyserNode` FFT (8192 points). A hand moving toward the laptop shifts its echo up in frequency, and moving away shifts it down: Δf = 2·v·f₀/c, about 58 Hz at 0.5 m/s. The engine compares the energy 25–300 Hz above the carrier with the energy 25–300 Hz below it, against a baseline calibrated at start.

## Layout

- `web/index.html`, `style.css`, `app.js`: the page and UI glue
- `web/dsp.js`: the gesture engine (its API and events are documented at the top of the file)
- `web/game.js`: the Force Push game
- `web/recorder.js`: a CSV logger for training data and accuracy tables (keys 1–5 set the label)
- `web/batears.html`: the single-file test page
- `tools/selftest/`: a synthetic test signal (20 kHz carrier plus Doppler echoes) for headless Chrome tests
- `tools/reference/`: the Python prototypes used for early measurements
- `experiments/`, `ml/`, `docs/`: added by each part (see [TEAM.md](TEAM.md))
