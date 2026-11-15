# Bat Ears: pitch materials (video script, slides, 1-minute pitch)

> Draft by charlie, merged by alpha. Sources: `docs/devpost.md` and `docs/judge-qa.md`. The numbers are the measured ones from `python ml/report.py` (11/14 21:15): push/pull 82 of 112 (73%) across 6 sessions on 2 laptops at 20–35 cm, and about 2.4 false triggers per minute while typing or idle. Swap them if the final run changes them. Left/right is experimental and not in the demo (push, pull and wave only).

---

## 1. Demo video script (2:00)

Total narration is about 280 words, at roughly 140 words a minute.

| Time | Shot (what's on screen) | Narration |
|---|---|---|
| 0:00–0:15 | **Problem.** Close-up of floury or wet hands hovering over a laptop recipe page. Cut to a webcam with a sticker over it. | "Touchless control usually means a camera, and cameras are watching you. They also fail in the dark. Special sensors? Nobody owns one. But every laptop already has a speaker and a microphone." |
| 0:15–0:25 | Title card: **Bat Ears**. "Your laptop hears your hands, like a bat." A bat silhouette with echo rings. | "Bats see with sound. So we taught a laptop to do the same." |
| 0:25–0:55 | **Demo.** Wide shot: a laptop with its webcam visibly taped over. Open the link in Chrome, with no install. Press Start. Push your palm toward the screen and a meteor blasts in Force Push. Pull and a star is grabbed. Wave for a shockwave. Overlay a small live Doppler meter in the corner. | "This is a normal web page. No app, no extra hardware, and the camera is taped over. Push… and the meteor explodes. Pull… grab the star. Wave… shockwave. All from sound." |
| 0:55–1:20 | **How it works.** Animated diagram: the speaker emits a 20 kHz wave, the wave bounces off the hand, and the echo goes to the mic. The spectrum shows the carrier spike, with energy rising above it on a push and below it on a pull. Show the formula Δf = 2·v·f₀/c. | "The speaker plays a steady 18 to 20 kilohertz tone that most people can't hear. When your hand moves toward the screen, the echo comes back slightly higher, and when it moves away, slightly lower. That's the Doppler effect. We read that shift about 60 times a second, right in the browser with the Web Audio API. One catch: Chrome's voice filters erase ultrasound, so we turn them off and open the raw microphone." |
| 1:20–1:40 | **Results.** Big numbers on a card: **73%** push/pull (82/112 prompted, 6 sessions, 2 laptops). **~2.4 false triggers/min** while typing or idle. Small text: "Early data, improving." | "On real recordings, Bat Ears recognized 73 percent of prompted pushes and pulls across six sessions on two laptops, with about two false triggers a minute while typing. It's early, and we're publishing every number honestly as it improves." *(Update the numbers if the final run changes them.)* |
| 1:40–2:00 | **Why it matters.** Quick montage of a recipe page flipping, slides advancing, a dark room, and an accessibility use. End card with the URL `ys06146.github.io/nhng/web/` and "No camera. No install. Nothing sent." | "No camera means no faces captured. While you play, nothing is recorded or sent; the sound is analysed in memory on your device. That makes touchless control private by design, and accessible to anyone with a laptop and a link. Bat Ears: your laptop hears your hands." |

**Filming tips**
- Keep the tape on the webcam in frame for the whole demo. That's the money shot.
- Record screen and room at the same time, or overlay a screen recording, so viewers see the gesture and the result together.
- Film in a quiet room, with no second laptop running Bat Ears nearby, since another laptop's tone interferes.
- Push "fast out, slow back", the way the prompt says.

---

## 2. Slide outline (6 slides)

1. **Bat Ears: your laptop hears your hands**
   - Touchless gestures with no camera and no extra hardware. Open a link and wave.
   - Visual: a laptop with the webcam taped over, and echo rings around a hand.
2. **The problem**
   - Touchless control today means a camera (privacy, fails in the dark) or a special sensor (nobody owns one).
   - Every laptop already has a speaker and a mic.
3. **How it works**
   - ~20 kHz tone → echo off the hand → Doppler shift (Δf = 2·v·f₀/c; 0.5 m/s ≈ 58 Hz).
   - Web Audio: OscillatorNode for the tone, and an 8192-point FFT on the mic (~5.9 Hz per bin) updated ~60 times a second.
   - Raw mic: echo cancellation, noise suppression and auto gain all off. With them on, the 20 kHz level dropped from −32 to −179 dB.
   - Burst detector: adaptive noise floors, judged by the largest hand speed, with clap and impulse veto.
4. **Demo: Force Push**
   - Push to blast, pull to grab, wave for a shockwave. Left/right swipes stay in an experimental tab with an honest per-laptop check.
   - Live on stage with the webcam taped over.
5. **Results, honestly**
   - Push/pull 73% (82/112, 6 sessions, 2 laptops, 20–35 cm). ~2.4 false triggers/min while typing or idle. Best session 17/20 live.
   - We learned that people wind up before a pull. Switching from "first direction" to "largest speed" took one session from 3/20 to 17/20.
   - Left/right is physics, not tuning: per-frame comparison scored at chance (7/14). Whole-burst cues got 15/20 within a session but 7/20 on a new session, so it isn't in the demo.
6. **Why it matters, and what's next**
   - Privacy by design (no camera, nothing sent) and accessibility (one link, any laptop).
   - Uses: cooking with messy hands, slides, sterile settings, limited mobility.
   - Next: run the trained classifier in the page, left/right from the echo's phase (path length per speaker) and the second mic, a phone version.
   - Prior art, credited: SoundWave (MSR, CHI 2012) and FingerIO (CHI 2016). What's new: a zero-install web page on stock hardware.

---

## 3. One-minute live pitch (judging, 13:00)

About 150 words. Say it while one teammate runs the demo.

> "Hi, we're Bat Ears. Touchless control usually needs a camera, and cameras raise privacy concerns and fail in the dark. But every laptop already has a speaker and a microphone.
>
> So we taught a laptop to hear like a bat. *(Point at the taped webcam.)* The camera is off. The speaker plays a 20 kilohertz tone you can't hear, and when my hand moves, the echo's pitch shifts. That's the Doppler effect. *(Push: the meteor blasts. Pull: grab the star.)*
>
> It's just a web page. Nothing to install, nothing sent anywhere, and everything runs on the device. The hard part was the browser itself: Chrome's voice filters erase ultrasound, so we open the raw mic.
>
> On real recordings we get 73 percent on push and pull, with about two false triggers a minute, and we're improving it live.
>
> Touchless, private and accessible, on the laptop you already own. Try it yourself, right now, at the link on our slide."

**If they ask:** see `judge-qa.md`. Lead with honesty: we credit SoundWave, and our numbers are measured, not claimed.
