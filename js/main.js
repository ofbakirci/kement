'use strict';
/* Kement — panel mantığı.
 * İki iş: (1) Topla & Bağla — proje medyasını hedef klasöre toplayıp relink,
 *         (2) Eşitle — kaynak → ayna(lar) incremental mirror.
 * Kurallar: hiçbir dosyanın üzerine yedeksiz yazılmaz, aynaya özgü dosyaya
 *           kullanıcı kararı olmadan dokunulmaz, A → B sonucu tam içerik
 *           özetiyle doğrulanır.
 */

const req = (typeof require === 'function') ? require
          : (window.cep_node && window.cep_node.require);
const fs = req('fs');
const path = req('path');
const crypto = req('crypto');
const cp = req('child_process');

const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── Durdurma / duraklatma ───────────────────────────────────── */
// Uzun tarama/doğrulama aşamaları kullanıcı isteğiyle duraklatılabilir veya
// kesilebilir. Sadece okuma yapan aşamalarda "silahlanır"; yazma aşamalarında
// butonlar gizlidir ve checkStop hiçbir zaman fırlatmaz/beklemez.

class StopError extends Error {
  constructor() {
    super('Kullanıcı durdurdu');
    this.name = 'StopError';
    this.stopped = true;
  }
}
let stopArmed = false;
let stopRequested = false;
let pauseRequested = false;
let pauseWaiters = [];

// Kontrol noktası: durdurma istendiyse fırlatır, duraklatıldıysa devam
// edilene (veya durdurulana) kadar bekler. Silahsızken anında döner.
async function checkStop() {
  if (stopArmed && stopRequested) throw new StopError();
  while (stopArmed && pauseRequested) {
    await new Promise((resolve) => pauseWaiters.push(resolve));
    if (stopArmed && stopRequested) throw new StopError();
  }
}
function wakePaused() {
  const waiters = pauseWaiters;
  pauseWaiters = [];
  for (const resolve of waiters) resolve();
}
function renderStopControls() {
  const stopBtn = $('stopOp');
  const pauseBtn = $('pauseOp');
  const card = $('progressCard');
  if (!stopBtn || !pauseBtn || !card) return;
  stopBtn.classList.toggle('hidden', !stopArmed);
  pauseBtn.classList.toggle('hidden', !stopArmed);
  stopBtn.disabled = stopRequested;
  stopBtn.textContent = stopRequested ? 'Durduruluyor…' : 'Durdur';
  pauseBtn.disabled = stopRequested;
  pauseBtn.textContent = pauseRequested ? 'Devam' : 'Duraklat';
  card.classList.toggle('paused', stopArmed && pauseRequested && !stopRequested);
}
function armStop() {
  stopRequested = false;
  pauseRequested = false;
  stopArmed = true;
  renderStopControls();
}
function disarmStop() {
  stopArmed = false;
  stopRequested = false;
  pauseRequested = false;
  wakePaused();
  renderStopControls();
}
function requestStop() {
  if (!stopArmed) return;
  stopRequested = true;
  wakePaused(); // duraklatılmışsa bekleyen noktayı uyandır ki fırlatsın
  renderStopControls();
}
function togglePause() {
  if (!stopArmed || stopRequested) return;
  pauseRequested = !pauseRequested;
  if (!pauseRequested) wakePaused();
  renderStopControls();
}

// Asenkron okuma: UI iş parçacığını bloke etmez, Durdur tıklaması işlenebilir.
function readAt(fd, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, position, (err, n) => {
      if (err) reject(err); else resolve(n);
    });
  });
}

const BACKUP_DIR = '_kement_yedek';
const SKIP_NAMES = new Set([
  '.DS_Store', '.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems',
  '.DocumentRevisions-V100', 'System Volume Information', '$RECYCLE.BIN',
  '.PKInstallSandboxManager', 'lost+found', BACKUP_DIR,
]);

/* ── ExtendScript köprüsü ─────────────────────────────────────── */

function evalScript(script) {
  return new Promise((resolve) => window.__adobe_cep__.evalScript(script, resolve));
}

const JSX_VERSION = '0.3.0';

async function ensureJSX() {
  const v = await evalScript('(typeof ESL === "object" && ESL.version) || ""');
  if (v !== JSX_VERSION) {
    const extPath = decodeURIComponent(
      window.__adobe_cep__.getSystemPath('extension')
    ).replace(/^file:\/\//, '');
    await evalScript('$.evalFile(' + JSON.stringify(extPath + '/jsx/kement.jsx') + ')');
  }
}

async function callJSX(fn, ...args) {
  await ensureJSX();
  const call = 'ESL.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')';
  const raw = await evalScript(call);
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { ok: false, err: 'JSX cevabı çözümlenemedi: ' + raw };
  }
}

/* ── Yardımcılar ──────────────────────────────────────────────── */

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tsStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + ms;
}

function log(msg, cls) {
  const d = document.createElement('div');
  d.className = 'logline' + (cls ? ' ' + cls : '');
  const t = new Date();
  const p = (x) => String(x).padStart(2, '0');
  d.textContent = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}  ${msg}`;
  $('log').prepend(d);
}

function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  const parent = path.dirname(dir);
  if (parent !== dir) ensureDir(parent);
  try { fs.mkdirSync(dir); }
  catch (e) {
    if (!fs.existsSync(dir)) throw e;
  }
}

function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pathsOverlap(a, b) {
  const canonical = (value) => {
    try { return fs.realpathSync(value); }
    catch (_) { return path.resolve(value); }
  };
  const ra = canonical(a), rb = canonical(b);
  return ra === rb || isInside(ra, rb) || isInside(rb, ra);
}

function assertSafePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedRoot, resolvedTarget)) {
    throw new Error('Dosya seçilen kökün dışında: ' + resolvedTarget);
  }

  let rootStat;
  try { rootStat = fs.lstatSync(resolvedRoot); }
  catch (e) { throw new Error('Seçilen kök okunamıyor: ' + resolvedRoot); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Seçilen kök gerçek bir klasör olmalı: ' + resolvedRoot);
  }

  const rel = path.relative(resolvedRoot, resolvedTarget);
  const parts = rel.split(path.sep);
  let current = resolvedRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    if (!fs.existsSync(current)) break;
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) {
      throw new Error('Sembolik bağlantı üzerinden işlem yapılmadı: ' + current);
    }
    if (!st.isDirectory()) {
      throw new Error('Üst yol klasör değil: ' + current);
    }
  }

  if (fs.existsSync(resolvedTarget) && fs.lstatSync(resolvedTarget).isSymbolicLink()) {
    throw new Error('Sembolik bağlantı üzerinden işlem yapılmadı: ' + resolvedTarget);
  }

  const parent = path.dirname(resolvedTarget);
  if (fs.existsSync(parent)) {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realParent = fs.realpathSync(parent);
    if (realParent !== realRoot && !isInside(realRoot, realParent)) {
      throw new Error('Gerçek hedef seçilen kökün dışında: ' + realParent);
    }
  }
}

function pickFolder(title) {
  const dlg = window.cep.fs.showOpenDialogEx
    ? window.cep.fs.showOpenDialogEx(false, true, title, null, null)
    : window.cep.fs.showOpenDialog(false, true, title, null);
  if (dlg && dlg.err === 0 && dlg.data && dlg.data.length) return dlg.data[0];
  return null;
}

/* ── Ayarlar ─────────────────────────────────────────────────── */

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('kement') || '{}'); }
  catch (e) { return {}; }
}
function saveSettings() {
  localStorage.setItem('kement', JSON.stringify({
    target: $('targetPath').value,
    paths: [$('p0').value, $('p1').value, $('p2').value],
  }));
}

/* ── Dosya tarama / parmak izi ───────────────────────────────── */

// root altındaki tüm dosyalar: tarama anındaki kimlik ve metadata ile birlikte
async function walk(root) {
  const out = [];
  const stack = [''];
  let n = 0;
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = fs.readdirSync(abs); }
    catch (e) { throw new Error(`Klasör okunamadı: ${abs} — ${e.message}`); }
    for (const name of entries) {
      if (SKIP_NAMES.has(name) || name.startsWith('._')) continue;
      const childRel = rel ? rel + '/' + name : name;
      let st;
      try { st = fs.lstatSync(path.join(root, childRel)); }
      catch (e) { throw new Error(`Öğe okunamadı: ${path.join(root, childRel)} — ${e.message}`); }
      if (st.isSymbolicLink()) {
        throw new Error(`Sembolik bağlantı desteklenmiyor: ${path.join(root, childRel)}`);
      } else if (st.isDirectory()) {
        stack.push(childRel);
      } else if (st.isFile()) {
        out.push({
          rel: childRel,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          dev: st.dev,
          ino: st.ino,
        });
      }
      if (++n % 400 === 0) { await tick(); await checkStop(); }
    }
  }
  return out;
}

// Hızlı parmak izi: küçük dosyanın tamamı; büyük dosyanın beş ayrı 256 KB
// bölgesi. Büyük videoyu baştan sona okumadan güçlü bir pratik içerik kontrolü
// sağlar.
function fingerprintRegions(size) {
  const CH = 256 * 1024;
  if (size <= 0) return [];
  if (size <= CH * 5) return [[0, size]];
  return [
    0,
    Math.floor(size * 0.25 - CH / 2),
    Math.floor(size * 0.50 - CH / 2),
    Math.floor(size * 0.75 - CH / 2),
    size - CH,
  ].map((position) => [position, CH]);
}

// Eşzamanlı sürüm: kısa, tekil kontroller için (toplama, B→A seçim onayı).
function fingerprint(absPath, size) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    for (const [position, length] of fingerprintRegions(size)) {
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const n = fs.readSync(fd, buffer, done, length - done, position + done);
        if (!n) throw new Error('Dosya beklenenden erken bitti');
        done += n;
      }
      h.update(String(position) + ':' + String(length) + ':');
      h.update(buffer);
    }
  } finally {
    fs.closeSync(fd);
  }
  return size + ':' + h.digest('hex');
}

// Asenkron sürüm: tarama döngüsünde kullanılır; fingerprint() ile birebir
// aynı değeri üretir (snapshot'taki değerle sonradan karşılaştırılıyor).
async function fingerprintAsync(absPath, size) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    for (const [position, length] of fingerprintRegions(size)) {
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const n = await readAt(fd, buffer, done, length - done, position + done);
        if (!n) throw new Error('Dosya beklenenden erken bitti');
        done += n;
      }
      h.update(String(position) + ':' + String(length) + ':');
      h.update(buffer);
    }
  } finally {
    fs.closeSync(fd);
  }
  return size + ':' + h.digest('hex');
}

function sameFileObject(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function sameStableStats(a, b) {
  return sameFileObject(a, b) && a.size === b.size &&
         a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function fullFingerprint(absPath, size, onBytes) {
  const CHUNK = 4 * 1024 * 1024;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  const before = fs.fstatSync(fd);
  if (!before.isFile() || before.size !== size) {
    fs.closeSync(fd);
    throw new Error('Dosya boyutu doğrulama öncesinde değişti');
  }
  const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)));
  let position = 0;
  let after;
  try {
    while (position < size) {
      await checkStop();
      const wanted = Math.min(buffer.length, size - position);
      const n = await readAt(fd, buffer, 0, wanted, position);
      if (!n) throw new Error('Dosya beklenenden erken bitti');
      h.update(n === buffer.length ? buffer : buffer.slice(0, n));
      position += n;
      if (onBytes) onBytes(n);
    }
    after = fs.fstatSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let pathAfter;
  try { pathAfter = fs.lstatSync(absPath); }
  catch (e) { throw new Error('Dosya doğrulama sırasında kayboldu'); }
  if (!sameStableStats(before, after) || !sameFileObject(after, pathAfter)) {
    throw new Error('Dosya doğrulama sırasında değişti');
  }
  return size + ':' + h.digest('hex');
}

async function fullFilesMatch(a, b, expectedSize, onBytes) {
  const aStat = fs.statSync(a);
  const bStat = fs.statSync(b);
  if (!aStat.isFile() || !bStat.isFile() ||
      aStat.size !== expectedSize || bStat.size !== expectedSize) return false;
  const aHash = await fullFingerprint(a, expectedSize, onBytes);
  const bHash = await fullFingerprint(b, expectedSize, onBytes);
  return aHash === bHash;
}

let tempFileSerial = 0;

function reserveTempFile(dst) {
  for (let i = 0; i < 1000; i++) {
    const candidate = dst + '.kement-part-' + Date.now().toString(36) + '-' + (++tempFileSerial);
    try {
      return { path: candidate, fd: fs.openSync(candidate, 'wx') };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Geçici dosya için benzersiz ad ayrılamadı');
}

async function installTempNoOverwrite(tmp, dst) {
  try {
    fs.linkSync(tmp, dst);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return;
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw new Error('Hedef taramadan sonra oluştu; üzerine yazılmadı');
    }
    // Bazı harici disk biçimleri hard link desteklemez. Hedef adını atomik
    // olarak ayırıp doğrulanmış temp'i o Kement inode'una kopyala.
  }

  let srcFd = null;
  let dstFd = null;
  let owned = null;
  let completed = false;
  try {
    dstFd = fs.openSync(dst, 'wx');
    owned = fs.fstatSync(dstFd);
    srcFd = fs.openSync(tmp, 'r');
    const tmpStat = fs.fstatSync(srcFd);
    const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(1, tmpStat.size)));
    let position = 0;
    while (position < tmpStat.size) {
      const wanted = Math.min(buffer.length, tmpStat.size - position);
      const n = fs.readSync(srcFd, buffer, 0, wanted, position);
      if (!n) throw new Error('Geçici dosya beklenenden erken bitti');
      let written = 0;
      while (written < n) {
        written += fs.writeSync(dstFd, buffer, written, n - written, position + written);
      }
      position += n;
      await tick();
    }
    fs.fsyncSync(dstFd);
    fs.closeSync(srcFd); srcFd = null;
    fs.closeSync(dstFd); dstFd = null;
    const current = fs.lstatSync(dst);
    if (!sameFileObject(owned, current)) {
      throw new Error('Hedef commit sırasında başka bir işlem tarafından değiştirildi');
    }
    const sourceTimes = fs.statSync(tmp);
    fs.utimesSync(dst, sourceTimes.atime, sourceTimes.mtime);
    if (!await fullFilesMatch(tmp, dst, sourceTimes.size)) {
      throw new Error('Hedefe özel kopya doğrulanamadı');
    }
    completed = true;
  } catch (e) {
    if (srcFd !== null) try { fs.closeSync(srcFd); } catch (_) {}
    if (dstFd !== null) try { fs.closeSync(dstFd); } catch (_) {}
    if (e.code === 'EEXIST') {
      throw new Error('Hedef taramadan sonra oluştu; üzerine yazılmadı');
    }
    if (owned) {
      throw new Error(e.message +
        ' (ayrılan hedef güvenlik için yerinde bırakıldı; eski sürüm silinmedi)');
    }
    throw e;
  }
  if (completed) {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function copyWithProgress(src, dst, onBytes, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dst));
    let reserved;
    try { reserved = reserveTempFile(dst); }
    catch (e) { reject(e); return; }
    const tmp = reserved.path;
    const rs = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
    const ws = fs.createWriteStream(tmp, { fd: reserved.fd, autoClose: true });
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      try { rs.destroy(); ws.destroy(); fs.unlinkSync(tmp); } catch (_) {}
      reject(e);
    };
    rs.on('data', (b) => onBytes && onBytes(b.length));
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('close', async () => {
      if (failed) return;
      try {
        const st = fs.statSync(src);
        fs.utimesSync(tmp, st.atime, st.mtime);
        if (options.keepTemp) {
          resolve(tmp);
          return;
        }
        if (options.noOverwrite) {
          await installTempNoOverwrite(tmp, dst);
        } else {
          fs.renameSync(tmp, dst); // kopya bitmeden hedefte yarım dosya görünmez
        }
        resolve(dst);
      } catch (e) { fail(e); }
    });
    rs.pipe(ws);
  });
}

async function stageVerifiedCopy(src, dst, expectedSize, expectedFullFingerprint, onBytes, safety) {
  safety = safety || {};
  let tmp = null;
  try {
    if (safety.srcRoot) assertSafePath(safety.srcRoot, src);
    if (safety.dstRoot) assertSafePath(safety.dstRoot, dst);
    tmp = await copyWithProgress(src, dst, onBytes, { keepTemp: true });
    if (safety.srcRoot) assertSafePath(safety.srcRoot, src);
    if (safety.dstRoot) {
      assertSafePath(safety.dstRoot, dst);
      assertSafePath(safety.dstRoot, tmp);
    }
    const st = fs.statSync(tmp);
    if (!st.isFile() || st.size !== expectedSize) {
      throw new Error('Geçici kopyanın boyutu farklı');
    }
    const copiedFingerprint = await fullFingerprint(tmp, expectedSize);
    if (expectedFullFingerprint && copiedFingerprint !== expectedFullFingerprint) {
      throw new Error('Kaynak kopyalama sırasında değişti');
    }
    return tmp;
  } catch (e) {
    if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

async function assertPathMatches(absPath, expectedSize, expectedFullFingerprint) {
  let st;
  try { st = fs.lstatSync(absPath); }
  catch (e) { throw new Error('Hedef taramadan sonra kayboldu'); }
  if (!st.isFile() || st.size !== expectedSize) {
    throw new Error('Hedef taramadan sonra değişti');
  }
  const currentFingerprint = await fullFingerprint(absPath, expectedSize);
  if (currentFingerprint !== expectedFullFingerprint) {
    throw new Error('Hedefin içeriği taramadan sonra değişti');
  }
  return fs.lstatSync(absPath);
}

function createUniqueBackupRoot(dstRoot) {
  const parent = path.join(dstRoot, BACKUP_DIR);
  assertSafePath(dstRoot, path.join(parent, '.kement-safety'));
  ensureDir(parent);
  assertSafePath(dstRoot, path.join(parent, '.kement-safety'));
  const base = tsStamp();
  for (let i = 0; i < 10000; i++) {
    const candidate = path.join(parent, base + (i ? '-' + String(i + 1).padStart(2, '0') : ''));
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Benzersiz yedek klasörü oluşturulamadı');
}

/* ── Eşitleme planı ──────────────────────────────────────────── */

async function createRootSnapshot(root, options) {
  options = options || {};
  const deep = Boolean(options.deep);
  const listed = await walk(root);
  const needsFull = (file) => deep &&
    (!options.fullPredicate || options.fullPredicate(file));
  const totalBytes = deep ? listed.reduce(
    (sum, file) => sum + (needsFull(file) ? file.size : 0), 0
  ) : 0;
  let doneBytes = 0;
  const files = [];
  for (let i = 0; i < listed.length; i++) {
    const file = listed[i];
    const abs = path.join(root, file.rel);
    let contentFingerprint;
    let fullContentFingerprint = null;
    await checkStop();
    try {
      contentFingerprint = await fingerprintAsync(abs, file.size);
      if (needsFull(file)) {
        fullContentFingerprint = await fullFingerprint(abs, file.size, (n) => {
          doneBytes += n;
          if (options.onProgress) options.onProgress({
            root,
            rel: file.rel,
            doneFiles: i,
            totalFiles: listed.length,
            doneBytes,
            totalBytes,
          });
        });
      }
    } catch (e) {
      if (e.stopped) throw e;
      throw new Error(`Dosya doğrulanamadı: ${abs} — ${e.message}`);
    }
    files.push(Object.assign({}, file, {
      contentFingerprint,
      fullContentFingerprint,
    }));
    if (options.onProgress) options.onProgress({
      root,
      rel: file.rel,
      doneFiles: i + 1,
      totalFiles: listed.length,
      doneBytes,
      totalBytes,
    });
    if (!deep) await tick();
  }
  return { root: path.resolve(root), deep, files };
}

function rootSnapshotSignature(snapshot) {
  return JSON.stringify(snapshot.files.map((file) => [
    file.rel,
    file.size,
    snapshot.deep ? file.fullContentFingerprint : file.contentFingerprint,
  ]).sort((a, b) => a[0].localeCompare(b[0])));
}

async function planMirror(srcRoot, dstRoot, options) {
  options = options || {};
  const sourceSnapshot = options.sourceSnapshot || await createRootSnapshot(srcRoot, {
    deep: Boolean(options.deep),
    onProgress: options.onProgress,
  });
  if (sourceSnapshot.root !== path.resolve(srcRoot)) {
    throw new Error('Kaynak snapshot başka bir klasöre ait');
  }
  const deep = Boolean(options.deep || sourceSnapshot.deep);
  if (deep && !sourceSnapshot.deep) {
    throw new Error('Tam doğrulama için tam kaynak snapshot gerekli');
  }
  const sourceRelSet = new Set(sourceSnapshot.files.map((file) => file.rel));
  const destinationSnapshot = await createRootSnapshot(dstRoot, {
    deep,
    fullPredicate: deep && options.deepMirrorOnly === false
      ? (file) => sourceRelSet.has(file.rel)
      : null,
    onProgress: options.onProgress,
  });
  const srcList = sourceSnapshot.files;
  const dstList = destinationSnapshot.files;
  const srcMap = new Map(srcList.map((f) => [f.rel, f]));
  const dstMap = new Map(dstList.map((f) => [f.rel, f]));

  const plan = {
    srcRoot, dstRoot,
    copies: [],      // kaynakta var, aynada yok → kopyala
    overwrites: [],  // ikisinde de var ama farklı → yedekle + kopyala
    renames: [],     // içerik aynı, yol farklı (ad değişmiş/taşınmış) → kullanıcıya sor
    mirrorOnly: [],  // aynada var, kaynakta aynı yol yok → kullanıcıya sor
    sameCount: 0,
    bytes: 0,
    deepVerified: deep,
    sourceSnapshotSignature: rootSnapshotSignature(sourceSnapshot),
  };

  for (const f of srcList) {
    const d = dstMap.get(f.rel);
    if (!d) {
      plan.copies.push({
        rel: f.rel,
        size: f.size,
        srcMtimeMs: f.mtimeMs,
        srcCtimeMs: f.ctimeMs,
        srcFingerprint: f.contentFingerprint,
        srcFullFingerprint: f.fullContentFingerprint,
      });
      plan.bytes += f.size;
    } else {
      const contentsMatch = d.size === f.size && (deep
        ? d.fullContentFingerprint === f.fullContentFingerprint
        : d.contentFingerprint === f.contentFingerprint);
      if (contentsMatch) {
        plan.sameCount++;
      } else {
        plan.overwrites.push({
          rel: f.rel,
          size: f.size,
          srcMtimeMs: f.mtimeMs,
          srcCtimeMs: f.ctimeMs,
          srcFingerprint: f.contentFingerprint,
          srcFullFingerprint: f.fullContentFingerprint,
          dstSize: d.size,
          dstMtimeMs: d.mtimeMs,
          dstCtimeMs: d.ctimeMs,
          dstFingerprint: d.contentFingerprint,
          dstFullFingerprint: d.fullContentFingerprint,
          destNewer: d.mtimeMs > f.mtimeMs + 2000,
        });
        plan.bytes += f.size;
      }
    }
  }
  plan.mirrorOnly = dstList.filter((f) => !srcMap.has(f.rel));
  detectRenames(plan, srcMap, deep);
  return plan;
}

// Yolu eşleşmeyen kaynak dosyası ile yolu eşleşmeyen ayna dosyası aynı
// içerikteyse (boyut + parmak izi) ve eşleşme iki yönde de tekse bu bir ad
// değişikliği / taşımadır: kopyalamak yerine kullanıcıya sorulur. Aynı içerikten
// birden fazla kopya varsa hangi adın hangisine gittiği belirsizdir; o dosyalar
// eskisi gibi kopya / aynaya özgü olarak kalır.
function detectRenames(plan, srcMap, deep) {
  const keyOf = (size, quick, full) => {
    const fp = deep ? full : quick;
    return fp ? size + '|' + fp : null;
  };
  const bySrc = new Map();
  for (const c of plan.copies) {
    const key = keyOf(c.size, c.srcFingerprint, c.srcFullFingerprint);
    if (!key) continue;
    if (!bySrc.has(key)) bySrc.set(key, []);
    bySrc.get(key).push(c);
  }
  const byDst = new Map();
  for (const d of plan.mirrorOnly) {
    const key = keyOf(d.size, d.contentFingerprint, d.fullContentFingerprint);
    if (!key) continue;
    if (!byDst.has(key)) byDst.set(key, []);
    byDst.get(key).push(d);
  }
  const matchedSrc = new Set();
  const matchedDst = new Set();
  for (const [key, srcGroup] of bySrc) {
    const dstGroup = byDst.get(key);
    if (!dstGroup || srcGroup.length !== 1 || dstGroup.length !== 1) continue;
    const c = srcGroup[0];
    const d = dstGroup[0];
    const f = srcMap.get(c.rel);
    plan.renames.push({
      rel: c.rel,           // A'daki yol (hedef ad)
      fromRel: d.rel,       // B'deki mevcut yol
      size: c.size,
      srcMtimeMs: c.srcMtimeMs,
      srcCtimeMs: c.srcCtimeMs,
      srcDev: f ? f.dev : undefined,
      srcIno: f ? f.ino : undefined,
      srcFingerprint: c.srcFingerprint,
      srcFullFingerprint: c.srcFullFingerprint,
      dstMtimeMs: d.mtimeMs,
      dstCtimeMs: d.ctimeMs,
      dstDev: d.dev,
      dstIno: d.ino,
      dstFingerprint: d.contentFingerprint,
      dstFullFingerprint: d.fullContentFingerprint,
    });
    matchedSrc.add(c);
    matchedDst.add(d);
  }
  if (!plan.renames.length) return;
  plan.renames.sort((a, b) => a.rel.localeCompare(b.rel));
  plan.copies = plan.copies.filter((c) => !matchedSrc.has(c));
  plan.mirrorOnly = plan.mirrorOnly.filter((d) => !matchedDst.has(d));
  plan.bytes -= plan.renames.reduce((sum, r) => sum + r.size, 0);
}

// "Dokunma" kararı: ad değişiklikleri eski davranışa döner — A'daki ad ile
// kopyalanır, B'deki eski ad aynaya özgü dosya olarak yerinde kalır.
function expandRenames(plan) {
  if (!plan.renames || !plan.renames.length) return plan;
  const copies = plan.copies.concat(plan.renames.map((r) => ({
    rel: r.rel,
    size: r.size,
    srcMtimeMs: r.srcMtimeMs,
    srcCtimeMs: r.srcCtimeMs,
    srcFingerprint: r.srcFingerprint,
    srcFullFingerprint: r.srcFullFingerprint,
  })));
  const mirrorOnly = plan.mirrorOnly.concat(plan.renames.map((r) => ({
    rel: r.fromRel,
    size: r.size,
    mtimeMs: r.dstMtimeMs,
    ctimeMs: r.dstCtimeMs,
    dev: r.dstDev,
    ino: r.dstIno,
    contentFingerprint: r.dstFingerprint,
    fullContentFingerprint: r.dstFullFingerprint,
  })));
  return Object.assign({}, plan, {
    copies,
    mirrorOnly,
    renames: [],
    bytes: plan.bytes + plan.renames.reduce((sum, r) => sum + r.size, 0),
  });
}

// Yeniden adlandırma öncesi ucuz ama sıkı kontrol: aynı dosya nesnesi (dev/ino),
// aynı boyut/zamanlar ve aynı hızlı parmak izi. İçerik değişmiyor, yalnızca
// ad/yol değişiyor; bu yüzden tam içerik okuması tekrar yapılmaz (tarama ve
// ön kontrol zaten yaptı).
async function renameVerified(root, fromRel, toRel, expected) {
  const from = path.join(root, fromRel);
  const to = path.join(root, toRel);
  assertSafePath(root, from);
  assertSafePath(root, to);
  let before;
  try { before = fs.lstatSync(from); }
  catch (e) { throw new Error('Dosya bulunamadı: ' + fromRel); }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Sembolik bağlantı veya klasör yeniden adlandırılmadı: ' + fromRel);
  }
  if (before.size !== expected.size ||
      before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs ||
      (expected.dev !== undefined && before.dev !== expected.dev) ||
      (expected.ino !== undefined && before.ino !== expected.ino)) {
    throw new Error('Dosya taramadan sonra değişti: ' + fromRel);
  }
  const currentFingerprint = await fingerprintAsync(from, expected.size);
  if (currentFingerprint !== expected.fingerprint) {
    throw new Error('Dosyanın içeriği taramadan sonra değişti: ' + fromRel);
  }
  let toExists = false;
  try { fs.lstatSync(to); toExists = true; } catch (_) {}
  if (toExists) throw new Error('Hedef ad zaten var; üzerine yazılmadı: ' + toRel);
  ensureDir(path.dirname(to));
  assertSafePath(root, to);
  const beforeMove = fs.lstatSync(from);
  if (!sameStableStats(before, beforeMove)) {
    throw new Error('Dosya yeniden adlandırma anında değişti: ' + fromRel);
  }
  fs.renameSync(from, to);
  const after = fs.lstatSync(to);
  if (!sameFileObject(before, after) || after.size !== before.size) {
    throw new Error('Yeniden adlandırma sonrası dosya doğrulanamadı: ' + toRel);
  }
}

async function applyMirror(plan, progress, options) {
  options = options || {};
  progress = progress || (() => {});
  if (!plan.deepVerified) {
    throw new Error('Uygulama öncesi tam içerik doğrulaması gerekli');
  }
  let backupRoot = null;
  const report = { copied: 0, overwritten: 0, renamed: 0, errors: [], backupRoot: null };
  const renames = plan.renames || [];
  const totalFiles = renames.length + plan.copies.length + plan.overwrites.length;
  let doneFiles = 0, doneBytes = 0;

  const step = (label) => {
    doneFiles++;
    progress({ label, doneFiles, totalFiles, doneBytes, totalBytes: plan.bytes });
  };
  const onBytes = (n) => {
    doneBytes += n;
    progress({ doneFiles, totalFiles, doneBytes, totalBytes: plan.bytes });
  };

  // 0) Ad değişiklikleri: B'deki dosya A'daki yola taşınır. Kopya yok, içerik
  // değişmez; hedef ad doluysa dokunulmaz.
  for (const f of renames) {
    try {
      await renameVerified(plan.dstRoot, f.fromRel, f.rel, {
        size: f.size,
        mtimeMs: f.dstMtimeMs,
        ctimeMs: f.dstCtimeMs,
        dev: f.dstDev,
        ino: f.dstIno,
        fingerprint: f.dstFingerprint,
      });
      report.renamed++;
    } catch (e) {
      report.errors.push(`Yeniden adlandırma ${f.fromRel} → ${f.rel}: ${e.message}`);
    }
    step(f.rel);
  }

  // 1) Üzerine yazılacaklar: yeni sürüm önce temp'e alınır ve doğrulanır.
  // Eski B dosyası uzun kopya boyunca yerinde kalır.
  for (const f of plan.overwrites) {
    const src = path.join(plan.srcRoot, f.rel);
    const dst = path.join(plan.dstRoot, f.rel);
    let bak = null;
    let tmp = null;
    let movedToBackup = false;
    try {
      tmp = await stageVerifiedCopy(
        src, dst, f.size, f.srcFullFingerprint, onBytes,
        { srcRoot: plan.srcRoot, dstRoot: plan.dstRoot }
      );
      if (options.beforeOverwriteCommit) {
        await options.beforeOverwriteCommit({ src, dst, tmp, file: f });
      }

      // Committen hemen önce B'nin taramada onaylanan sürüm olduğunu tam
      // içerikle kanıtla. Değiştiyse B'ye ve yedeğe dokunma.
      assertSafePath(plan.dstRoot, dst);
      const validatedDst = await assertPathMatches(
        dst, f.dstSize, f.dstFullFingerprint
      );
      assertSafePath(plan.dstRoot, dst);
      if (!backupRoot) {
        backupRoot = createUniqueBackupRoot(plan.dstRoot);
        report.backupRoot = backupRoot;
      }
      bak = path.join(backupRoot, f.rel);
      assertSafePath(plan.dstRoot, bak);
      ensureDir(path.dirname(bak));
      assertSafePath(plan.dstRoot, bak);
      if (fs.existsSync(bak)) {
        throw new Error('Yedek hedefi zaten var; üzerine yazılmadı');
      }
      const beforeMove = fs.lstatSync(dst);
      if (!sameStableStats(validatedDst, beforeMove)) {
        throw new Error('Hedef commit anında değişti');
      }
      fs.renameSync(dst, bak);
      movedToBackup = true;
      const movedStat = fs.lstatSync(bak);
      if (!sameFileObject(validatedDst, movedStat) ||
          validatedDst.size !== movedStat.size ||
          validatedDst.mtimeMs !== movedStat.mtimeMs) {
        throw new Error('Hedef commit anında başka bir dosyayla değişti');
      }
      assertSafePath(plan.dstRoot, dst);
      await installTempNoOverwrite(tmp, dst);
      tmp = null;
      report.overwritten++;
      if (f.destNewer) log(`Dikkat: aynadaki daha yeniydi, yedeklendi: ${f.rel}`, 'warn');
    } catch (e) {
      let restored = false;
      if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
      if (movedToBackup) {
        try {
          // Yabancı bir dst ortaya çıktıysa asla silme/ezme. Eski B bak'ta
          // güvenle kalır ve recovery yolu hata metninde gösterilir.
          if (!fs.existsSync(dst) && bak && fs.existsSync(bak)) {
            fs.renameSync(bak, dst);
            restored = true;
          }
        } catch (restoreError) {
          report.errors.push(`Geri yükleme ${f.rel}: ${restoreError.message}`);
        }
      }
      report.errors.push(`Güncelleme ${f.rel}: ${e.message}` +
                         (restored ? ' (eski sürüm geri yüklendi)' :
                          (movedToBackup && bak ? ` (eski sürüm yedekte: ${bak})` : '')));
    }
    step(f.rel);
  }

  // 2) Yeni dosyalar
  for (const f of plan.copies) {
    const src = path.join(plan.srcRoot, f.rel);
    const dst = path.join(plan.dstRoot, f.rel);
    let tmp = null;
    try {
      tmp = await stageVerifiedCopy(
        src, dst, f.size, f.srcFullFingerprint, onBytes,
        { srcRoot: plan.srcRoot, dstRoot: plan.dstRoot }
      );
      assertSafePath(plan.dstRoot, dst);
      await installTempNoOverwrite(tmp, dst);
      tmp = null;
      report.copied++;
    } catch (e) {
      if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
      report.errors.push(`Kopyalama ${f.rel}: ${e.message}`);
    }
    step(f.rel);
  }

  // Aynaya özgü dosyalar bu fonksiyonun kapsamı dışındadır. Kullanıcının
  // seçmedikleri aynada, aynı yolunda kalır.
  return report;
}

// Karar "A'da yeniden adlandır": her ayna için tespit edilen çiftlerde A'daki
// dosya B'deki ada taşınır. İki ayna aynı A dosyasına farklı ad veriyorsa veya
// hedef ad A'da doluysa o dosya atlanır ve hata olarak bildirilir.
function prepareSourceRenames(plans) {
  const byRel = new Map();
  const errors = [];
  plans.forEach((plan) => {
    const mirrorName = path.basename(plan.dstRoot) || plan.dstRoot;
    (plan.renames || []).forEach((r) => {
      if (!byRel.has(r.rel)) byRel.set(r.rel, []);
      byRel.get(r.rel).push({ r, mirrorName });
    });
  });
  const files = [];
  const targets = new Set();
  for (const [rel, entries] of byRel) {
    const names = new Set(entries.map((e) => e.r.fromRel));
    if (names.size > 1) {
      errors.push(`${rel}: aynalar farklı ad veriyor (${entries.map((e) => e.mirrorName + ': ' + e.r.fromRel).join(' · ')}); A'da dokunulmadı.`);
      continue;
    }
    const first = entries[0].r;
    if (targets.has(first.fromRel)) {
      errors.push(`${rel}: aynı hedef ada iki dosya gidiyor (${first.fromRel}); A'da dokunulmadı.`);
      continue;
    }
    targets.add(first.fromRel);
    files.push({
      srcRoot: plans[0].srcRoot,
      rel,
      toRel: first.fromRel,
      size: first.size,
      mtimeMs: first.srcMtimeMs,
      ctimeMs: first.srcCtimeMs,
      dev: first.srcDev,
      ino: first.srcIno,
      fingerprint: first.srcFingerprint,
    });
  }
  return { files, errors };
}

async function applySourceRenames(prepared, progress) {
  const report = { renamed: 0, errors: [] };
  for (let i = 0; i < prepared.files.length; i++) {
    const f = prepared.files[i];
    try {
      await renameVerified(f.srcRoot, f.rel, f.toRel, {
        size: f.size, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs,
        dev: f.dev, ino: f.ino, fingerprint: f.fingerprint,
      });
      report.renamed++;
    } catch (e) {
      report.errors.push(`A'da yeniden adlandırma ${f.rel} → ${f.toRel}: ${e.message}`);
    }
    if (progress) progress({ doneFiles: i + 1, totalFiles: prepared.files.length, label: f.toRel });
  }
  return report;
}

/* ── Aynaya bağla: proje öğelerini öteki diskteki kopyaya eşle ───── */

// items: [{name, path}] (projedeki medya yolları). fromRoot altındaki her yol
// için toRoot'ta karşılık aranır. Doğrulama hızlı parmak iziyle (boyut + beş
// bölge) yapılır; proje bağlantısı geri alınabilir bir işlem olduğundan tam
// içerik okunmaz.
//  direct     : aynı göreli yol, aynı içerik
//  renamed    : farklı yol, aynı içerik (tek eşleşme; aynı ad varsa o tercih edilir)
//  ambiguous  : aynı içerikten birden fazla aday, ad da yardım etmiyor
//  differs    : aynı yolda dosya var ama içerik farklı, başka aday da yok
//  missing    : toRoot'ta içerik hiç yok
//  unverified : kaynak çevrimdışı; toRoot'ta yalnızca yol eşleşiyor (doğrulanamadı)
async function buildRelinkPlan(items, fromRoot, toRoot, onProgress) {
  onProgress = onProgress || (() => {});
  const plan = {
    fromRoot, toRoot,
    total: 0, elsewhere: 0,
    direct: [], renamed: [], ambiguous: [], differs: [], missing: [], unverified: [],
  };
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    if (!it.path || seen.has(it.path)) continue;
    seen.add(it.path);
    unique.push(it);
  }
  const inside = unique.filter((it) => isInside(fromRoot, it.path));
  plan.total = unique.length;
  plan.elsewhere = unique.length - inside.length;

  let index = null; // boyut → [{rel, size}] (tembel: ilk gerektiğinde bir kez)
  const ensureIndex = async () => {
    if (index) return index;
    const listed = await walk(toRoot);
    index = new Map();
    for (const file of listed) {
      if (!index.has(file.size)) index.set(file.size, []);
      index.get(file.size).push(file);
    }
    return index;
  };
  const fpCache = new Map();
  const fpOf = async (abs, size) => {
    if (!fpCache.has(abs)) fpCache.set(abs, await fingerprintAsync(abs, size));
    return fpCache.get(abs);
  };
  const statFile = (abs) => {
    try {
      const st = fs.statSync(abs);
      return st.isFile() ? st : null;
    } catch (_) { return null; }
  };

  for (let i = 0; i < inside.length; i++) {
    const it = inside[i];
    const rel = path.relative(fromRoot, it.path);
    const candidate = path.join(toRoot, rel);
    onProgress({ doneFiles: i, totalFiles: inside.length, rel });
    await checkStop();

    const srcStat = statFile(it.path);
    if (!srcStat) {
      const cst = statFile(candidate);
      if (cst) plan.unverified.push({ name: it.name, oldPath: it.path, newPath: candidate, rel, newRel: rel, size: cst.size });
      else plan.missing.push({ name: it.name, oldPath: it.path, rel, size: null, offline: true });
      continue;
    }
    const size = srcStat.size;
    let srcFp;
    try { srcFp = await fpOf(it.path, size); }
    catch (e) {
      plan.missing.push({ name: it.name, oldPath: it.path, rel, size, offline: true, error: e.message });
      continue;
    }
    const cst = statFile(candidate);
    if (cst && cst.size === size) {
      let candFp = null;
      try { candFp = await fpOf(candidate, size); } catch (_) {}
      if (candFp === srcFp) {
        plan.direct.push({ name: it.name, oldPath: it.path, newPath: candidate, rel, newRel: rel, size });
        continue;
      }
    }

    // İçerik araması: aynı boyuttaki adaylar, parmak izi ile süzülür.
    const matches = [];
    const sameSize = (await ensureIndex()).get(size) || [];
    for (const file of sameSize) {
      if (file.rel === rel) continue;
      const abs = path.join(toRoot, file.rel);
      try { if (await fpOf(abs, size) === srcFp) matches.push(file); }
      catch (_) {}
      await checkStop();
    }
    const toEntry = (file) => ({
      name: it.name, oldPath: it.path, newPath: path.join(toRoot, file.rel), rel, newRel: file.rel, size,
    });
    if (matches.length === 1) {
      plan.renamed.push(toEntry(matches[0]));
    } else if (matches.length > 1) {
      const sameName = matches.filter((m) => path.basename(m.rel) === path.basename(rel));
      if (sameName.length === 1) plan.renamed.push(toEntry(sameName[0]));
      else plan.ambiguous.push({ name: it.name, oldPath: it.path, rel, size, candidates: matches.map((m) => m.rel) });
    } else if (cst) {
      plan.differs.push({ name: it.name, oldPath: it.path, rel, size, candidateSize: cst.size });
    } else {
      plan.missing.push({ name: it.name, oldPath: it.path, rel, size, offline: false });
    }
  }
  onProgress({ doneFiles: inside.length, totalFiles: inside.length, rel: '' });
  return plan;
}

/* ── İlerleme kartı ──────────────────────────────────────────── */

function showProgress(label) {
  $('progressCard').classList.remove('hidden');
  $('progressLabel').textContent = label;
  $('barFill').style.width = '0%';
  $('progressDetail').textContent = '';
}
function setProgress(frac, detail) {
  $('barFill').style.width = Math.min(100, Math.round(frac * 100)) + '%';
  if (detail !== undefined) $('progressDetail').textContent = detail;
}
function hideProgress() {
  $('progressCard').classList.add('hidden');
}

/* ── Topla & Bağla akışı ─────────────────────────────────────── */

let collectScan = null; // {outside:[{path,size,name}], offline:[...]}

function invalidateCollect() {
  collectScan = null;
  $('applyCollect').disabled = true;
  $('collectSummary').textContent = '';
  $('collectList').innerHTML = '';
}

async function doScanProject() {
  const target = $('targetPath').value;
  if (!target) { log('Önce medya klasörünü seç.', 'warn'); return; }
  if (!fs.existsSync(target)) { log('Medya klasörü bulunamadı: ' + target, 'err'); return; }

  $('scanProject').disabled = true;
  try {
    const res = await callJSX('getMediaPaths');
    if (!res.ok) { log('Proje taranamadı: ' + res.err, 'err'); return; }

    const seen = new Set();
    const outside = [];
    const offline = [];
    for (const it of res.items) {
      if (seen.has(it.path)) continue;
      seen.add(it.path);
      if (isInside(target, it.path)) continue;
      if (!fs.existsSync(it.path)) { offline.push(it); continue; }
      const st = fs.statSync(it.path);
      outside.push({ path: it.path, name: it.name, size: st.size });
    }
    collectScan = { outside, offline, target };

    const list = $('collectList');
    list.innerHTML = '';
    const addRow = (p, sizeLabel, offlineRow) => {
      const li = document.createElement('li');
      if (offlineRow) li.classList.add('offline');
      const sp = document.createElement('span');
      sp.className = 'fpath';
      sp.textContent = p;
      const sz = document.createElement('span');
      sz.className = 'fsize';
      sz.textContent = sizeLabel;
      li.append(sp, sz);
      li.addEventListener('contextmenu', (ev) => openCtxMenu(ev, p, offlineRow));
      list.appendChild(li);
    };
    for (const f of outside) addRow(f.path, fmtBytes(f.size), false);
    for (const f of offline) addRow(f.path, 'offline', true);

    const totalBytes = outside.reduce((a, f) => a + f.size, 0);
    const parts = [];
    parts.push(outside.length
      ? `<span class="warn">${outside.length} dosya klasör dışında</span> (${fmtBytes(totalBytes)})`
      : `<span class="ok">Tüm medya klasörün içinde ✓</span>`);
    if (offline.length) parts.push(`<span class="err">${offline.length} dosya diskte bulunamadı (offline)</span>`);
    parts.push(`<span class="muted">${seen.size} medya öğesi tarandı · ${res.projectName}</span>`);
    $('collectSummary').innerHTML = parts.join('<br>');
    $('applyCollect').disabled = outside.length === 0;
    log(`Proje tarandı: ${outside.length} dosya dışarıda, ${offline.length} offline.`);
  } finally {
    $('scanProject').disabled = false;
  }
}

async function doApplyCollect() {
  if (!collectScan || !collectScan.outside.length) return;
  const { outside, target } = collectScan;
  $('applyCollect').disabled = true;
  $('scanProject').disabled = true;

  const totalBytes = outside.reduce((a, f) => a + f.size, 0);
  let doneBytes = 0, done = 0, relinked = 0, copied = 0;
  const errors = [];
  showProgress('Toplanıyor ve bağlanıyor…');

  try {
    for (const f of outside) {
      const base = path.basename(f.path);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);

      // Hedefte aynı isim varsa: içerik aynıysa kopyalama, sadece bağla;
      // farklıysa "(2)" ekleyerek yeni ad bul.
      let dst = path.join(target, base);
      let identical = false;
      let i = 2;
      while (fs.existsSync(dst)) {
        try {
          if (fingerprint(dst, fs.statSync(dst).size) === fingerprint(f.path, f.size)) {
            identical = true;
            break;
          }
        } catch (e) {}
        dst = path.join(target, `${stem} (${i})${ext}`);
        i++;
      }

      try {
        if (!identical) {
          await copyWithProgress(f.path, dst, (n) => {
            doneBytes += n;
            setProgress(doneBytes / (totalBytes || 1),
              `${done + 1}/${outside.length} · ${base} · ${fmtBytes(doneBytes)} / ${fmtBytes(totalBytes)}`);
          });
          copied++;
        } else {
          doneBytes += f.size;
          log(`Zaten kopyası vardı, sadece bağlandı: ${base}`);
        }
        const rl = await callJSX('relink', f.path, dst);
        if (rl.ok && rl.count > 0) {
          relinked += rl.count;
          log(`Bağlandı (${rl.count} öğe): ${base}`, 'ok');
        } else {
          errors.push(`Relink başarısız: ${base}` + (rl.err ? ' — ' + rl.err : ''));
        }
      } catch (e) {
        errors.push(`${base}: ${e.message}`);
      }
      done++;
      setProgress(doneBytes / (totalBytes || 1));
      await tick();
    }

    const msg = `Bitti: ${copied} dosya kopyalandı, ${relinked} proje öğesi bağlandı` +
                (errors.length ? `, ${errors.length} hata` : '') + '.';
    log(msg, errors.length ? 'warn' : 'ok');
    for (const e of errors) log(e, 'err');
    $('collectSummary').innerHTML = `<span class="${errors.length ? 'warn' : 'ok'}">${msg}</span>`;
  } finally {
    hideProgress();
    $('scanProject').disabled = false;
    invalidateCollect();
  }
}

/* ── Eşitle akışı ────────────────────────────────────────────── */

let syncPlans = null;
let selectedMirrorOnly = new Set();
let mirrorOnlyDecisionConfirmed = true;
let mirrorOnlyCheckboxBindings = [];
let mirrorOnlyFolderBindings = [];
let mirrorOnlyFileBindings = [];
let mirrorOnlyTreeBindings = [];
let mirrorOnlySearchByKey = new Map();
let mirrorOnlyDomId = 0;
let syncGeneration = 0;
let syncPathLockCount = 0;
let renameDecision = null; // null | 'mirror' | 'source' | 'skip'

function mirrorOnlyKey(planIndex, rel) {
  return planIndex + ':' + rel;
}

function hasForwardWork(plan) {
  return Boolean(plan.copies.length || plan.overwrites.length ||
                 (plan.renames && plan.renames.length));
}

function getAllMirrorOnlyKeys() {
  const keys = [];
  if (!syncPlans) return keys;
  syncPlans.forEach((plan, planIndex) => {
    plan.mirrorOnly.forEach((f) => keys.push(mirrorOnlyKey(planIndex, f.rel)));
  });
  return keys;
}

function getSelectedMirrorOnlyEntries() {
  const out = [];
  if (!syncPlans) return out;
  syncPlans.forEach((plan, planIndex) => {
    plan.mirrorOnly.forEach((file) => {
      const key = mirrorOnlyKey(planIndex, file.rel);
      if (selectedMirrorOnly.has(key)) out.push({ key, planIndex, plan, file });
    });
  });
  return out;
}

function resetMirrorOnlyReview() {
  selectedMirrorOnly = new Set();
  mirrorOnlyDecisionConfirmed = true;
  mirrorOnlyCheckboxBindings = [];
  mirrorOnlyFolderBindings = [];
  mirrorOnlyFileBindings = [];
  mirrorOnlyTreeBindings = [];
  mirrorOnlySearchByKey = new Map();
  mirrorOnlyDomId = 0;
  $('mirrorOnlyTrees').innerHTML = '';
  $('mirrorOnlySearch').value = '';
  $('mirrorOnlyConflict').textContent = '';
  $('mirrorOnlyConflict').classList.add('hidden');
  $('mirrorOnlyReview').classList.add('hidden');
  $('mirrorOnlyEditor').classList.remove('hidden');
  $('mirrorOnlyDecision').classList.add('hidden');
  $('applySync').textContent = 'Eşitle';
  renameDecision = null;
  $('renameReview').classList.add('hidden');
  $('renameList').innerHTML = '';
  document.querySelectorAll('input[name="renameMode"]').forEach((radio) => { radio.checked = false; });
}

function invalidateSync() {
  syncGeneration++;
  syncPlans = null;
  $('applySync').disabled = true;
  $('syncSummary').textContent = '';
  resetMirrorOnlyReview();
  invalidateRelink();
  refreshRelinkRoots();
}

function syncPathSignature(src, mirrors) {
  return JSON.stringify([
    path.resolve(src),
    ...mirrors.map((mirror) => path.resolve(mirror)),
  ]);
}

function currentSyncPathSignature() {
  const current = getSyncPaths();
  return syncPathSignature(current.src, current.mirrors);
}

function planSetPathSignature(plans) {
  return syncPathSignature(plans[0].srcRoot, plans.map((plan) => plan.dstRoot));
}

function syncOperationIsCurrent(generation, signature) {
  return generation === syncGeneration && signature === currentSyncPathSignature();
}

// Eşitle ve Aynaya Bağla aynı diskleri, ilerleme kartını ve Durdur/Duraklat
// kontrollerini paylaşır; biri çalışırken ötekinin başlatılması engellenir.
function lockSyncPathControls() {
  syncPathLockCount++;
  document.querySelectorAll('button.pick, button.clear').forEach((button) => {
    button.disabled = true;
  });
  ['scanSync', 'applySync', 'scanRelink', 'applyRelink'].forEach((id) => {
    $(id).disabled = true;
  });
}

function unlockSyncPathControls() {
  syncPathLockCount = Math.max(0, syncPathLockCount - 1);
  if (syncPathLockCount === 0) {
    document.querySelectorAll('button.pick, button.clear').forEach((button) => {
      button.disabled = false;
    });
    $('scanSync').disabled = false;
    if (syncPlans) updateApplySyncState(); else $('applySync').disabled = true;
    refreshRelinkRoots();
    updateApplyRelinkState();
  }
}

function getSyncPaths() {
  const src = $('p0').value.trim();
  const mirrors = [$('p1').value.trim(), $('p2').value.trim()].filter(Boolean);
  return { src, mirrors };
}

function planSignature(plan) {
  const sorted = (items, fields) => items.map((item) =>
    fields.map((field) => item[field]).join('\u0001')
  ).sort();
  return JSON.stringify({
    copies: sorted(plan.copies, [
      'rel', 'size', 'srcMtimeMs', 'srcCtimeMs', 'srcFingerprint', 'srcFullFingerprint',
    ]),
    overwrites: sorted(plan.overwrites, [
      'rel', 'size', 'srcMtimeMs', 'srcCtimeMs', 'srcFingerprint', 'srcFullFingerprint',
      'dstSize', 'dstMtimeMs', 'dstCtimeMs', 'dstFingerprint', 'dstFullFingerprint', 'destNewer',
    ]),
    renames: sorted(plan.renames || [], [
      'rel', 'fromRel', 'size', 'srcMtimeMs', 'srcCtimeMs', 'srcFingerprint', 'srcFullFingerprint',
      'dstMtimeMs', 'dstCtimeMs', 'dstFingerprint', 'dstFullFingerprint',
    ]),
    mirrorOnly: sorted(plan.mirrorOnly, [
      'rel', 'size', 'mtimeMs', 'ctimeMs', 'contentFingerprint', 'fullContentFingerprint',
    ]),
  });
}

function mirrorOnlySignature(plan) {
  return JSON.stringify(plan.mirrorOnly.map((file) => [
    file.rel,
    file.size,
    file.fullContentFingerprint,
  ]).sort((a, b) => a[0].localeCompare(b[0])));
}

function snapshotProgressFraction(progress) {
  if (progress.totalBytes > 0) return progress.doneBytes / progress.totalBytes;
  return progress.totalFiles ? progress.doneFiles / progress.totalFiles : 1;
}

async function refreshSyncPlans(plans, progressLabel, options) {
  options = options || {};
  const deep = Boolean(options.deep);
  const totalStages = plans.length + 1;
  const emit = (stageIndex, name, detail) => {
    const fraction = (stageIndex + snapshotProgressFraction(detail)) / totalStages;
    if (options.onProgress) {
      options.onProgress({
        fraction,
        name,
        rel: detail.rel,
        stageIndex,
        totalStages,
      });
    } else {
      setProgress(fraction,
        (progressLabel ? progressLabel + ' · ' : '') + name +
        (detail.rel ? ' · ' + detail.rel : ''));
    }
  };

  const sourceRoot = plans[0].srcRoot;
  const sourceName = path.basename(sourceRoot) || sourceRoot;
  const sourceSnapshot = await createRootSnapshot(sourceRoot, {
    deep,
    onProgress: (p) => emit(0, sourceName, p),
  });
  const refreshed = [];
  for (let i = 0; i < plans.length; i++) {
    const name = path.basename(plans[i].dstRoot) || plans[i].dstRoot;
    refreshed.push(await planMirror(plans[i].srcRoot, plans[i].dstRoot, {
      deep,
      deepMirrorOnly: options.deepMirrorOnly,
      sourceSnapshot,
      onProgress: (p) => emit(i + 1, name, p),
    }));
  }
  return { plans: refreshed, sourceSnapshot };
}

async function verifyAllMirrors(plans, onProgress) {
  const refreshed = await refreshSyncPlans(plans, 'Son doğrulama', {
    deep: true,
    onProgress,
  });
  const sourceRoot = plans[0].srcRoot;
  const sourceName = path.basename(sourceRoot) || sourceRoot;
  const endSnapshot = await createRootSnapshot(sourceRoot, {
    deep: true,
    onProgress: (p) => {
      if (onProgress) onProgress({
        fraction: snapshotProgressFraction(p),
        name: sourceName,
        rel: p.rel,
        finalSourceCheck: true,
      });
    },
  });
  const sourceStable = rootSnapshotSignature(refreshed.sourceSnapshot) ===
                       rootSnapshotSignature(endSnapshot);
  const remaining = refreshed.plans.map((plan) =>
    plan.copies.length + plan.overwrites.length + plan.renames.length
  );
  const mirrorOnlyStable = refreshed.plans.map((plan, index) =>
    mirrorOnlySignature(plan) === mirrorOnlySignature(plans[index])
  );
  return {
    plans: refreshed.plans,
    sourceStable,
    remaining,
    mirrorOnlyStable,
    ok: sourceStable && remaining.every((count) => count === 0) &&
        mirrorOnlyStable.every(Boolean),
  };
}

async function applyAllMirrors(plans, onEvent, options) {
  options = options || {};
  onEvent = onEvent || (() => {});
  const reports = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const report = await applyMirror(plan, (progress) => {
      onEvent({ phase: 'apply', index: i, plan, progress });
    }, options.applyOptions);
    reports.push(report);
    if (options.afterMirror) {
      await options.afterMirror({ index: i, plan, report });
    }
  }
  const verification = await verifyAllMirrors(plans, (progress) => {
    onEvent({ phase: 'verify', progress });
  });
  const reportsOk = reports.every((report) => report.errors.length === 0);
  return {
    reports,
    finalPlans: verification.plans,
    sourceStable: verification.sourceStable,
    remaining: verification.remaining,
    mirrorOnlyStable: verification.mirrorOnlyStable,
    ok: reportsOk && verification.ok,
  };
}

function describePlan(plan, planIndex) {
  const bits = [];
  if (plan.copies.length) bits.push(`<span class="ok">${plan.copies.length} yeni</span>`);
  if (plan.overwrites.length) bits.push(`<span class="warn">${plan.overwrites.length} güncellenecek (yedekli)</span>`);
  if (plan.renames && plan.renames.length) {
    const what = {
      mirror: "B'de yeniden adlandırılacak",
      source: "A'da yeniden adlandırılacak",
      skip: 'kopyalanacak, eskisi B\'de kalacak',
    }[renameDecision];
    bits.push(`<span class="warn">${plan.renames.length} yalnızca adı farklı${what ? ' → ' + what : ' — karar gerekli'}</span>`);
  }
  if (!bits.length) bits.push(`<span class="ok">A → B eşleşiyor ✓</span>`);
  if (plan.mirrorOnly.length) {
    if (mirrorOnlyDecisionConfirmed) {
      const selected = plan.mirrorOnly.reduce(
        (sum, file) => sum + (selectedMirrorOnly.has(mirrorOnlyKey(planIndex, file.rel)) ? 1 : 0), 0
      );
      if (selected) bits.push(`<span class="ok">${selected} A'ya alınacak</span>`);
      if (plan.mirrorOnly.length - selected) {
        bits.push(`<span class="muted">${plan.mirrorOnly.length - selected} aynada kalacak</span>`);
      }
    } else {
      bits.push(`<span class="warn">${plan.mirrorOnly.length} yalnızca aynada — karar gerekli</span>`);
    }
  }
  bits.push(`<span class="muted">${plan.sameCount} dosya aynı · ${fmtBytes(plan.bytes)} kopyalanacak</span>`);
  return bits.join(' · ');
}

function renderSyncPlanSummary() {
  if (!syncPlans) return;
  const lines = syncPlans.map((plan, planIndex) => {
    const name = path.basename(plan.dstRoot) || plan.dstRoot;
    return `<div class="mirrorline"><b>${escapeHtml(name)}</b>: ${describePlan(plan, planIndex)}</div>`;
  });
  $('syncSummary').innerHTML = lines.join('');
}

function buildMirrorOnlyTree(files, planIndex) {
  const root = { name: '', rel: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.rel.split('/');
    const fileName = parts.pop();
    let node = root;
    let rel = '';
    for (const part of parts) {
      rel = rel ? rel + '/' + part : part;
      if (!node.folders.has(part)) {
        node.folders.set(part, { name: part, rel, folders: new Map(), files: [] });
      }
      node = node.folders.get(part);
    }
    node.files.push({
      name: fileName,
      file,
      key: mirrorOnlyKey(planIndex, file.rel),
    });
  }

  const finish = (node) => {
    node.folderList = Array.from(node.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    node.files.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    node.keys = node.files.map((f) => f.key);
    node.count = node.files.length;
    node.size = node.files.reduce((sum, f) => sum + f.file.size, 0);
    const searchParts = node.files.map((f) => f.file.rel);
    for (const child of node.folderList) {
      finish(child);
      for (const key of child.keys) node.keys.push(key);
      node.count += child.count;
      node.size += child.size;
      searchParts.push(child.searchText);
    }
    node.searchText = searchParts.join('\n').toLocaleLowerCase('tr');
  };
  finish(root);
  return root;
}

function setSelection(keys, checked) {
  for (const key of keys) {
    if (checked) selectedMirrorOnly.add(key);
    else selectedMirrorOnly.delete(key);
  }
  $('mirrorOnlyConflict').textContent = '';
  $('mirrorOnlyConflict').classList.add('hidden');
  refreshMirrorOnlySelection();
}

function getSelectableMirrorOnlyKeys(keys) {
  const query = $('mirrorOnlySearch').value.trim().toLocaleLowerCase('tr');
  if (!query) return keys;
  return keys.filter((key) => {
    const searchText = mirrorOnlySearchByKey.get(key);
    return searchText && searchText.includes(query);
  });
}

function bindMirrorOnlyCheckbox(checkbox, keys) {
  mirrorOnlyCheckboxBindings.push({ checkbox, keys });
  checkbox.addEventListener('change', () => {
    setSelection(getSelectableMirrorOnlyKeys(keys), checkbox.checked);
  });
}

function renderMirrorOnlyFile(parent, item, plan, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row tree-file';
  row.style.paddingLeft = (8 + Math.min(depth, 5) * 15) + 'px';
  row.title = item.file.rel;

  const spacer = document.createElement('button');
  spacer.className = 'tree-toggle';
  spacer.disabled = true;
  spacer.tabIndex = -1;
  spacer.setAttribute('aria-hidden', 'true');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tree-check';
  checkbox.id = 'mirror-only-' + (++mirrorOnlyDomId);
  checkbox.setAttribute('aria-label', `${item.file.rel} dosyasını A'ya al`);
  bindMirrorOnlyCheckbox(checkbox, [item.key]);
  mirrorOnlySearchByKey.set(item.key, item.file.rel.toLocaleLowerCase('tr'));

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '•';
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('label');
  label.className = 'tree-label';
  label.htmlFor = checkbox.id;
  label.textContent = item.name;

  const meta = document.createElement('span');
  meta.className = 'tree-meta';
  meta.textContent = fmtBytes(item.file.size);

  row.append(spacer, checkbox, icon, label, meta);
  row.addEventListener('contextmenu', (ev) => {
    openCtxMenu(ev, path.join(plan.dstRoot, item.file.rel), false);
  });
  parent.appendChild(row);
  mirrorOnlyFileBindings.push({
    row,
    searchText: item.file.rel.toLocaleLowerCase('tr'),
  });
}

function setFolderExpanded(binding, forceOpen) {
  const open = forceOpen === undefined ? binding.expanded : forceOpen;
  binding.children.classList.toggle('collapsed', !open);
  binding.toggle.textContent = open ? '▾' : '▸';
  binding.toggle.setAttribute('aria-expanded', String(open));
}

function renderMirrorOnlyFolder(parent, node, plan, depth) {
  const branch = document.createElement('div');
  branch.className = 'tree-branch';

  const row = document.createElement('div');
  row.className = 'tree-row tree-folder';
  row.style.paddingLeft = (8 + Math.min(depth, 5) * 15) + 'px';

  const toggle = document.createElement('button');
  toggle.className = 'tree-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', `${node.name} klasörünü aç veya kapat`);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tree-check';
  checkbox.setAttribute('aria-label', `${node.rel} klasöründeki dosyaları A'ya al`);
  checkbox.id = 'mirror-only-' + (++mirrorOnlyDomId);
  bindMirrorOnlyCheckbox(checkbox, node.keys);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '▰';
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('label');
  label.className = 'tree-label';
  label.htmlFor = checkbox.id;
  label.textContent = node.name;

  const meta = document.createElement('span');
  meta.className = 'tree-meta';
  meta.textContent = `${node.count} · ${fmtBytes(node.size)}`;

  row.append(toggle, checkbox, icon, label, meta);
  branch.appendChild(row);

  const children = document.createElement('div');
  children.className = 'tree-children';
  branch.appendChild(children);
  parent.appendChild(branch);

  const binding = {
    branch,
    children,
    toggle,
    searchText: node.searchText,
    expanded: depth === 0,
  };
  mirrorOnlyFolderBindings.push(binding);
  toggle.addEventListener('click', () => {
    binding.expanded = !binding.expanded;
    setFolderExpanded(binding);
  });
  setFolderExpanded(binding);

  node.folderList.forEach((child) => renderMirrorOnlyFolder(children, child, plan, depth + 1));
  node.files.forEach((file) => renderMirrorOnlyFile(children, file, plan, depth + 1));
}

function countMirrorOnlyFolders(files) {
  const folders = new Set();
  for (const file of files) {
    const parts = file.rel.split('/');
    parts.pop();
    let rel = '';
    for (const part of parts) {
      rel = rel ? rel + '/' + part : part;
      folders.add(rel);
    }
  }
  return folders.size;
}

function renderMirrorOnlyTree(plan, planIndex) {
  if (!plan.mirrorOnly.length) return;
  const tree = buildMirrorOnlyTree(plan.mirrorOnly, planIndex);
  const card = document.createElement('div');
  card.className = 'mirror-tree';

  const head = document.createElement('div');
  head.className = 'mirror-tree-head';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tree-check';
  checkbox.setAttribute('aria-label', `${path.basename(plan.dstRoot) || plan.dstRoot} aynasındaki tüm dosyaları seç`);
  bindMirrorOnlyCheckbox(checkbox, tree.keys);
  const name = document.createElement('span');
  name.className = 'mirror-tree-name';
  name.textContent = path.basename(plan.dstRoot) || plan.dstRoot;
  name.title = plan.dstRoot;
  const meta = document.createElement('span');
  meta.className = 'mirror-tree-meta';
  meta.textContent = `${tree.count} dosya · ${fmtBytes(tree.size)}`;
  head.append(checkbox, name, meta);
  card.appendChild(head);

  tree.folderList.forEach((folder) => renderMirrorOnlyFolder(card, folder, plan, 0));
  tree.files.forEach((file) => renderMirrorOnlyFile(card, file, plan, 0));
  $('mirrorOnlyTrees').appendChild(card);
  mirrorOnlyTreeBindings.push({ card, searchText: tree.searchText });
}

function applyMirrorOnlyFilter() {
  const query = $('mirrorOnlySearch').value.trim().toLocaleLowerCase('tr');
  mirrorOnlyFileBindings.forEach((binding) => {
    binding.row.classList.toggle('filtered-out', Boolean(query) && !binding.searchText.includes(query));
  });
  mirrorOnlyFolderBindings.forEach((binding) => {
    const matches = !query || binding.searchText.includes(query);
    binding.branch.classList.toggle('filtered-out', !matches);
    setFolderExpanded(binding, query ? matches : undefined);
  });
  mirrorOnlyTreeBindings.forEach((binding) => {
    binding.card.classList.toggle('filtered-out', Boolean(query) && !binding.searchText.includes(query));
  });
  refreshMirrorOnlySelection();
}

function renamesPending() {
  return Boolean(syncPlans && syncPlans.some((p) => p.renames && p.renames.length));
}

function updateApplySyncState() {
  const selectedCount = selectedMirrorOnly.size;
  const forwardWork = Boolean(syncPlans && syncPlans.some(hasForwardWork));
  const waitingForDecision = Boolean(
    syncPlans && syncPlans.some((p) => p.mirrorOnly.length) && !mirrorOnlyDecisionConfirmed
  ) || (renamesPending() && !renameDecision);
  $('applySync').disabled = waitingForDecision || (!forwardWork && selectedCount === 0);
  $('applySync').textContent = (renamesPending() && renameDecision === 'source')
    ? "A'da yeniden adlandır"
    : selectedCount ? `${selectedCount} dosyayı A'ya al` : 'Eşitle';
}

function renderRenameReview() {
  const plansWithRenames = (syncPlans || []).filter((p) => p.renames && p.renames.length);
  if (!plansWithRenames.length) {
    $('renameReview').classList.add('hidden');
    return;
  }
  const list = $('renameList');
  list.innerHTML = '';
  let files = 0, bytes = 0;
  syncPlans.forEach((plan) => {
    if (!plan.renames.length) return;
    const name = path.basename(plan.dstRoot) || plan.dstRoot;
    if (syncPlans.length > 1) {
      const head = document.createElement('div');
      head.className = 'rename-mirror-head';
      head.textContent = name;
      list.appendChild(head);
    }
    for (const r of plan.renames) {
      files++; bytes += r.size;
      const row = document.createElement('div');
      row.className = 'rename-row';
      row.title = `B: ${r.fromRel}\nA: ${r.rel}`;
      const from = document.createElement('span');
      from.className = 'from';
      from.textContent = 'B: ' + r.fromRel;
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '⇄';
      const to = document.createElement('span');
      to.className = 'to';
      to.textContent = 'A: ' + r.rel;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = fmtBytes(r.size);
      row.append(from, arrow, to, size);
      row.addEventListener('contextmenu', (ev) => openCtxMenu(ev, path.join(plan.dstRoot, r.fromRel), false));
      list.appendChild(row);
    }
  });
  $('renameStats').textContent = `${plansWithRenames.length} ayna · ${files} dosya · ${fmtBytes(bytes)} — kopyalamadan çözülebilir`;
  document.querySelectorAll('input[name="renameMode"]').forEach((radio) => {
    radio.checked = radio.value === renameDecision;
  });
  $('renameReview').classList.remove('hidden');
}

function setRenameDecision(value) {
  renameDecision = value;
  document.querySelectorAll('input[name="renameMode"]').forEach((radio) => {
    radio.checked = radio.value === value;
  });
  const label = {
    mirror: "B'deki dosyalar A'daki ada taşınacak.",
    source: "A'daki dosyalar B'deki ada taşınacak; sonra güncel plan gösterilecek.",
    skip: "Ad farkına dokunulmayacak; A'daki adla kopyalanacak.",
  }[value];
  log('Ad farkı kararı: ' + label);
  renderSyncPlanSummary();
  updateApplySyncState();
}

function refreshMirrorOnlySelection() {
  mirrorOnlyCheckboxBindings.forEach((binding) => {
    const selectableKeys = getSelectableMirrorOnlyKeys(binding.keys);
    const selectedCount = selectableKeys.reduce(
      (count, key) => count + (selectedMirrorOnly.has(key) ? 1 : 0), 0
    );
    binding.checkbox.checked = selectableKeys.length > 0 && selectedCount === selectableKeys.length;
    binding.checkbox.indeterminate = selectedCount > 0 && selectedCount < selectableKeys.length;
  });

  const allKeys = getSelectableMirrorOnlyKeys(getAllMirrorOnlyKeys());
  const selectAll = $('selectAllMirrorOnly');
  const selectedVisible = allKeys.reduce(
    (count, key) => count + (selectedMirrorOnly.has(key) ? 1 : 0), 0
  );
  selectAll.checked = allKeys.length > 0 && selectedVisible === allKeys.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < allKeys.length;

  const entries = getSelectedMirrorOnlyEntries();
  const bytes = entries.reduce((sum, entry) => sum + entry.file.size, 0);
  $('mirrorOnlySelected').textContent = entries.length
    ? `${entries.length} dosya · ${fmtBytes(bytes)} seçili`
    : '0 öğe seçili';
  $('confirmMirrorOnly').disabled = entries.length === 0;
  updateApplySyncState();
}

function showMirrorOnlyEditor() {
  mirrorOnlyDecisionConfirmed = false;
  $('mirrorOnlyEditor').classList.remove('hidden');
  $('mirrorOnlyDecision').classList.add('hidden');
  renderSyncPlanSummary();
  refreshMirrorOnlySelection();
  $('mirrorOnlySearch').focus();
}

function confirmMirrorOnlyDecision(takeSelected) {
  if (!takeSelected) selectedMirrorOnly.clear();
  mirrorOnlyDecisionConfirmed = true;
  const total = getAllMirrorOnlyKeys().length;
  const selected = selectedMirrorOnly.size;
  $('mirrorOnlyDecisionText').textContent = selected
    ? `${selected} dosya A'ya alınacak · ${total - selected} dosya B'de yerinde kalacak.`
    : `${total} dosyanın tamamı B'de yerinde kalacak.`;
  $('mirrorOnlyEditor').classList.add('hidden');
  $('mirrorOnlyDecision').classList.remove('hidden');
  renderSyncPlanSummary();
  refreshMirrorOnlySelection();
  if (!$('applySync').disabled) $('applySync').focus();
  else $('changeMirrorOnlyDecision').focus();
  log(selected ? `${selected} aynaya özgü dosya A'ya alınmak üzere seçildi.`
               : 'Aynaya özgü dosyalar B\'de bırakılacak.');
}

function renderMirrorOnlyReview() {
  resetMirrorOnlyReview();
  const plansWithFiles = syncPlans.filter((p) => p.mirrorOnly.length);
  renderRenameReview();
  if (!plansWithFiles.length) {
    updateApplySyncState();
    return;
  }

  selectedMirrorOnly = new Set();
  mirrorOnlyDecisionConfirmed = false;
  $('mirrorOnlyReview').classList.remove('hidden');
  const files = plansWithFiles.reduce((sum, p) => sum + p.mirrorOnly.length, 0);
  const bytes = plansWithFiles.reduce(
    (sum, p) => sum + p.mirrorOnly.reduce((n, f) => n + f.size, 0), 0
  );
  const folders = plansWithFiles.reduce((sum, p) => sum + countMirrorOnlyFolders(p.mirrorOnly), 0);
  $('mirrorOnlyStats').textContent =
    `${plansWithFiles.length} ayna · ${folders} klasör · ${files} dosya · ${fmtBytes(bytes)}`;
  syncPlans.forEach(renderMirrorOnlyTree);
  applyMirrorOnlyFilter();
  refreshMirrorOnlySelection();
}

function prepareMirrorOnlyImports(plans, selectedKeys) {
  const groups = new Map();
  const allGroups = new Map();
  plans.forEach((plan, planIndex) => {
    plan.mirrorOnly.forEach((file) => {
      const choice = {
        plan,
        file,
        key: mirrorOnlyKey(planIndex, file.rel),
      };
      if (!allGroups.has(file.rel)) allGroups.set(file.rel, []);
      allGroups.get(file.rel).push(choice);
      if (selectedKeys.has(choice.key)) {
        if (!groups.has(file.rel)) groups.set(file.rel, []);
        groups.get(file.rel).push(choice);
      }
    });
  });

  const files = [];
  const errors = [];
  let duplicateCount = 0;
  for (const [rel, choices] of groups) {
    const current = [];
    const allChoices = allGroups.get(rel) || choices;
    for (const choice of allChoices) {
      const src = path.join(choice.plan.dstRoot, rel);
      try {
        const st = fs.statSync(src);
        if (!st.isFile() || st.size !== choice.file.size ||
            Math.abs(st.mtimeMs - choice.file.mtimeMs) >= 2000) {
          errors.push(`${rel}: ${path.basename(choice.plan.dstRoot) || choice.plan.dstRoot} içindeki dosya taramadan sonra değişti.`);
          continue;
        }
        const currentFingerprint = fingerprint(src, choice.file.size);
        if (currentFingerprint !== choice.file.contentFingerprint) {
          errors.push(`${rel}: ${path.basename(choice.plan.dstRoot) || choice.plan.dstRoot} içindeki dosyanın içeriği değişti.`);
          continue;
        }
        current.push({
          plan: choice.plan,
          file: choice.file,
          key: choice.key,
          src,
          currentFingerprint,
          currentFullFingerprint: choice.file.fullContentFingerprint,
        });
      } catch (e) {
        errors.push(`${rel}: ${path.basename(choice.plan.dstRoot) || choice.plan.dstRoot} içindeki dosya okunamıyor.`);
      }
    }
    if (current.length !== allChoices.length) continue;

    const selectedCurrent = current.filter((choice) => selectedKeys.has(choice.key));
    const chosen = selectedCurrent[0];
    const conflicting = current.filter(
      (choice) => !choice.currentFullFingerprint ||
                  choice.currentFullFingerprint !== chosen.currentFullFingerprint
    );
    if (conflicting.length) {
      const names = conflicting.map(
        (choice) => path.basename(choice.plan.dstRoot) || choice.plan.dstRoot
      ).join(', ');
      errors.push(`${rel}: ${names} içinde farklı bir sürüm var. Sessizce üzerine yazmamak için işlem durdu; aynaları ayrı ayrı çöz.`);
      continue;
    }
    duplicateCount += selectedCurrent.length - 1;

    const dst = path.join(plans[0].srcRoot, rel);
    if (fs.existsSync(dst)) {
      errors.push(`${rel}: A'da taramadan sonra bir dosya oluştu; üzerine yazılmadı.`);
      continue;
    }
    files.push({
      rel,
      src: chosen.src,
      dst,
      srcRoot: chosen.plan.dstRoot,
      dstRoot: plans[0].srcRoot,
      size: chosen.file.size,
      mtimeMs: chosen.file.mtimeMs,
      contentFingerprint: chosen.currentFingerprint,
      fullContentFingerprint: chosen.currentFullFingerprint,
    });
  }
  return {
    files,
    errors,
    duplicateCount,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

async function importMirrorOnlyFiles(prepared, progress) {
  const report = { copied: 0, errors: [], bytes: 0 };
  for (let i = 0; i < prepared.files.length; i++) {
    const file = prepared.files[i];
    let tmp = null;
    try {
      tmp = await stageVerifiedCopy(file.src, file.dst, file.size,
                                    file.fullContentFingerprint, (n) => {
        report.bytes += n;
        progress({
          label: file.rel,
          doneFiles: i,
          totalFiles: prepared.files.length,
          doneBytes: report.bytes,
          totalBytes: prepared.bytes,
        });
      }, { srcRoot: file.srcRoot, dstRoot: file.dstRoot });
      assertSafePath(file.dstRoot, file.dst);
      await installTempNoOverwrite(tmp, file.dst);
      tmp = null;
      report.copied++;
      progress({
        label: file.rel,
        doneFiles: i + 1,
        totalFiles: prepared.files.length,
        doneBytes: report.bytes,
        totalBytes: prepared.bytes,
      });
    } catch (e) {
      if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
      report.errors.push(`${file.rel}: ${e.message}`);
      break;
    }
  }
  return report;
}

async function importAndRefreshPlans(plans, prepared, progress, options) {
  options = options || {};
  const imported = await importMirrorOnlyFiles(prepared, progress);
  if (imported.errors.length) {
    return { imported, plans: null };
  }
  if (options.afterImports) {
    await options.afterImports({ imported, prepared });
  }
  const refreshed = await refreshSyncPlans(plans, 'A güncellendi', {
    deep: true,
    onProgress: options.onRefreshProgress,
  });
  return { imported, plans: refreshed.plans };
}

/* ── Aynaya Bağla akışı ──────────────────────────────────────── */

let relinkPlan = null;

const RELINK_ROOTS = [
  { id: 'p0', label: 'Kaynak' },
  { id: 'p1', label: 'Ayna 1' },
  { id: 'p2', label: 'Ayna 2' },
];

function refreshRelinkRoots() {
  const fromSel = $('relinkFrom');
  const toSel = $('relinkTo');
  if (!fromSel || !toSel || typeof fromSel.appendChild !== 'function') return;
  const available = RELINK_ROOTS
    .map((r) => ({ id: r.id, label: r.label, value: $(r.id).value.trim() }))
    .filter((r) => r.value);
  const fill = (sel, preferred) => {
    const previous = sel.value;
    sel.innerHTML = '';
    for (const r of available) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.label} · ${path.basename(r.value) || r.value}`;
      opt.title = r.value;
      sel.appendChild(opt);
    }
    const ids = available.map((r) => r.id);
    sel.value = ids.includes(previous) ? previous : (ids.includes(preferred) ? preferred : (ids[0] || ''));
  };
  fill(fromSel, 'p0');
  fill(toSel, 'p1');
  if (available.length >= 2 && fromSel.value === toSel.value) {
    toSel.value = available.find((r) => r.id !== fromSel.value).id;
  }
  $('scanRelink').disabled = available.length < 2;
}

function relinkRootValue(selectId) {
  const id = $(selectId).value;
  return id ? $(id).value.trim() : '';
}

function invalidateRelink() {
  relinkPlan = null;
  $('applyRelink').disabled = true;
  $('relinkSummary').textContent = '';
  $('relinkList').innerHTML = '';
  $('relinkOptions').classList.add('hidden');
}

function selectedRelinkEntries() {
  if (!relinkPlan) return [];
  const out = relinkPlan.direct.slice();
  if ($('relinkRenamed').checked) out.push(...relinkPlan.renamed);
  if ($('relinkUnverified').checked) out.push(...relinkPlan.unverified);
  return out;
}

function updateApplyRelinkState() {
  const n = selectedRelinkEntries().length;
  $('applyRelink').disabled = n === 0;
  $('applyRelink').textContent = n ? `${n} dosyayı bağla` : 'Bağla';
}

function renderRelinkPlan() {
  const plan = relinkPlan;
  const list = $('relinkList');
  list.innerHTML = '';
  if (!plan) return;
  const toName = path.basename(plan.toRoot) || plan.toRoot;
  const parts = [];
  parts.push(`<span class="ok">${plan.direct.length} dosya ${escapeHtml(toName)} içinde aynı yolda, içerik doğrulandı</span>`);
  if (plan.renamed.length) parts.push(`<span class="warn">${plan.renamed.length} dosya aynı içerik, farklı ad/yol</span>`);
  if (plan.unverified.length) parts.push(`<span class="muted">${plan.unverified.length} dosya kaynakta çevrimdışı; hedefte yalnızca yol eşleşiyor</span>`);
  if (plan.differs.length) parts.push(`<span class="err">${plan.differs.length} dosyanın hedefteki kopyası farklı içerikte (eşitle)</span>`);
  if (plan.missing.length) parts.push(`<span class="err">${plan.missing.length} dosya hedefte yok (eşitle)</span>`);
  if (plan.ambiguous.length) parts.push(`<span class="err">${plan.ambiguous.length} dosya için hedefte aynı içerikten birden çok aday var</span>`);
  if (plan.elsewhere) parts.push(`<span class="muted">${plan.elsewhere} öğe başka bir yerde (dokunulmadı)</span>`);
  parts.push(`<span class="muted">${plan.total} medya öğesi tarandı</span>`);
  $('relinkSummary').innerHTML = parts.join('<br>');

  const addRow = (cls, mainText, subText, sizeLabel, ctxPath) => {
    const li = document.createElement('li');
    if (cls) li.classList.add(cls);
    const sp = document.createElement('span');
    sp.className = 'fpath';
    sp.textContent = mainText;
    if (subText) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = '  ' + subText;
      sp.appendChild(document.createElement('br'));
      sp.appendChild(sub);
    }
    const sz = document.createElement('span');
    sz.className = 'fsize';
    sz.textContent = sizeLabel;
    li.append(sp, sz);
    if (ctxPath) li.addEventListener('contextmenu', (ev) => openCtxMenu(ev, ctxPath, false));
    list.appendChild(li);
  };
  for (const e of plan.renamed) addRow('renamed', e.rel, '→ ' + e.newRel, fmtBytes(e.size), e.oldPath);
  for (const e of plan.unverified) addRow('unverified', e.rel, 'kaynak çevrimdışı · yol eşleşiyor', fmtBytes(e.size), e.newPath);
  for (const e of plan.differs) addRow('offline', e.rel, 'hedefteki kopya farklı içerikte', 'farklı', e.oldPath);
  for (const e of plan.missing) addRow('offline', e.rel, e.offline ? 'kaynakta da yok' : 'hedefte yok', e.size === null ? 'offline' : fmtBytes(e.size), e.oldPath);
  for (const e of plan.ambiguous) addRow('offline', e.rel, 'adaylar: ' + e.candidates.join(' · '), 'belirsiz', e.oldPath);

  $('relinkRenamedLabel').textContent = `Adı/yolu farklı ama içeriği aynı olanları da bağla (${plan.renamed.length})`;
  $('relinkUnverifiedLabel').textContent = `Kaynağı çevrimdışı, yalnızca yolu eşleşenleri de bağla (${plan.unverified.length}) — doğrulanamadı`;
  $('relinkRenamed').disabled = !plan.renamed.length;
  $('relinkUnverified').disabled = !plan.unverified.length;
  $('relinkOptions').classList.remove('hidden');
  updateApplyRelinkState();
}

async function doScanRelink() {
  const from = relinkRootValue('relinkFrom');
  const to = relinkRootValue('relinkTo');
  if (!from || !to) { log('Eşitle bölümünde en az iki disk seçili olmalı.', 'warn'); return; }
  if (pathsOverlap(from, to)) { log('Şimdiki disk ile hedef disk aynı veya iç içe olamaz.', 'err'); return; }
  if (!fs.existsSync(from)) { log('Şimdiki disk bulunamadı (takılı mı?): ' + from, 'err'); return; }
  if (!fs.existsSync(to)) { log('Hedef disk bulunamadı (takılı mı?): ' + to, 'err'); return; }

  invalidateRelink();
  $('scanRelink').disabled = true;
  lockSyncPathControls();
  showProgress('Proje medyası hedef diskte aranıyor…');
  armStop();
  try {
    const res = await callJSX('getMediaPaths');
    if (!res.ok) { log('Proje taranamadı: ' + res.err, 'err'); return; }
    const plan = await buildRelinkPlan(res.items, from, to, (p) => {
      setProgress(p.doneFiles / (p.totalFiles || 1),
        `${p.doneFiles}/${p.totalFiles}` + (p.rel ? ' · ' + p.rel : ''));
    });
    disarmStop();
    relinkPlan = plan;
    renderRelinkPlan();
    const linkable = plan.direct.length + plan.renamed.length;
    log(`Bağlama taraması bitti: ${linkable} dosya hedefte doğrulandı` +
        (plan.renamed.length ? ` (${plan.renamed.length} farklı adla)` : '') +
        (plan.missing.length + plan.differs.length ? `, ${plan.missing.length + plan.differs.length} dosya için önce eşitleme gerek` : '') + '.',
        linkable ? undefined : 'warn');
  } catch (e) {
    if (e.stopped) log('Bağlama taraması durduruldu.', 'warn');
    else log('Bağlama taraması hatası: ' + e.message, 'err');
  } finally {
    disarmStop();
    hideProgress();
    unlockSyncPathControls();
    refreshRelinkRoots();
  }
}

async function doApplyRelink() {
  const entries = selectedRelinkEntries();
  if (!entries.length) return;
  const plan = relinkPlan;
  $('applyRelink').disabled = true;
  $('scanRelink').disabled = true;
  lockSyncPathControls();
  showProgress('Proje yeniden bağlanıyor…');
  let linkedItems = 0, skipped = 0;
  const errors = [];
  try {
    const BATCH = 150;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      // Yeni yol hâlâ yerinde mi? (tarama ile bağlama arasında disk çekilmiş olabilir)
      const pairs = [];
      for (const e of batch) {
        if (fs.existsSync(e.newPath)) pairs.push([e.oldPath, e.newPath]);
        else errors.push(`${e.rel}: hedef dosya artık yok (${e.newPath})`);
      }
      if (pairs.length) {
        const rl = await callJSX('relinkMany', pairs);
        if (!rl.ok) { errors.push('Premiere bağlama hatası: ' + rl.err); break; }
        linkedItems += rl.count;
        skipped += rl.skipped;
      }
      setProgress(Math.min(1, (i + batch.length) / entries.length),
        `${Math.min(i + batch.length, entries.length)}/${entries.length} dosya`);
      await tick();
    }
    const toName = path.basename(plan.toRoot) || plan.toRoot;
    const msg = `Bitti: ${linkedItems} proje öğesi ${toName} içine bağlandı` +
                (skipped ? `, ${skipped} öğe değiştirilemedi` : '') +
                (errors.length ? `, ${errors.length} hata` : '') + '.';
    log(msg, errors.length || skipped ? 'warn' : 'ok');
    for (const e of errors) log(e, 'err');
    const leftover = plan.missing.length + plan.differs.length + plan.ambiguous.length;
    $('relinkSummary').innerHTML = `<span class="${errors.length ? 'warn' : 'ok'}">${escapeHtml(msg)}</span>` +
      (leftover ? `<br><span class="muted">${leftover} dosya bağlanmadı (hedefte yok/farklı/belirsiz); Eşitle ile tamamlayıp yeniden tara.</span>` : '');
  } finally {
    hideProgress();
    unlockSyncPathControls();
    relinkPlan = null;
    $('relinkList').innerHTML = '';
    $('relinkOptions').classList.add('hidden');
    $('applyRelink').disabled = true;
    $('applyRelink').textContent = 'Bağla';
    refreshRelinkRoots();
  }
}

async function doScanSync() {
  const { src, mirrors } = getSyncPaths();
  if (!src || !mirrors.length) { log('Kaynak ve en az bir ayna seç.', 'warn'); return; }
  if (!fs.existsSync(src)) { log('Kaynak bulunamadı (disk takılı mı?): ' + src, 'err'); return; }
  for (const m of mirrors) {
    if (!fs.existsSync(m)) { log('Ayna bulunamadı (disk takılı mı?): ' + m, 'err'); return; }
    if (pathsOverlap(src, m)) { log('Kaynak ile ayna iç içe olamaz: ' + m, 'err'); return; }
  }
  const [m1, m2] = mirrors;
  if (m2 && pathsOverlap(m1, m2)) { log('İki ayna iç içe olamaz.', 'err'); return; }

  invalidateSync();
  const operationGeneration = syncGeneration;
  const operationPathSignature = syncPathSignature(src, mirrors);
  $('scanSync').disabled = true;
  lockSyncPathControls();
  showProgress('Tam içerik taranıyor…');
  armStop();
  try {
    const seeds = mirrors.map((dstRoot) => ({ srcRoot: src, dstRoot }));
    const scanResult = await refreshSyncPlans(seeds, 'Tarama', { deep: true });
    disarmStop();
    if (!syncOperationIsCurrent(operationGeneration, operationPathSignature)) {
      log('Disk seçimi tarama sırasında değişti. Eski tarama sonucu kullanılmadı.', 'warn');
      invalidateSync();
      return;
    }
    syncPlans = scanResult.plans;
    for (let i = 0; i < syncPlans.length; i++) {
      const plan = syncPlans[i];
      const dn = plan.overwrites.filter((o) => o.destNewer).length;
      if (dn) log(`Dikkat: ${mirrors[i]} içinde ${dn} dosya kaynaktakinden DAHA YENİ görünüyor; eşitlersen yedeklenip üzerine yazılır.`, 'warn');
    }
    renderMirrorOnlyReview();
    renderSyncPlanSummary();
    const anyWork = syncPlans.some(hasForwardWork);
    const decisionCount = syncPlans.reduce((sum, p) => sum + p.mirrorOnly.length, 0);
    if (decisionCount) {
      log(`Tarama bitti. Aynaya özgü ${decisionCount} dosya için kararını bekliyorum.`, 'warn');
    } else {
      log('Tarama bitti.' + (anyWork ? '' : ' A → B zaten tamam.'), anyWork ? undefined : 'ok');
    }
  } catch (e) {
    if (e.stopped) {
      log('Tarama durduruldu. Hiçbir dosyaya dokunulmadı.', 'warn');
      invalidateSync();
    } else if (syncOperationIsCurrent(operationGeneration, operationPathSignature)) {
      log('Tarama hatası: ' + e.message, 'err');
      invalidateSync();
    }
  } finally {
    disarmStop();
    hideProgress();
    $('scanSync').disabled = false;
    unlockSyncPathControls();
  }
}

async function doApplySync() {
  if (!syncPlans || !syncPlans.length) return;
  if (syncPlans.some((p) => p.mirrorOnly.length) && !mirrorOnlyDecisionConfirmed) {
    log('Önce aynaya özgü dosyalar için kararını ver.', 'warn');
    return;
  }
  const operationGeneration = syncGeneration;
  const operationPathSignature = currentSyncPathSignature();
  if (planSetPathSignature(syncPlans) !== operationPathSignature) {
    log('Disk seçimi taramadan sonra değişti. Yeniden Tara.', 'warn');
    invalidateSync();
    return;
  }
  $('applySync').disabled = true;
  $('scanSync').disabled = true;
  lockSyncPathControls();

  let completed = false;
  try {
    showProgress('Tam içerik kontrolü yapılıyor…');
    armStop(); // yalnızca okuma yapan ön kontrol; yazma başlamadan kapatılır
    const latestResult = await refreshSyncPlans(syncPlans, 'Kontrol', { deep: true });
    disarmStop();
    if (!syncOperationIsCurrent(operationGeneration, operationPathSignature)) {
      log('Disk seçimi kontrol sırasında değişti. Eski plan uygulanmadı.', 'warn');
      invalidateSync();
      return;
    }
    const latestPlans = latestResult.plans;
    const planChanged = syncPlans.some(
      (plan, index) => planSignature(plan) !== planSignature(latestPlans[index])
    );
    if (planChanged) {
      syncPlans = latestPlans;
      renderMirrorOnlyReview();
      renderSyncPlanSummary();
      log('Disklerden biri taramadan sonra değişti. Güncel planı gösterdim; kararını yeniden ver.', 'warn');
      return;
    }
    syncPlans = latestPlans;

    if (renamesPending() && renameDecision === 'source') {
      // A değişecek; yazma işi budur, sonra plan yenilenir ve tekrar onay istenir.
      const preparedRenames = prepareSourceRenames(syncPlans);
      for (const error of preparedRenames.errors) log(error, 'err');
      showProgress("A'da yeniden adlandırılıyor…");
      const renameReport = await applySourceRenames(preparedRenames, (p) => {
        setProgress(p.doneFiles / (p.totalFiles || 1), `${p.doneFiles}/${p.totalFiles} · ${p.label}`);
      });
      for (const error of renameReport.errors) log(error, 'err');
      log(`A'da ${renameReport.renamed} dosya yeniden adlandırıldı.` +
          (renameReport.errors.length ? ` ${renameReport.errors.length} dosyaya dokunulmadı.` : ''),
          renameReport.errors.length ? 'warn' : 'ok');
      showProgress('Güncel A → B planı hazırlanıyor…');
      const refreshed = await refreshSyncPlans(syncPlans, 'A güncellendi', { deep: true });
      if (!syncOperationIsCurrent(operationGeneration, operationPathSignature)) {
        log('Disk seçimi işlem sırasında değişti. Yeniden Tara.', 'err');
        invalidateSync();
        return;
      }
      syncPlans = refreshed.plans;
      renderMirrorOnlyReview();
      renderSyncPlanSummary();
      if (renamesPending()) {
        // A artık bir aynanın adlarını taşıyor; öteki aynada aynı dosyalar şimdi
        // "yalnızca adı farklı" görünür. Doğal devam: onlara da aynı adı ver.
        setRenameDecision('mirror');
        log('Yeni adlar A\'da. Öteki aynadaki aynı dosyalar için "B\'de yeniden adlandır" seçili geldi; Eşitle ile onayla.', 'warn');
      }
      const stillWork = syncPlans.some(hasForwardWork) || syncPlans.some((p) => p.mirrorOnly.length);
      if (stillWork) {
        log('A güncellendi. Güncel A → B planını gösterdim; kararları yeniden ver ve onayla.', 'warn');
      } else {
        log('A güncellendi. A ve aynalar tam içerikle eşleşiyor.', 'ok');
        completed = true;
      }
      return;
    }

    const selectedKeys = new Set(selectedMirrorOnly);
    if (selectedKeys.size) {
      const prepared = prepareMirrorOnlyImports(syncPlans, selectedKeys);
      if (prepared.errors.length) {
        $('mirrorOnlyConflict').textContent = prepared.errors.join(' ');
        $('mirrorOnlyConflict').classList.remove('hidden');
        $('mirrorOnlyEditor').classList.remove('hidden');
        $('mirrorOnlyDecision').classList.add('hidden');
        mirrorOnlyDecisionConfirmed = false;
        renderSyncPlanSummary();
        for (const error of prepared.errors) log(error, 'err');
        log('Seçim uygulanmadı. Dosyaları yeniden tara veya çakışan seçimi değiştir.', 'warn');
        return;
      }

      showProgress("Seçilenler A'ya alınıyor…");
      let refreshShown = false;
      const importPhase = await importAndRefreshPlans(syncPlans, prepared, (p) => {
        const frac = p.totalBytes > 0 ? p.doneBytes / p.totalBytes
                                     : (p.totalFiles ? p.doneFiles / p.totalFiles : 1);
        setProgress(frac,
          `${p.doneFiles}/${p.totalFiles} dosya · ${fmtBytes(p.doneBytes)} / ${fmtBytes(p.totalBytes)}` +
          (p.label ? ` · ${p.label}` : ''));
      }, {
        onRefreshProgress: (p) => {
          if (!refreshShown) {
            refreshShown = true;
            showProgress('Güncel A → B planı hazırlanıyor…');
          }
          setProgress(p.fraction || 0,
            (p.name || '') + (p.rel ? ` · ${p.rel}` : ''));
        },
      });
      if (!syncOperationIsCurrent(operationGeneration, operationPathSignature)) {
        log('Disk seçimi A\'ya alma sırasında değişti. Sonucu kullanmadan önce yeniden Tara.', 'err');
        invalidateSync();
        return;
      }
      const imported = importPhase.imported;
      if (imported.errors.length) {
        for (const error of imported.errors) log(`A'ya alma hatası: ${error}`, 'err');
        log('A kısmen değişmiş olabilir. Devam etmeden önce yeniden Tara.', 'warn');
        invalidateSync();
        return;
      }
      log(`${imported.copied} dosya A'ya alındı.` +
          (prepared.duplicateCount ? ` ${prepared.duplicateCount} aynı kopya tekilleştirildi.` : ''), 'ok');

      // B → A alma ayrı bir güvenlik aşamasıdır. A değiştiği için yeni A → B
      // planını göster; aynı tıklamada aynaların üzerine yazma.
      syncPlans = importPhase.plans;
      renderMirrorOnlyReview();
      renderSyncPlanSummary();
      const forwardWork = syncPlans.some(hasForwardWork);
      const decisionsRemain = syncPlans.some((plan) => plan.mirrorOnly.length);
      if (forwardWork) {
        log('A güncellendi. Güncel A → B planını gösterdim; eşitlemek için yeniden onayla.', 'warn');
      } else if (decisionsRemain) {
        log('A\'ya alma tamamlandı. B\'de kalan dosyalar için güncel karar ağacını gösterdim.', 'warn');
      } else {
        log('A\'ya alma tamamlandı. A ve aynalar tam içerikle eşleşiyor.', 'ok');
        completed = true;
      }
      return;
    }

    // "Dokunma" kararı: ad farkları eski davranışa açılır (kopyala + B'de bırak).
    const effectivePlans = renameDecision === 'skip' ? syncPlans.map(expandRenames) : syncPlans;
    let shownPhase = '';
    const applied = await applyAllMirrors(effectivePlans, (event) => {
      if (event.phase === 'apply') {
        const plan = event.plan;
        const name = path.basename(plan.dstRoot) || plan.dstRoot;
        const phaseKey = 'apply:' + event.index;
        if (shownPhase !== phaseKey) {
          shownPhase = phaseKey;
          showProgress('Eşitleniyor → ' + name);
        }
        const p = event.progress;
        const frac = plan.bytes > 0 ? p.doneBytes / plan.bytes
                                    : (p.totalFiles ? p.doneFiles / p.totalFiles : 1);
        setProgress(frac,
          `${p.doneFiles}/${p.totalFiles} dosya` +
          (plan.bytes ? ` · ${fmtBytes(p.doneBytes)} / ${fmtBytes(plan.bytes)}` : '') +
          (p.label ? ` · ${p.label}` : ''));
      } else {
        if (shownPhase !== 'verify') {
          shownPhase = 'verify';
          showProgress('Tüm aynalar tam içerikle doğrulanıyor…');
        }
        const p = event.progress;
        setProgress(p.fraction || 0,
          (p.name || '') + (p.rel ? ` · ${p.rel}` : ''));
      }
    });
    if (!syncOperationIsCurrent(operationGeneration, operationPathSignature)) {
      log('Disk seçimi eşitleme sırasında değişti. Eski planın sonucu gizlendi; yeniden Tara.', 'err');
      invalidateSync();
      return;
    }

    const lines = [];
    for (let i = 0; i < syncPlans.length; i++) {
      const plan = syncPlans[i];
      const report = applied.reports[i];
      const verification = applied.finalPlans[i];
      const remaining = applied.remaining[i];
      const name = path.basename(plan.dstRoot) || plan.dstRoot;
      const ok = report.errors.length === 0 && applied.sourceStable &&
                 applied.mirrorOnlyStable[i] && remaining === 0;
      const msg = `${report.copied} kopyalandı, ${report.overwritten} güncellendi` +
                  (report.renamed ? `, ${report.renamed} yeniden adlandırıldı` : '') + ' · ' +
                  (remaining ? `${remaining} A → B farkı kaldı` : 'A → B tam içerik kontrolü geçti') +
                  (!applied.mirrorOnlyStable[i] ? ' · B’ye özgü dosya kararı değişti' :
                   (verification.mirrorOnly.length ? ` · ${verification.mirrorOnly.length} B'de bırakıldı` : '')) +
                  (report.errors.length ? ` · ${report.errors.length} HATA` : '');
      log(`${name}: ${msg}`, ok ? 'ok' : 'err');
      for (const e of report.errors) log(e, 'err');
      lines.push(`<div class="mirrorline"><b>${escapeHtml(name)}</b>: <span class="${ok ? 'ok' : 'err'}">${escapeHtml(msg)}</span></div>`);
      if (report.backupRoot) {
        log(`Yedekler: ${report.backupRoot}`);
      }
    }
    $('syncSummary').innerHTML = lines.join('');
    if (!applied.sourceStable) {
      log('A doğrulama sırasında değişti. Aynalara ortak bir master snapshotı doğrulanamadı.', 'err');
    }
    completed = applied.ok;
    if (!completed) {
      const hasApplyErrors = applied.reports.some((report) => report.errors.length);
      if (hasApplyErrors || !applied.sourceStable) {
        log('Plan kısmen uygulanmış olabilir. Devam etmeden önce yeniden Tara.', 'warn');
        invalidateSync();
      } else {
        syncPlans = applied.finalPlans;
        renderMirrorOnlyReview();
        renderSyncPlanSummary();
        if (applied.mirrorOnlyStable.some((stable) => !stable)) {
          log('B’ye özgü dosyalar işlem sırasında değişti. Güncel karar ağacını gösterdim.', 'warn');
        } else {
          log('Ortak son kontrolde fark kaldı. Güncel planı gösterdim; yeniden onayla.', 'warn');
        }
      }
    }
  } catch (e) {
    if (e.stopped) {
      log('Kontrol durduruldu. Hiçbir dosyaya dokunulmadı; plan duruyor.', 'warn');
    } else if (!syncOperationIsCurrent(operationGeneration, operationPathSignature)) {
      log('Disk seçimi işlem sırasında değişti. Devam etmeden önce yeniden Tara.', 'err');
      invalidateSync();
    } else {
      log('Eşitleme hatası: ' + e.message, 'err');
      log('Plan tüketilmiş veya kısmen uygulanmış olabilir. Devam etmeden önce yeniden Tara.', 'warn');
      invalidateSync();
    }
  } finally {
    disarmStop();
    hideProgress();
    $('scanSync').disabled = false;
    unlockSyncPathControls();
    if (completed) {
      syncPlans = null; // plan tüketildi; tekrar eşitlemek için yeni tarama gerek
      selectedMirrorOnly = new Set();
      $('mirrorOnlyReview').classList.add('hidden');
      $('applySync').disabled = true;
      $('applySync').textContent = 'Eşitle';
    } else if (syncPlans) {
      updateApplySyncState();
    }
  }
}

/* ── Sağ tık menüsü ──────────────────────────────────────────── */

let ctxPath = null;
let ctxOffline = false;

function copyToClipboard(text) {
  const p = cp.spawn('pbcopy');
  p.stdin.end(text);
}

function openCtxMenu(ev, p, offlineRow) {
  ev.preventDefault();
  ev.stopPropagation();
  ctxPath = p;
  ctxOffline = offlineRow;
  const m = $('ctxMenu');
  m.classList.remove('hidden');
  m.style.left = Math.max(4, Math.min(ev.pageX, document.documentElement.clientWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(ev.pageY, document.documentElement.clientHeight - m.offsetHeight - 8)) + 'px';
}

function closeCtxMenu() {
  $('ctxMenu').classList.add('hidden');
}

async function ctxAction(act) {
  const p = ctxPath;
  if (!p) return;
  if (act === 'copy') {
    copyToClipboard(p);
    log('Yol panoya kopyalandı.');
  } else if (act === 'finder') {
    if (fs.existsSync(p)) {
      cp.execFile('open', ['-R', p]);
    } else {
      const dir = path.dirname(p);
      if (fs.existsSync(dir)) {
        cp.execFile('open', [dir]);
        log('Dosya diskte yok; bulunduğu klasör açıldı.', 'warn');
      } else {
        log('Dosya da klasörü de diskte yok: ' + p, 'err');
      }
    }
  } else if (act === 'project') {
    const r = await callJSX('revealInProject', p);
    if (r.ok) {
      log(r.how === 'source' ? 'Source Monitor\'de açıldı: ' + path.basename(p)
                             : 'Proje panelinde seçildi: ' + path.basename(p), 'ok');
    } else {
      log('Projede gösterilemedi: ' + (r.err || 'bilinmeyen hata'), 'err');
    }
  }
}

/* ── Kablolama ───────────────────────────────────────────────── */

function init() {
  const s = loadSettings();
  if (s.target) $('targetPath').value = s.target;
  if (s.paths) ['p0', 'p1', 'p2'].forEach((id, i) => { if (s.paths[i]) $(id).value = s.paths[i]; });

  $('pickTarget').onclick = () => {
    const p = pickFolder('Medya klasörünü seç');
    if (p) { $('targetPath').value = p; saveSettings(); invalidateCollect(); }
  };
  document.querySelectorAll('button.pick').forEach((btn) => {
    btn.onclick = () => {
      const i = btn.dataset.i;
      const p = pickFolder(i === '0' ? 'Kaynak diski/klasörü seç' : 'Ayna diski/klasörü seç');
      if (p) { $('p' + i).value = p; saveSettings(); invalidateSync(); }
    };
  });
  document.querySelectorAll('button.clear').forEach((btn) => {
    btn.onclick = () => { $('p' + btn.dataset.i).value = ''; saveSettings(); invalidateSync(); };
  });

  $('ctxMenu').addEventListener('click', (ev) => {
    const act = ev.target && ev.target.dataset ? ev.target.dataset.act : null;
    closeCtxMenu();
    if (act) ctxAction(act);
  });
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('contextmenu', (ev) => {
    // liste satırları kendi menüsünü açıyor; başka yere sağ tıklanınca kapat
    if (!ev.target.closest || !ev.target.closest('.filelist li')) closeCtxMenu();
  });
  window.addEventListener('blur', closeCtxMenu);

  $('scanProject').onclick = doScanProject;
  $('applyCollect').onclick = doApplyCollect;
  $('scanSync').onclick = doScanSync;
  $('applySync').onclick = doApplySync;
  $('stopOp').onclick = requestStop;
  $('pauseOp').onclick = togglePause;
  document.querySelectorAll('input[name="renameMode"]').forEach((radio) => {
    radio.addEventListener('change', () => { if (radio.checked) setRenameDecision(radio.value); });
  });
  $('scanRelink').onclick = doScanRelink;
  $('applyRelink').onclick = doApplyRelink;
  $('relinkRenamed').addEventListener('change', updateApplyRelinkState);
  $('relinkUnverified').addEventListener('change', updateApplyRelinkState);
  $('relinkFrom').addEventListener('change', invalidateRelink);
  $('relinkTo').addEventListener('change', invalidateRelink);
  refreshRelinkRoots();
  $('mirrorOnlySearch').addEventListener('input', applyMirrorOnlyFilter);
  $('selectAllMirrorOnly').addEventListener('change', (ev) => {
    setSelection(getSelectableMirrorOnlyKeys(getAllMirrorOnlyKeys()), ev.target.checked);
  });
  $('clearMirrorOnly').onclick = () => setSelection(getAllMirrorOnlyKeys(), false);
  $('leaveMirrorOnly').onclick = () => confirmMirrorOnlyDecision(false);
  $('confirmMirrorOnly').onclick = () => confirmMirrorOnlyDecision(true);
  $('changeMirrorOnlyDecision').onclick = showMirrorOnlyEditor;

  // Hedef klasör hiç seçilmemişse proje klasörünü öner
  if (!$('targetPath').value) {
    callJSX('getProjectPath').then((r) => {
      if (r.ok && r.path && !$('targetPath').value) {
        $('targetPath').value = path.dirname(r.path);
        saveSettings();
      }
    }).catch(() => {});
  }

  log('Kement hazır.');
}

if (window.__adobe_cep__) {
  init();
} else {
  document.body.innerHTML = '<p style="padding:20px;color:#e06c65">Bu panel yalnızca Premiere Pro içinde çalışır.</p>';
}
