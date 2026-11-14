# Bat Ears: Devpost draft

> Fill in the `[TBD]` parts from the experiments (`experiments/`) and the classifier results (`ml/`). Don't claim numbers we haven't measured.

**Tagline:** Your laptop hears your hands, like a bat. Touchless gestures with no camera and no extra hardware.

## Inspiration
Bats find their way in total darkness by listening to echoes. We wondered whether an ordinary laptop could do the same with our hands. Touchless control usually means a camera, which raises privacy concerns and fails in the dark, or a special sensor nobody owns. Every laptop already has a speaker and a microphone.

## What it does
Bat Ears turns the laptop's own speaker and microphone into a gesture sensor:
- The speaker plays a steady ~20 kHz tone, which most people can't hear.
- When your hand moves toward the screen, its echo comes back slightly higher in pitch. When it moves away, the echo comes back lower. This is the Doppler effect.
- Bat Ears reads that shift dozens of times per second and recognizes a **push** or a **pull**, along with how fast your hand moved.
- We built **Force Push** on top of it: push your palm to blast incoming meteors, pull to grab stars. The webcam can stay taped over the whole time.

Everything runs inside the browser on the device. Nothing to install, no server, and no audio leaves the laptop.

## How we built it
- **Web Audio API:** an `OscillatorNode` plays the tone, and an `AnalyserNode` takes an 8192-point FFT of the mic (≈5.9 Hz per bin at 48 kHz).
- **Raw microphone:** we turn off echo cancellation, noise suppression and auto gain. We found that Chrome's voice processing erases the 20 kHz band; the level dropped from −32 dB to −179 dB in our test.
- **Doppler math:** Δf = 2·v·f₀ / c, so a hand moving at 0.5 m/s shifts a 20 kHz echo by about 58 Hz. We measure the echo energy 25–300 Hz above and below the carrier against a baseline calibrated in the first 1.5 s. A push shows up as energy above the carrier, a pull as energy below.
- **Detection:** a rule-based detector with thresholds, multi-frame confirmation and a refractory period, plus a learned classifier (softmax regression[, random forest]). The classifier uses features from each motion segment: duration, asymmetry, velocity sign changes, and the energy profile in 12 sub-bands.
- **Data tools:** an in-page recorder with live labels exports CSV, and a pure-Python pipeline does segmentation, feature extraction and leave-one-session-out evaluation.
- **Testing without a room full of noise:** we generate synthetic microphone input (a 20 kHz carrier with Doppler-shifted echoes) and run the app in headless Chrome to check every gesture end to end.
- **Game:** HTML Canvas with no dependencies.

## Challenges we ran into
- **Disappearing ultrasound:** Chrome's built-in voice processing removed the 20 kHz tone entirely until we disabled all three filters.
- **Microphone formats:** one webcam microphone ran at 16 kHz, so anything above 8 kHz simply didn't exist. We added a sample-rate check and a band check that measures which frequencies each speaker and mic pair can carry.
- **Telling gestures from everything else:** typing, leaning and people walking by also create Doppler shifts. [TBD: what helped most, e.g. asymmetry and segment duration.]
- **A loud hackathon venue:** [TBD: how the noise affected us and what we changed.]

## Accomplishments that we're proud of
- Touchless gestures from a stock laptop, entirely in a web page, with no camera.
- [TBD] accuracy for push/pull across [TBD] people and distances of 10–30 cm, with [TBD] false triggers per minute when idle.
- [TBD] The learned classifier improved over the rule-based detector from [TBD] to [TBD].

## What we learned
- The browser audio pipeline does a lot behind your back. Knowing what it filters made the difference.
- Small, well-chosen features (asymmetry, duration, velocity sign changes) go a long way on a small dataset.
- [TBD]

## What's next
- **Left and right swipes:** play two different tones from the left and right speakers.
- **In-browser classifier:** run `ml/model.json` live in the page.
- **Real uses:** cooking with messy hands, sterile environments, accessibility for people with limited mobility, and privacy-first smart devices.
- **Phones:** a phone version using its speaker and microphone.

## Built with
`javascript` · `web-audio-api` · `html5-canvas` · `python` · `signal-processing` · `machine-learning` [· `scikit-learn`]

## Team
배서진 (data and classifier, lead and pitch) · 이재윤 (signal engine) · 최서희 (game and UI) · 강소연 (experiments and thresholds)
