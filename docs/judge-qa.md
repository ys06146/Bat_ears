# Judge Q&A prep

Short answers to say out loud. [TBD] = fill in from our measurements (`python ml/train.py` prints them from guided-collection recordings).

1. **How accurate is it?**
   Across 10 guided recordings on a Windows laptop and MacBooks at 20–35 cm, 148 of 192 prompted pushes and pulls were recognized within 1.5 s (77%), with about 0.7 false triggers per minute while typing or sitting idle. Our MacBook sessions at 20 cm got 15 to 18 of 20 each. Our first detector got only 15%, because people wind up before a pull. For reference, SoundWave (Microsoft Research, CHI 2012) reported over 90% on its gesture set with native code.
2. **Does it work in a loud room like this one?**
   Speech and music sit mostly far below 20 kHz, and we only look a few hundred Hz around our tone. We measured it: in a room 43 dB louder in the speech band, the noise next to our tones rose by less than 1 dB, and a MacBook at 60 cm got 33 of 40 prompts over two noisy sessions with none reversed (17 of 20 in the quiet room). For loud broadband noise like claps, we subtract the rise of the noise floor measured farther away, because a hand echo only lifts the bands right next to the tone. Thresholds also adapt to how noisy the room is at start-up.
3. **What about privacy?**
   There's no camera, and nothing is sent anywhere: the page analyses the microphone signal in memory, in the browser. Only the guided data-collection mode, which you start yourself, saves recordings, and only to a folder you choose. It does need microphone permission, and we say so.
4. **Why not just use the camera?**
   It works in the dark, it never captures faces, it's computationally light, and it works with the webcam taped over. It complements cameras rather than replacing them.
5. **Is the tone safe or annoying?**
   It's ~20 kHz at a moderate volume and only plays while the page is running; Stop silences it. Most adults can't hear it, but pets can, so we keep sessions short. [TBD: measure the level with a sound-meter app if asked.]
6. **What would people use it for?**
   Turning recipe pages with messy hands, flipping slides, hygienic touchless kiosks, controlling a laptop in a dark room, and accessibility for people who can't easily use a touchpad.
7. **Does it work on every laptop?**
   No. The mic must run at 44.1 kHz or higher, and the speaker must reach 18–20 kHz. A webcam mic we tried ran at 16 kHz and couldn't hear it at all. The page checks the mic rate, and **대역 점검 (band check)** measures which frequencies a given laptop can use, so you can pick a lower tone.
8. **Doesn't the browser filter this out?**
   Yes, by default. Chrome's echo cancellation and noise suppression erased the 20 kHz tone: −32 dB with them off, −179 dB with them on. We open the mic with echoCancellation, noiseSuppression and autoGainControl all off.
9. **What's new compared with prior research?**
   Zero install: a link in any browser on a stock laptop. SoundWave and FingerIO were native research prototypes, and laptop presence sensing is built in by vendors. We also solved the browser-specific problems.
10. **Can it do left and right?**
    Not reliably yet, so it isn't in the demo. A sideways hand changes its distance to the two speakers by only about a fifth of its speed. Our whole-burst cues got 15 of 20 swipes right within a session, but a model learned in one session got 7 of 20 in the next. The ↔ tab shows the per-laptop check, which says so honestly. Next we'll track each speaker's path length from the echo's phase.
11. **How fast is it, and what's next?**
    An 8192-point FFT (about 170 ms window at 48 kHz) updated about 60 times a second. On synthetic input a push registers about a quarter second after the motion starts. Next: run the trained classifier live in the page, make stereo swipes more robust, and a phone version.
