# Bat Ears: 1-minute live pitch

> Merged from charlie's drafts. The 2-minute video script and the live order are in [demo-script.md](demo-script.md), the slides in [slides.md](slides.md), short answers in [judge-qa.md](judge-qa.md). Always say the axis and the condition with a number.

## Main pitch: 3D (about 150 words, while a teammate runs `hologram.html`)

> "Hi, we're Bat Ears. Hand tracking today means a camera, which raises privacy concerns, fails in the dark, and watches your face.
>
> We track your hand in 3D with sound. *(Point at the taped webcam.)* The laptop's two speakers play tones you can't hear, and the mic follows how each echo path to my hand stretches and shrinks. *(Move the hand: the hologram hand follows.)*
>
> Here's the trick: the camera only teaches. For two and a half minutes MediaPipe showed the audio model where my hand was, then we switched it off. Trained with a camera, runs without one.
>
> It's just a web page: nothing to install, nothing sent anywhere. On sittings it had never seen, the laptop alone follows left-right and depth to about four centimetres a quarter-second; height is still our weak axis, and the screen says so.
>
> On top of that: gestures, a gesture key and a game. Try it at the link on our slide."

**If a judge asks "how accurate?":** "Every quarter second we predict how far the hand moves, and test on a sitting the model never saw. Over fifteen sittings, with the laptop alone and the hand within about 45 centimetres of the webcam, the error is 3.3 cm left-right, 4.2 cm toward-away and 2.9 cm up-down, while the movements themselves were 5.2, 5.7 and 3.6 cm. One person, one laptop so far."

## Fallback pitch: gestures (if 3D misbehaves live)

"3D works best inside its taught zone; here's the same idea doing push, pull and wave." Then run Force Push:

> "The speaker plays a tone you can't hear, and when my hand moves, the echo's pitch shifts: the Doppler effect. *(Push: the meteor blasts. Pull: grab the star.)* On real recordings we get 81 percent on push and pull across 17 sessions on Windows and Mac laptops, with less than one false trigger a minute while typing."

Lead with honesty: we credit SoundWave, LLAP and the other prior work, and every number is measured.
