# Every-frame hand labels from a teach video

`teach.html` labels the hand live, but only has time for about 19 of the webcam's 30 frames a second. When the session
keeps its raw video (`<session>.webm`, local only, never committed), these tools re-read every frame offline with the
same MediaPipe model and write `<session>_vision_full.csv`, on the same clock as the audio.

1. Serve the repo: `python -m http.server 8765` in the repo root.
2. Start a headless Chrome of its own: `chrome --headless=new --remote-debugging-port=9384 --user-data-dir=<temp dir> about:blank`.
3. `node tools/vision_full/vf_run.mjs 9384 http://127.0.0.1:8765/tools/vision_full/vision_full.html /ml/data/teach/<session>.webm vf.json`
   (WebCodecs decodes the VP8 frames one by one; tasks-vision 0.10.21 HandLandmarker, VIDEO mode, 1 hand, CPU).
4. `python tools/vision_full/vf_post.py <session> vf.json` (needs numpy) writes `ml/data/teach/<session>_vision_full.csv`.

First sitting (11/15 09:23): 4,393 frames in 70 s, hand found in 96.0 % (live 93.7 %), every live frame matched within
3 ms, palm 1.8 px from the live labels on the same frames. bravo's check: 1.6 times the usable training windows at about
the same label quality.
