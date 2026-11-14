# Bat Ears: Devpost draft

> Fill in the `[TBD]` parts from the experiments (`experiments/`) and the classifier results (`ml/`). Don't claim numbers we haven't measured.

**Tagline:** Your laptop hears your hands, like a bat. Touchless gestures with no camera and no extra hardware.

## Inspiration
Bats find their way in total darkness by listening to echoes. We wondered whether an ordinary laptop could do the same with our hands. Touchless control usually means a camera, which raises privacy concerns and fails in the dark, or a special sensor nobody owns. Every laptop already has a speaker and a microphone.

## What it does
Bat Ears turns the laptop's own speaker and microphone into a gesture sensor:
- The speaker plays a steady ~20 kHz tone, which most people can't hear.
- When your hand moves toward the screen, its echo comes back slightly higher in pitch. When it moves away, the echo comes back lower. This is the Doppler effect.
- Bat Ears reads that shift about 60 times per second and recognizes a **push**, a **pull** and a **wave**, along with how fast your hand moved.
- In an experimental stereo mode, the left and right speakers play different tones, which adds **left and right swipes**.
- We built **Force Push** on top of it: push your palm to blast incoming meteors, pull to grab stars, wave for a shockwave, and swipe to slash. The webcam can stay taped over the whole time.
- A guided 2-minute **data collection** mode prompts you ("Push!") and labels everything automatically. We used it to measure accuracy and train a classifier.

Everything runs inside the browser on the device. Nothing to install and no server; the audio is analysed on the device and never recorded or sent anywhere.

Try it: https://ys06146.github.io/nhng/web/ (Chrome on a laptop, built-in speaker and mic)

## Prior work, and what's new here
The idea of hearing gestures through Doppler-shifted ultrasound isn't ours. Microsoft Research's **SoundWave** (CHI 2012) showed it on laptops, and **FingerIO** (CHI 2016) used active sonar on phones to track fingers. Some laptops also ship ultrasound **presence** detection (Elliptic Labs). Those were native research prototypes or built-in vendor features. Bat Ears is, to our knowledge, a **zero-install web page** that does it with any laptop's stock speaker and mic: open a link and wave your hand. We also handle the problems a browser adds, such as voice-processing filters that erase ultrasound and microphones that run at too low a sample rate.

## How we built it
- **Web Audio API:** an `OscillatorNode` plays the tone, and an `AnalyserNode` takes an 8192-point FFT of the mic (≈5.9 Hz per bin at 48 kHz).
- **Raw microphone:** we turn off echo cancellation, noise suppression and auto gain. We found that Chrome's voice processing erases the 20 kHz band; the level dropped from −32 dB to −179 dB in our test.
- **Doppler math:** Δf = 2·v·f₀ / c, so a hand moving at 0.5 m/s shifts a 20 kHz echo by about 58 Hz. We measure the echo energy 25–300 Hz above and below the carrier against a baseline calibrated in the first 1.5 s. A push shows up as energy above the carrier, a pull as energy below.
- **Detection:** a rule-based detector with multi-frame confirmation and a refractory period. Its thresholds adapt to how much the room's echo wobbles while idle. Broadband noise (claps, crowd) is cancelled by subtracting the rise of the far noise floor, since a hand echo only lifts the bands next to the carrier. A wave is several direction flips within a second.
- **Left/right swipes (stereo):** each speaker plays its own tone (18 kHz left, 19.5 kHz right). Moving right shifts the left tone down and the right tone up, and moving left does the opposite.
- **Classifier:** a learned classifier (softmax regression[, random forest]) uses features from each motion segment: duration, asymmetry, velocity sign changes, and the energy profile in 12 sub-bands.
- **Data tools:** an in-page recorder with live labels exports CSV, and a pure-Python pipeline does segmentation, feature extraction and leave-one-session-out evaluation.
- **Testing without a room full of noise:** we generate synthetic microphone input (a 20 kHz carrier with Doppler-shifted echoes) and run the app in headless Chrome to check every gesture end to end.
- **Game:** HTML Canvas with no dependencies.

## Challenges we ran into
- **Disappearing ultrasound:** Chrome's built-in voice processing removed the 20 kHz tone entirely until we disabled all three filters.
- **Microphone formats:** one webcam microphone ran at 16 kHz, so anything above 8 kHz simply didn't exist. We added a sample-rate check and a band check that measures which frequencies each speaker and mic pair can carry.
- **People don't move the way you'd expect:** our first real recording showed that people wind up before a pull (the hand drifts forward first) and swing back after a push. A detector that trusts whichever direction crosses its threshold first caught only 3 of 20 prompted gestures. We switched to judging each motion burst by the direction of its **largest** hand speed, and the same recording went to 17 of 20 (85%), with false triggers while typing falling from 12 to 4.5 per minute. [TBD: confirm across more sessions.]
- **Telling gestures from everything else:** typing, leaning and people walking by also create Doppler shifts. A classifier trained on our labelled recordings recognizes 85% of these "other" motions. Bravo's impulse veto drops bursts that coincide with claps or loud sounds.
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
