// Webcam hand position (one view) from MediaPipe landmarks.
//   handCam(fr, { W, H, hfov, mirror, palmCm, method }) -> [x right, y down, z forward] (m, camera frame) | null
//     method 'pnp'  : all 21 points; world landmarks (m, hand-centred, camera-aligned axes) as the 3D shape, solve the
//                     translation t:  a_i (Z_i + tz) = X_i + tx,  b_i (Z_i + tz) = Y_i + ty   (a, b = normalised rays)
//                     -> the hand's tilt is in the 3D shape, so foreshortening doesn't fake depth
//     method 'palm' : palm centre ray, depth = f * palm width (m) / palm width (px)   (fooled when the palm tilts)
//   palmCm rescales the world landmarks to the person's real palm width (index MCP 5 <-> pinky MCP 17)
//   toLaptop([xc, yc, zc], { tilt }) -> [x, y, z] laptop frame (webcam at the top bezel centre facing the user)
// one scale per session: median over frames of (real palm width / MediaPipe world palm width); per-frame rescaling
// would inject the palm measurement's ~5 % jitter straight into depth
function sessionScale(frames, palmCm) {
  if (!palmCm) return 1;
  const r = frames.filter((f) => f.wlm && Number.isFinite(f.wlm[5][0])).map((f) => palmCm / 100 / Math.hypot(f.wlm[5][0] - f.wlm[17][0], f.wlm[5][1] - f.wlm[17][1], f.wlm[5][2] - f.wlm[17][2])).filter(Number.isFinite).sort((a, b) => a - b);
  return r.length ? r[r.length >> 1] : 1;
}
function handCam(fr, { W = 1280, H = 720, hfov = 70, mirror = false, palmCm = null, scale = null, method = 'pnp' } = {}) {
  const f = (W / 2) / Math.tan(hfov * Math.PI / 360), lm = fr.lm, wl = fr.wlm;
  const ux = (u) => (mirror ? 1 - u : u);
  if (method === 'pnp' && wl && Number.isFinite(wl[5][0])) {
    const pw = Math.hypot(wl[5][0] - wl[17][0], wl[5][1] - wl[17][1], wl[5][2] - wl[17][2]);
    const k = scale ?? (palmCm && pw > 0 ? palmCm / 100 / pw : 1), sx = mirror ? -1 : 1;
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    const addRow = (r, y) => { for (let i = 0; i < 3; i++) { b[i] += r[i] * y; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } };
    for (let i = 0; i < 21; i++) {
      const a = (ux(lm[i][0]) - 0.5) * W / f, c = (lm[i][1] - 0.5) * H / f, X = sx * k * wl[i][0], Y = k * wl[i][1], Z = k * wl[i][2];
      addRow([-1, 0, a], X - a * Z); addRow([0, -1, c], Y - c * Z);
    }
    const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    if (!det) return null;
    return [0, 1, 2].map((c) => { const M = A.map((r, i) => r.map((v, j) => (j === c ? b[i] : v))); return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det; });
  }
  const ids = [0, 5, 9, 13, 17], u = ids.reduce((s, j) => s + ux(lm[j][0]), 0) / 5, v = ids.reduce((s, j) => s + lm[j][1], 0) / 5;
  const wpx = Math.hypot((lm[5][0] - lm[17][0]) * W, (lm[5][1] - lm[17][1]) * H);
  const Wm = palmCm ? palmCm / 100 : wl ? Math.hypot(wl[5][0] - wl[17][0], wl[5][1] - wl[17][1], wl[5][2] - wl[17][2]) : 0.08;
  const zc = f * Wm / Math.max(1, wpx);
  return [(u - 0.5) * W * zc / f, (v - 0.5) * H * zc / f, zc];
}
// camera frame (x right, y down, z forward = toward the user) -> laptop frame (x right, y up, z toward the screen)
function toLaptop(c, { tilt = 20, C = [0, 0.195, 0.17] } = {}) {
  const th = tilt * Math.PI / 180, xc = c[0], yc = -c[1], zc = c[2];     // yc up
  const zc0 = zc * Math.cos(th) - yc * Math.sin(th), yc0 = zc * Math.sin(th) + yc * Math.cos(th);
  return [C[0] - xc, C[1] + yc0, C[2] - zc0];
}
module.exports = { handCam, toLaptop, sessionScale };
