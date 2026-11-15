# Bat Ears: Devpost draft

> Numbers are measured ones only. Main story: 3D hand tracking from sound (`web/hologram.html`, `web/3d.html`), taught by the webcam (`web/teach.html`). Supporting: push / pull / wave (Force Push), the gesture key, the left/right experiment. `[TBD]` = not measured yet; don't fill it from memory.

**Tagline:** Your laptop hears where your hand is, in 3D. Trained with a camera, runs without one.

## Inspiration
Bats find their way in the dark by listening to echoes. We wondered whether an ordinary laptop could do the same with our hands. Touchless control usually means a camera, which raises privacy concerns and fails in the dark, or a special sensor nobody owns. Every laptop already has speakers and a microphone.

## What it does
Bat Ears turns a stock laptop into a camera-free 3D hand tracker, in a web page:
- The laptop's left and right speakers each play their own inaudible tone (18 and 19.5 kHz). The laptop mic hears the echoes off your hand.
- From those echoes it follows your hand left-right, toward-away and up-down, and **`hologram.html`** draws a holographic hand that moves with yours. The webcam can stay taped over.
- **Trained with a camera, runs without one.** In one guided session of about 2½ minutes (`teach.html`), the webcam watches your hand with MediaPipe and teaches the audio tracker where your hand really is. The model learns from the landmark numbers. The raw webcam video can be kept too, for re-analysis, but only in a folder on the laptop: it is never uploaded and never committed. After that, tracking uses sound alone.
- **Measured, honestly.** We recorded 8 teach sittings and tested each one with a model trained on the other seven:
  - we predict how far the hand moves in every 250 ms from sound and compare with the webcam;
  - RMS error: **left-right 3.8 cm, toward-away 4.3 cm, up-down 2.5 cm**, while the movements themselves were 5.5 / 5.8 / 3.0 cm RMS (correlation 0.73 / 0.70 / 0.57, 9,948 windows);
  - left-right and depth follow the hand best; height is still the weak axis with the laptop speakers alone;
  - this is one person on one laptop (a Galaxy Book), hand within about 45 cm of the webcam. Other people and laptops: `[TBD]`.
- Optional phones can add sources: a phone opens `tone.html` and plays its own tone (17 kHz; iPhones can't play above about 20 kHz). We measured them, and they didn't help yet: phones beside the laptop raised height correlation by 0.05 at most, and a phone above the hand, speaker down, gave an echo path that didn't follow the hand. The demo runs on the laptop alone.
- On top of tracking: **push, pull and wave** gestures (the **Force Push** game), a **gesture key** (your sequence in your own rhythm), and an experimental left/right check.
- No install, no server. The audio is analysed on the device and never sent anywhere. The hologram shows its honest error on screen, turns amber when the hand leaves the taught zone, and runs from a local server without internet.

Try it (Chrome on a laptop, built-in speakers and mic):
- 🦇 hologram: https://ys06146.github.io/nhng/web/hologram.html
- 🧪 3D engineering view: https://ys06146.github.io/nhng/web/3d.html
- 📷 teach session: https://ys06146.github.io/nhng/web/teach.html · 📢 phone tone: https://ys06146.github.io/nhng/web/tone.html
- 🎮 Force Push and the gesture pages: https://ys06146.github.io/nhng/web/

## Prior work, and what's new here
Hearing hands with ultrasound isn't new. **SoundWave** (CHI 2012) read Doppler gestures on laptops; **FingerIO** (CHI 2016) used active sonar on phones; **LLAP** (MobiCom 2016) tracked fingers from the carrier phase, the basis of our path tracking; **CAT** (MobiCom 2016) and **MilliSonic** (CHI 2019) tracked devices with several speakers; **Strata** (MobiSys 2017), **RTrack** (MobiCom 2019), **FM-Track** (SenSys 2020), **ReflecTrack** (UIST 2021) and **Beyond-Voice** (2023) pushed device-free and 3D tracking. They report millimetre-level results with native code, research hardware or mic arrays.
What's new for us: **a web page on a stock laptop** (optional ordinary phones), **no install and no server**, and **the camera as a teacher only**: a short webcam session gives 3D labels for training, then the camera is off. We report centimetre-level movement errors with height still weak, and that is the trade-off for zero setup.

## How we built it
- **One tone per source, one mic.** Each source gets its own carrier: 18 / 19.5 kHz on the laptop's left and right speakers (a Web Audio `ChannelMergerNode`), 17 / 18.75 kHz on phones. The mic is opened raw: we turn off echo cancellation, noise suppression and auto gain, because Chrome's voice processing erases ultrasound (−32 dB → −179 dB in our test).
- **Phase ranging in an AudioWorklet.** Each carrier is mixed down to I/Q, low-pass filtered (250 Hz) and decimated to about 1 kHz. The static part (direct sound and room reflections) is removed and the phase is unwrapped into path-length steps, as LLAP does: about 1.8 cm of path per turn at 19 kHz. Phone tones run on their own clocks, so a phase-locked loop on the direct phone-to-mic sound cancels their drift.
- **From path changes to 3D.** Each speaker → hand → mic path is one constraint, and two laptop speakers can't pin down a 3D point by geometry alone. A **linear (ridge) map**, trained against the webcam, turns the path changes of all streams into the hand's movement over 250 ms windows; a geometric least-squares solver is the fallback.
- **The webcam teacher (`teach.html`).** MediaPipe HandLandmarker (tasks-vision, in the browser) gives 21 landmarks per frame, plus world landmarks in metres, on the same `performance.now()` clock as the raw stereo WAV. A guided 2½-minute session (still, left-right, up-down, toward-away, flat and upright circles both ways, push, pull, wave, free motion) covers the space. Offline, the landmarks are placed in the laptop's frame (PnP with the webcam's field of view, fitted per session) and the map is fitted. The live page only has time for about 19 of the camera's 30 frames a second, so the raw video it keeps locally can be re-read offline, frame by frame (WebCodecs and the same model): 4,393 labelled frames instead of 2,809 in one sitting, matched to the audio clock within 3 ms.
- **Size correction.** A least-squares map draws each movement at about (correlation × true size), so the weak axis looked shrunken: height at 57 %. A square-root correction draws 83 / 83 / 75 % of true size (left-right / depth / height) at almost the same error; a "true size" mode draws ~100 % for 7-10 % more error. In real use a shrunken height still looked frozen, so the hologram draws height at its true size by default: 2.7 cm of height error instead of 2.5, shown on screen.
- **The hologram (`hologram.html`).** Sound gives movement, not absolute position, so the hand is re-centred by a 2 s spring (on a replayed sitting it kept the drawn hand 44 % closer to the webcam truth than a 6 s spring, at the same 250 ms correlation) and smoothed by a **One Euro filter** (Casiez et al., CHI 2012). When the drawn hand leaves the taught zone it turns amber. three.js is bundled with the page, so it also runs from a local server without internet. three.js draws the hand, with UnrealBloom glow, a trail and an error ellipsoid of the honest RMS per axis. A replay mode overlays the webcam truth (a green hand) on a recorded session.
- **Honest evaluation:** leave-one-sitting-out across 8 sittings for 3D, leave-one-session-out across 17 sessions for gestures. Every live rule is mirrored offline so we can replay all recordings after each change.
- **Testing:** synthetic microphone input and a synthetic hand video run through headless Chrome; recorded sessions are replayed against the camera labels.

## Challenges we ran into
- **Phones didn't add height.** We expected a phone above the hand to fix the weak axis. Its echo path didn't follow the hand at all, and phones beside the laptop added at most 0.05 to height correlation, so the demo runs on the laptop alone.
- **Phones can't play ultrasound high enough.** Our first phone tones (20.5 / 21.5 kHz) simply weren't in the recordings: iPhone speakers stop around 20 kHz. We moved them to 17 and 18.75 kHz, between and below the laptop's tones.
- **A quiet tone draws a small hand.** The hologram first played its tones 7.6 dB quieter than the teach sessions. Fewer phase steps passed the noise gate, and the map drew every movement too small. Matching the teach volume fixed it; the page now warns when the tone arrives 4 dB under the quietest teach sitting, and when it hears another ultrasonic tone (a forgotten tab's 20 kHz, a phone's 375 Hz hum) or another Bat Ears tab.
- **The weak axis looks frozen.** Height has little information with two speakers side by side, and a least-squares map shrinks what it isn't sure about. The size correction makes it visible without hiding the error.
- **A phone next to the laptop adds a hum.** All three sittings with a phone above the laptop show a 375 Hz modulation on the laptop's own tones, and none of the others do. We keep phones away from the laptop for the demo.
- **A stray tone in the room.** For hours every recording had a strong 20 kHz tone: an old Bat Ears tab still running. The pages now list the ultrasonic peaks they hear and name that case.
- **Disappearing ultrasound, again.** Chrome's voice processing removed the tone until we disabled all three filters.
- **People don't move the way you'd expect:** they wind up before a pull and swing back after a push. Judging each motion burst by its **largest** speed instead of its first threshold crossing took a detector from 3 of 20 to 17 of 20.
- **Left/right is physics, not tuning:** a sideways hand barely changes its distance to either speaker. Within a session our cues got 15 of 20 swipes, but only 7 of 20 on the next session, so left/right stays an experiment. Phase tracking in 3D is our answer to it.

## Accomplishments that we're proud of
- Camera-free 3D hand tracking from a stock laptop, in a web page, taught by its own webcam in 2½ minutes: on sittings the model never saw (leave-one-sitting-out over 8 sittings, hand within about 45 cm of the webcam), the RMS error of 250 ms movements is left-right 3.8 / toward-away 4.3 / up-down 2.5 cm, against movements of 5.5 / 5.8 / 3.0 cm.
- Push/pull from real recordings: 268 of 332 prompted gestures (81 %) across 17 sessions at 20-60 cm, on a Windows laptop and MacBooks, with about 0.6 false triggers per minute while typing or idle (`python ml/report.py`).
- Honest numbers on screen: the hologram shows its held-out error and the size it draws, and the replay mode shows the webcam truth next to the sound.

## What we learned
- The browser audio pipeline does a lot behind your back; knowing what it filters made the difference.
- A camera is a great teacher for a sensor it then doesn't need.
- A least-squares map draws motion at (correlation × true size). Weak axes look frozen, and that's information, not a bug.
- Record first, then tune: replaying every saved session after each change caught regressions a live try would hide.

## What's next
- **Height:** our first phone placements didn't add height, so next is a better source layout and teach sessions in more postures.
- **More people and laptops:** we have one person on one laptop so far.
- **Absolute position:** anchor the drift with the direct-path phase and short re-teach moments.
- **Uses:** cooking with messy hands, sterile rooms, accessibility, and privacy-first smart devices.

## Built with
`javascript` · `web-audio-api` · `audioworklet` · `three.js` · `mediapipe` · `webcodecs` · `html5-canvas` · `python` · `signal-processing` · `machine-learning`

## Team
배서진 (data and classifier, lead and pitch) · 이재윤 (signal engine) · 최서희 (game and UI) · 강소연 (experiments and thresholds)
