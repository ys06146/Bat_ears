/* BatVision: webcam (MediaPipe HandLandmarker) frames from teach.html -> hand position in the laptop frame (m),
 * the same math as bravo's vision3d.js / teach_fit.js (21-point PnP with the world landmarks as the 3D hand shape).
 * Laptop frame: x right, y up, z toward the screen; origin = keyboard deck centre (Bat3D's H0 is [0, 0.12, 0] in it).
 *
 *   const frames = BatVision.parseVisionCSV(text)            // teach <base>_vision.csv -> [{ t, present, lm, wlm, hand }]
 *   const cam = BatVision.camFromCalib(calibJson)             // { W, H, hfov, tilt, mirror, C, lagMs } (cam fit of teach_fit)
 *   cam.scale = BatVision.sessionScale(frames, palmCm)        // optional: real palm width (cm) -> metric scale; else 1
 *   BatVision.handLaptop(frame, cam)          -> [x, y, z]       hand centre (centroid of the 21 points)
 *   BatVision.landmarksToLaptop(frame, cam)   -> 21 x [x, y, z]  the hand skeleton (MediaPipe landmark order)
 *   BatVision.wavTime(frame, wavT0, cam.lagMs) -> s             position in the session WAV for the ghost hand
 *   BatVision.EDGES                                            landmark index pairs for drawing the skeleton
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatVision = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  function parseVisionCSV(text) {
    const L = text.trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
    const out = [];
    for (const line of L.slice(1)) {
      const r = line.split(','), n = (k) => (ix[k] == null ? NaN : Number(r[ix[k]]));
      if (n('present') !== 1) continue;
      const t = Number.isFinite(n('t_cap')) ? n('t_cap') : n('t_ms');
      const lm = Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), n(`lm${j}_z`)]);
      const wlm = Number.isFinite(n('wlm5_x')) ? Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) : null;
      if (!Number.isFinite(lm[5][0])) continue;
      out.push({ t, present: true, lm, wlm, hand: ix.hand_mp != null ? r[ix.hand_mp] : r[ix.hand] });
    }
    return out;
  }
  // webcam at the top bezel centre: hinge at z = 0.10 m, screen 0.20 m tall, leaned back `tilt` deg, camera 1 cm below the edge
  const camAt = (tilt) => { const r = tilt * Math.PI / 180; return [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)]; };
  function camFromCalib(calib, { W = 1280, H = 720 } = {}) {
    const c = (calib && calib.cam) || { tilt: 5, hfov: 78, mirror: false };
    return { W, H, hfov: c.hfov ?? 78, tilt: c.tilt ?? 5, mirror: !!c.mirror, C: camAt(c.tilt ?? 5), lagMs: (calib && calib.lagMs) || 0, scale: 1 };
  }
  function sessionScale(frames, palmCm) {
    if (!palmCm) return 1;
    const r = frames.filter((f) => f.wlm).map((f) => palmCm / 100 / Math.hypot(f.wlm[5][0] - f.wlm[17][0], f.wlm[5][1] - f.wlm[17][1], f.wlm[5][2] - f.wlm[17][2])).filter(Number.isFinite).sort((a, b) => a - b);
    return r.length ? r[r.length >> 1] : 1;
  }
  // camera frame (x right, y down, z forward = toward the user) of the hand centroid: translation-only PnP
  function handCam(fr, cam) {
    const { W, H, hfov, mirror } = cam, k = cam.scale || 1, f = (W / 2) / Math.tan(hfov * Math.PI / 360), lm = fr.lm, wl = fr.wlm;
    const ux = (u) => (mirror ? 1 - u : u), sx = mirror ? -1 : 1;
    if (wl) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      const add = (r, y) => { for (let i = 0; i < 3; i++) { b[i] += r[i] * y; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } };
      for (let i = 0; i < 21; i++) {
        const a = (ux(lm[i][0]) - 0.5) * W / f, c = (lm[i][1] - 0.5) * H / f, X = sx * k * wl[i][0], Y = k * wl[i][1], Z = k * wl[i][2];
        add([-1, 0, a], X - a * Z); add([0, -1, c], Y - c * Z);
      }
      const det3 = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      const d = det3(A); if (!d) return null;
      return [0, 1, 2].map((c) => det3(A.map((r, i) => r.map((v, j) => (j === c ? b[i] : v)))) / d);
    }
    // no world landmarks: palm-width depth (8 cm palm)
    const ids = [0, 5, 9, 13, 17], u = ids.reduce((s, j) => s + ux(lm[j][0]), 0) / 5, v = ids.reduce((s, j) => s + lm[j][1], 0) / 5;
    const wpx = Math.hypot((lm[5][0] - lm[17][0]) * W, (lm[5][1] - lm[17][1]) * H), zc = f * 0.08 * k / Math.max(1, wpx);
    return [(u - 0.5) * W * zc / f, (v - 0.5) * H * zc / f, zc];
  }
  // camera frame -> laptop frame (the webcam faces the user, leaned back by tilt)
  function toLaptop(c, cam) {
    const th = cam.tilt * Math.PI / 180, C = cam.C || camAt(cam.tilt), xc = c[0], yc = -c[1], zc = c[2];
    const zc0 = zc * Math.cos(th) - yc * Math.sin(th), yc0 = zc * Math.sin(th) + yc * Math.cos(th);
    return [C[0] - xc, C[1] + yc0, C[2] - zc0];
  }
  const handLaptop = (fr, cam) => { const c = handCam(fr, cam); return c ? toLaptop(c, cam) : null; };
  function landmarksToLaptop(fr, cam) {
    const c = handCam(fr, cam); if (!c) return null;
    if (!fr.wlm) return fr.lm.map(() => toLaptop(c, cam));
    const k = cam.scale || 1, sx = cam.mirror ? -1 : 1;
    return fr.wlm.map((w) => toLaptop([c[0] + sx * k * w[0], c[1] + k * w[1], c[2] + k * w[2]], cam));
  }
  const wavTime = (fr, wavT0, lagMs = 0) => (fr.t - wavT0 + lagMs) / 1000;
  return { parseVisionCSV, camFromCalib, sessionScale, handCam, toLaptop, handLaptop, landmarksToLaptop, wavTime, EDGES };
});
