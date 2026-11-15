// node embed_default.js <loso calib.json> <scale json>  -> DEFAULT_CALIB.galaxy in bat3d.js and 3d.html (+ amp table)
const fs = require('fs');
const def = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), sc = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
delete def.created;
def.amp = sc.amp;
const nSit = (def.session.match(/(\d+) sittings/) || [])[1] || '?';
for (const f of ['bat3d.js', '3d.html']) {
  let s = fs.readFileSync(f, 'utf8');
  const key = f === 'bat3d.js' ? '  const DEFAULT_CALIB = { galaxy: ' : 'const DEFAULT_CALIB = { galaxy: ';
  const a = s.indexOf(key), b = s.indexOf(' };\n', a);
  if (a < 0 || b < 0) throw new Error('DEFAULT_CALIB not found in ' + f);
  s = s.slice(0, a) + key + JSON.stringify(def) + s.slice(b);
  s = s.replace(/learned on \w+ webcam-taught sittings/g, 'learned on ' + nSit + ' webcam-taught sittings');
  fs.writeFileSync(f, s);
  if (f === '3d.html') new Function(s.split('<script>')[1].split('</script>')[0]);
  console.log(f + ': ' + def.session + ' | half ' + JSON.stringify(def.amp.modes.half) + ' | corr ' + def.amp.corr.join('/'));
}
