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
- An experimental stereo mode plays a different tone on each speaker to try for **left and right swipes**. A 90-second check tells you honestly whether your laptop can do it. Ours can't yet, so the demo sticks to push, pull and wave.
- We built **Force Push** on top of it: push your palm to blast incoming meteors, pull to grab stars, and wave for a shockwave. The webcam can stay taped over the whole time.
- A guided 2-minute **data collection** mode prompts you ("Push!") and labels everything automatically. We used it to measure accuracy and train a classifier.

Everything runs inside the browser on the device. Nothing to install and no server; the audio is analysed on the device and never sent anywhere. Only the data-collection mode, which you start yourself, saves anything, and only to a folder you pick.

Try it: https://ys06146.github.io/nhng/web/ (Chrome on a laptop, built-in speaker and mic)

## Prior work, and what's new here
The idea of hearing gestures through Doppler-shifted ultrasound isn't ours. Microsoft Research's **SoundWave** (CHI 2012) showed it on laptops, and **FingerIO** (CHI 2016) used active sonar on phones to track fingers. Some laptops also ship ultrasound **presence** detection (Elliptic Labs). Those were native research prototypes or built-in vendor features. Bat Ears is, to our knowledge, a **zero-install web page** that does it with any laptop's stock speaker and mic: open a link and wave your hand. We also handle the problems a browser adds, such as voice-processing filters that erase ultrasound and microphones that run at too low a sample rate.

## How we built it
- **Web Audio API:** an `OscillatorNode` plays the tone, and an `AnalyserNode` takes an 8192-point FFT of the mic (≈5.9 Hz per bin at 48 kHz).
- **Raw microphone:** we turn off echo cancellation, noise suppression and auto gain. We found that Chrome's voice processing erases the 20 kHz band; the level dropped from −32 dB to −179 dB in our test.
- **Doppler math:** Δf = 2·v·f₀ / c, so a hand moving at 0.5 m/s shifts a 20 kHz echo by about 58 Hz. We measure the echo energy 25–300 Hz above and below the carrier against a baseline calibrated in the first 1.5 s. A push shows up as energy above the carrier, a pull as energy below.
- **Detection:** adaptive noise floors (median/MAD) for each side of the carrier, then each motion burst is judged by the direction of its **largest** hand speed. An impulse veto drops bursts that coincide with claps or loud sounds, which lift the far noise band too. A burst that runs too long is body motion, not a gesture. A weak, slow burst right after other motion (typing, shifting in the chair) is ignored. A wave is four or more fast, alternating strokes within about a second. Every rule is mirrored in Python so we can replay real recordings and score a change against every session in seconds.
- **Another device in the room:** a second laptop running Bat Ears (or any ultrasonic beacon) spoils detection on both. The page looks for narrow peaks between 15 and 23 kHz that aren't its own tones and warns you.
- **Left/right swipes (stereo):** each speaker plays its own tone (18 kHz left, 19.5 kHz right). A sideways hand changes its distance to the two speakers in opposite ways, but only by about a fifth of its speed, so a single frame can't tell left from right. We judge the whole burst instead: the sideways speed integrated over the motion, the net change in depth, and whether the hand moved both toward and away. Each tone also reads a small speed even when nothing moves, because the noise floor around it is lopsided, so we subtract each tone's resting speed first. The cues still change from one sitting to the next, so a 2-minute guided check (6 swipes each way, 5 pushes and 5 pulls) learns them on the spot, with push/pull as a class of its own. Left/right switches on only if leave-one-out scoring with the live rule shows it works and pushes aren't mistaken for swipes.
- **Classifier:** a learned classifier (softmax regression[, random forest]) uses features from each motion segment: duration, asymmetry, velocity sign changes, and the energy profile in 12 sub-bands.
- **Data tools:** an in-page recorder with live labels exports CSV, and a pure-Python pipeline does segmentation, feature extraction and leave-one-session-out evaluation.
- **Testing without a room full of noise:** we generate synthetic microphone input (Doppler-shifted echoes of one or two carriers, extra tones for the interference warning) and run the app in headless Chrome to check every gesture end to end.
- **Guided collection:** a person drawn from behind shows each gesture in time with a 3-2-1 countdown, every prompt is scored live (✅/❌), and a session saves its CSV plus a JSON of conditions (distance, noise, device, mic, frame rate, detector settings) automatically.
- **Game:** HTML Canvas with no dependencies.

## Challenges we ran into
- **Disappearing ultrasound:** Chrome's built-in voice processing removed the 20 kHz tone entirely until we disabled all three filters.
- **Microphone formats:** one webcam microphone ran at 16 kHz, so anything above 8 kHz simply didn't exist. We added a sample-rate check and a band check that measures which frequencies each speaker and mic pair can carry.
- **People don't move the way you'd expect:** our first real recording showed that people wind up before a pull (the hand drifts forward first) and swing back after a push. A detector that trusts whichever direction crosses its threshold first caught only 3 of 20 prompted gestures. We switched to judging each motion burst by the direction of its **largest** hand speed, and the same recording went to 17 of 20 (85%). Across later sessions, slow pushes (0.6–1.0 m/s) were the main miss, so the prompt now says "fast out, slow back".
- **Telling gestures from everything else:** typing, leaning and people walking by also create Doppler shifts. A classifier trained on our labelled recordings recognizes 76% of these "other" motions (leave-one-session-out).
- **Too quiet, not too loud:** in a very quiet room the far noise band sat 80 dB under the tone, so a fast hand's own spill "raised the noise" by 6 dB and our clap veto blocked real gestures: one session scored 0 of 20. Now the veto only counts when the far band comes within 50 dB of the tone. Replaying the same recording gives 15 of 20.
- **Two laptops, one room:** while we collected data on two laptops at once, one session dropped to 1 of 20, and every gesture lifted the far band by 15–33 dB. We believe the second laptop's tones were the cause, so the page now warns when it hears someone else's ultrasound.
- **Left/right is physics, not tuning:** the obvious rule (compare the two tones' Doppler shifts frame by frame) scored at chance on our main laptop (7 of 14), because a sideways hand barely changes its distance to either speaker. Laptop audio effects (Dolby, "spatial sound") can also mix the two channels. We moved to whole-burst cues plus a per-laptop check that says plainly when a laptop can't do left/right. A second session on the same laptop showed how hard it is: within one session the cues got 15 of 20 swipes right, but the model learned in the first session got only 7 of 20 in the second (35%). One cue even flipped sign between sessions, and 9 of 20 pushes and pulls looked like right swipes. So left/right stays an experimental tab, and the demo uses push, pull and wave.
- **A loud room:** we worried that a hackathon crowd would drown the tone. On the same MacBook, a session in a room 43 dB louder in the speech band (300–4000 Hz) than our quiet sessions raised the noise next to our tones by less than 1 dB. At 60 cm it still got 14 of 20 prompts with none reversed and one false trigger while typing (19 of 20 at 55 cm in the quiet room). Talking and music live far below 18 kHz; claps are what the impulse veto is for.

## Accomplishments that we're proud of
- Touchless gestures from a stock laptop, entirely in a web page, with no camera.
- Push/pull from real recordings: 148 of 192 prompted gestures (77%) across 10 sessions at 20–35 cm, recorded on a Windows laptop and on teammates' MacBooks, or 149 of 212 (70%) if we also count the session spoiled by a second laptop. That's about 0.7 false triggers per minute while typing or idle (`python ml/report.py`). The four MacBook sessions at 20 cm got 15 to 18 of 20 each, with no push read as a pull or the other way round. [TBD: 10 cm.]
- An honest classifier result: a 5-class learned model reached 66% leave-one-session-out. It is best at rejecting non-gestures, but the rule-based burst detector is better at push vs pull, so the live app keeps the rules.

## What we learned
- The browser audio pipeline does a lot behind your back. Knowing what it filters made the difference.
- Small, well-chosen features (asymmetry, duration, velocity sign changes) go a long way on a small dataset.
- Record first, then tune: replaying every saved session through each rule change caught regressions that a single live try would have hidden.
- Check the physics before the code: left/right had to be redesigned because the signal we were thresholding was mostly not there.

## What's next
- **Left and right swipes:** measure each speaker's path length from the echo's phase, as LLAP (MobiCom 2016) does, instead of from the Doppler spectrum, and use the laptop's two microphones where the browser exposes them.
- **In-browser classifier:** run `ml/model.json` live in the page.
- **Real uses:** cooking with messy hands, sterile environments, accessibility for people with limited mobility, and privacy-first smart devices.
- **Phones:** a phone version using its speaker and microphone.

## Built with
`javascript` · `web-audio-api` · `html5-canvas` · `python` · `signal-processing` · `machine-learning` [· `scikit-learn`]

## Team
배서진 (data and classifier, lead and pitch) · 이재윤 (signal engine) · 최서희 (game and UI) · 강소연 (experiments and thresholds)
