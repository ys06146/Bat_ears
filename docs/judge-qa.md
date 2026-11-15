# Judge Q&A prep

Short answers to say out loud. Numbers are measured; `[TBD]` = not measured yet. Always say the axis and the condition with a number.

## 3D tracking (`hologram.html`, `3d.html`)

1. **How accurate is the 3D tracking?**
   We predict how far the hand moves every quarter second from sound and compare that with the webcam, on a sitting the model never saw: we recorded 17 webcam-taught sittings: 8 guided teach sessions and 9 live comparison sessions, and tested each one with a model trained on the others. Laptop speakers only, hand within about 45 cm of the webcam: the RMS error is **3.3 cm left-right, 4.2 cm toward-away and 2.9 cm up-down**, while the movements themselves were 5.2, 5.7 and 3.6 cm (correlation 0.78, 0.70, 0.62). A small gated neural map does this; our linear map scored 0.74, 0.70, 0.59 on the first 15 of these sittings. So left-right and depth follow the hand best; height is the weakest. This is one person on one laptop. (Several sittings were harder, with different postures and a 375 Hz modulation on the tones; we keep them in, because more postures fit real use better.)
2. **How does the camera teach it, and is the camera on during the demo?**
   For 2½ minutes, `teach.html` runs MediaPipe HandLandmarker in the browser while the hand follows a guided routine, and records the raw audio on the same clock. We fit a linear map from each echo path's length change to the hand's 3D movement. After that the camera is off; the demo pages never open it.
3. **Privacy?**
   The tracking pages use only the microphone, analysed in memory in the browser, and send nothing anywhere. The teach session saves to a folder you pick on the laptop: the hand landmarks, the raw audio and, unless you untick it, the raw webcam video for re-analysis. None of it is uploaded, and the video is kept out of our git repo.
4. **Why is height weak?**
   The two laptop speakers sit side by side, so most up-down movement changes both paths almost equally. A least-squares map also draws motion at (correlation × true size), so the weak axis looks small; the page draws it larger with a square-root correction and shows the honest error. Height also depends on where the hand is: the mic sits about 19 cm above the keyboard, and a hand near that height mixes up-down with depth. Across our comparison sittings, height correlation is 0.58 below 17 cm, 0.70-0.73 at 17-25 cm and 0.81 above 25 cm, so we demo 25–35 cm above the keyboard. The hologram draws height at its true size so you can see it, at 3.1 cm of error instead of 2.9, and the card says it explains only about a third of the up-down motion. We tried phones as extra sources: a phone above the hand gave an echo path that didn't follow the hand, and phones beside the laptop added at most 0.05 to height correlation.
5. **Does it know where my hand is, or just how it moves?**
   How it moves. Phase gives path-length changes, so the position is a sum of movements and drifts; the hologram slowly returns to the centre, and ◎ re-centres it at the taped hand spot.
6. **Will it work for me / my laptop?**
   Not measured yet: all sittings are one person on one Galaxy Book. A new laptop needs its own 2½-minute teach session; the page has the Galaxy Book calibration built in.
7. **What's new compared with research?**
   LLAP, CAT, MilliSonic, Strata, RTrack and others track hands or devices with sound, with millimetre results using native code, research hardware or mic arrays. Ours is a zero-install web page on a stock laptop, and the camera is only a teacher. Our errors are centimetres, and we say so.
8. **Why do the phones play 17 kHz, not 20+?**
   iPhone speakers stop around 20 kHz: our 20.5 and 21.5 kHz phone tones weren't in the recordings at all. 17 and 18.75 kHz sit below and between the laptop's 18 / 19.5 kHz.

## Gestures and the browser

9. **How accurate are the gestures?**
   Across 17 guided recordings on a Windows laptop and MacBooks at 20–60 cm, 268 of 332 prompted pushes and pulls were recognized within 1.5 s (81%), with about 0.6 false triggers per minute while typing or sitting idle. A MacBook Air got 86 of 100 at 60 cm. Our first detector got only 15%, because people wind up before a pull. For reference, SoundWave (Microsoft Research, CHI 2012) reported over 90% on its gesture set with native code.
10. **Does it work in a loud room like this one?**
    Speech and music sit mostly far below 18 kHz, and we only look a few hundred Hz around our tones. In a room 43 dB louder in the speech band, the noise next to our tones rose by less than 1 dB, and a MacBook at 60 cm got 33 of 40 prompts over two noisy sessions with none reversed (17 of 20 in the quiet room). Claps are what the impulse veto is for. Another ultrasonic source (a second open Bat Ears tab or laptop) does interfere, and the pages show the peaks they hear.
11. **Doesn't the browser filter this out?**
    Yes, by default. Chrome's echo cancellation and noise suppression erased the 20 kHz tone: −32 dB with them off, −179 dB with them on. We open the mic with echoCancellation, noiseSuppression and autoGainControl all off.
12. **Does it work on every laptop?**
    No. The mic must run at 44.1 kHz or higher, and the speakers must reach 18–20 kHz. A webcam mic we tried ran at 16 kHz and couldn't hear it at all. The page checks the mic rate, and the band check measures which frequencies a given laptop can use.
13. **Is the tone safe or annoying?**
    18-20 kHz at a moderate volume, only while the page is running; Stop silences it. Most adults can't hear it, but pets can, so we keep sessions short. The phones' 17 kHz can be faintly audible to some young people, so we start it quietly.
14. **Can it do left and right with gestures?**
    As swipes, not reliably: within a session our cues got 15 of 20, but 7 of 20 on the next. That is why we moved to phase tracking, where left-right is now the strongest 3D axis.
15. **What would people use it for?**
    Steering slides or a recipe page with messy hands, touchless kiosks, controlling a laptop in the dark, and accessibility for people who can't easily use a touchpad.
