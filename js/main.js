'use strict';
/* Kement — panel mantığı.
 * İki iş: (1) Topla & Bağla — proje medyasını hedef klasöre toplayıp relink,
 *         (2) Eşitle — kaynak → ayna(lar) incremental mirror.
 * Kurallar: hiçbir dosyanın üzerine yedeksiz yazılmaz, silme yok (arşive taşınır),
 *           sadece adı/konumu değişen dosya kopyalanmaz, aynada yeniden adlandırılır.
 */

const req = (typeof require === 'function') ? require
          : (window.cep_node && window.cep_node.require);
const fs = req('fs');
const path = req('path');
const crypto = req('crypto');
const cp = req('child_process');

const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));

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

async function ensureJSX() {
  const t = await evalScript('typeof ESL');
  if (t !== 'object') {
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

function tsStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
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
  fs.mkdirSync(dir, { recursive: true });
}

function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pathsOverlap(a, b) {
  const ra = path.resolve(a), rb = path.resolve(b);
  return ra === rb || isInside(ra, rb) || isInside(rb, ra);
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

// root altındaki tüm dosyalar: {rel, size, mtimeMs}
async function walk(root) {
  const out = [];
  const stack = [''];
  let n = 0;
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const ent of entries) {
      if (SKIP_NAMES.has(ent.name) || ent.name.startsWith('._')) continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(path.join(root, childRel));
          out.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs });
        } catch (e) {}
      }
      if (++n % 400 === 0) await tick();
    }
  }
  return out;
}

// Hızlı parmak izi: boyut + baş/son 256KB sha1. Rename tespiti için yeterli,
// dev video dosyalarını baştan sona okumaktan kat kat hızlı.
function fingerprint(absPath, size) {
  const CH = 256 * 1024;
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(absPath, 'r');
  try {
    if (size > 0) {
      const head = Buffer.alloc(Math.min(CH, size));
      fs.readSync(fd, head, 0, head.length, 0);
      h.update(head);
      if (size > CH) {
        const tail = Buffer.alloc(Math.min(CH, size - CH));
        fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        h.update(tail);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return size + ':' + h.digest('hex');
}

function copyWithProgress(src, dst, onBytes) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dst));
    const tmp = dst + '.kement-part';
    const rs = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
    const ws = fs.createWriteStream(tmp);
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
    ws.on('close', () => {
      if (failed) return;
      try {
        const st = fs.statSync(src);
        fs.utimesSync(tmp, st.atime, st.mtime);
        fs.renameSync(tmp, dst); // kopya bitmeden hedefte yarım dosya görünmez
        resolve();
      } catch (e) { fail(e); }
    });
    rs.pipe(ws);
  });
}

// Taşıma/rename sonrası boş kalan klasörleri temizler (yedek klasörüne dokunmaz).
function pruneEmptyDirs(root) {
  const prune = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return false; }
    let empty = true;
    for (const ent of entries) {
      if (ent.name === BACKUP_DIR) { empty = false; continue; }
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!prune(p)) empty = false;
      } else if (ent.name === '.DS_Store') {
        continue; // tek başına .DS_Store klasörü dolu saymaz
      } else {
        empty = false;
      }
    }
    if (empty && dir !== root) {
      try {
        const leftover = fs.readdirSync(dir);
        for (const n of leftover) fs.unlinkSync(path.join(dir, n)); // sadece .DS_Store kalmış olabilir
        fs.rmdirSync(dir);
        return true;
      } catch (e) { return false; }
    }
    return empty;
  };
  prune(root);
}

/* ── Eşitleme planı ──────────────────────────────────────────── */

async function planMirror(srcRoot, dstRoot) {
  const srcList = await walk(srcRoot);
  const dstList = await walk(dstRoot);
  const srcMap = new Map(srcList.map((f) => [f.rel, f]));
  const dstMap = new Map(dstList.map((f) => [f.rel, f]));

  const plan = {
    srcRoot, dstRoot,
    copies: [],      // kaynakta var, aynada yok → kopyala
    overwrites: [],  // ikisinde de var ama farklı → yedekle + kopyala
    renames: [],     // aynı içerik farklı ad/konum → aynada yeniden adlandır
    extras: [],      // aynada var, kaynakta yok → arşive taşı
    sameCount: 0,
    bytes: 0,
  };

  const missing = [];
  for (const f of srcList) {
    const d = dstMap.get(f.rel);
    if (!d) {
      missing.push(f);
    } else if (d.size === f.size && Math.abs(d.mtimeMs - f.mtimeMs) < 2000) {
      plan.sameCount++;
    } else {
      plan.overwrites.push({ rel: f.rel, size: f.size, destNewer: d.mtimeMs > f.mtimeMs + 2000 });
    }
  }

  // Rename tespiti: kaynakta "yeni" görünen dosya, aynadaki "fazla" dosyalardan
  // biriyle aynı boyut + parmak iziyse, kopya değil yeniden adlandırmadır.
  const dstOnly = dstList.filter((f) => !srcMap.has(f.rel));
  const bySize = new Map();
  for (const f of dstOnly) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const claimed = new Set();
  let fpCount = 0;
  for (const f of missing) {
    let match = null;
    const cands = (bySize.get(f.size) || []).filter((c) => !claimed.has(c.rel));
    if (cands.length && f.size > 0) {
      let fpSrc = null;
      try { fpSrc = fingerprint(path.join(srcRoot, f.rel), f.size); } catch (e) {}
      if (fpSrc) {
        for (const c of cands) {
          try {
            if (fingerprint(path.join(dstRoot, c.rel), c.size) === fpSrc) { match = c; break; }
          } catch (e) {}
          if (++fpCount % 10 === 0) await tick();
        }
      }
    }
    if (match) {
      claimed.add(match.rel);
      plan.renames.push({ from: match.rel, to: f.rel, size: f.size });
    } else {
      plan.copies.push({ rel: f.rel, size: f.size });
      plan.bytes += f.size;
    }
  }
  for (const f of plan.overwrites) plan.bytes += f.size;
  plan.extras = dstOnly.filter((f) => !claimed.has(f.rel));
  return plan;
}

async function applyMirror(plan, progress) {
  const backupRoot = path.join(plan.dstRoot, BACKUP_DIR, tsStamp());
  const report = { copied: 0, overwritten: 0, renamed: 0, archived: 0, errors: [] };
  const totalFiles = plan.copies.length + plan.overwrites.length +
                     plan.renames.length + plan.extras.length;
  let doneFiles = 0, doneBytes = 0;

  const step = (label) => {
    doneFiles++;
    progress({ label, doneFiles, totalFiles, doneBytes, totalBytes: plan.bytes });
  };
  const onBytes = (n) => {
    doneBytes += n;
    progress({ doneFiles, totalFiles, doneBytes, totalBytes: plan.bytes });
  };

  // 1) Yeniden adlandırmalar (anlık, kopya yok)
  for (const r of plan.renames) {
    try {
      ensureDir(path.dirname(path.join(plan.dstRoot, r.to)));
      fs.renameSync(path.join(plan.dstRoot, r.from), path.join(plan.dstRoot, r.to));
      report.renamed++;
      log(`Yeniden adlandırıldı: ${r.from} → ${r.to}`, 'ok');
    } catch (e) {
      report.errors.push(`Rename ${r.from}: ${e.message}`);
    }
    step(r.to);
    await tick();
  }

  // 2) Üzerine yazılacaklar: önce mevcut dosya yedeğe taşınır
  for (const f of plan.overwrites) {
    const dst = path.join(plan.dstRoot, f.rel);
    try {
      const bak = path.join(backupRoot, f.rel);
      ensureDir(path.dirname(bak));
      fs.renameSync(dst, bak);
      await copyWithProgress(path.join(plan.srcRoot, f.rel), dst, onBytes);
      report.overwritten++;
      if (f.destNewer) log(`Dikkat: aynadaki daha yeniydi, yedeklendi: ${f.rel}`, 'warn');
    } catch (e) {
      report.errors.push(`Güncelleme ${f.rel}: ${e.message}`);
    }
    step(f.rel);
  }

  // 3) Yeni dosyalar
  for (const f of plan.copies) {
    try {
      await copyWithProgress(path.join(plan.srcRoot, f.rel),
                             path.join(plan.dstRoot, f.rel), onBytes);
      report.copied++;
    } catch (e) {
      report.errors.push(`Kopyalama ${f.rel}: ${e.message}`);
    }
    step(f.rel);
  }

  // 4) Aynada fazla kalanlar: silinmez, yedek klasörüne taşınır
  for (const f of plan.extras) {
    try {
      const bak = path.join(backupRoot, f.rel);
      ensureDir(path.dirname(bak));
      fs.renameSync(path.join(plan.dstRoot, f.rel), bak);
      report.archived++;
    } catch (e) {
      report.errors.push(`Arşivleme ${f.rel}: ${e.message}`);
    }
    step(f.rel);
    await tick();
  }

  pruneEmptyDirs(plan.dstRoot);
  return report;
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

function invalidateSync() {
  syncPlans = null;
  $('applySync').disabled = true;
  $('syncSummary').textContent = '';
}

function getSyncPaths() {
  const src = $('p0').value.trim();
  const mirrors = [$('p1').value.trim(), $('p2').value.trim()].filter(Boolean);
  return { src, mirrors };
}

function describePlan(plan) {
  const bits = [];
  if (plan.copies.length) bits.push(`<span class="ok">${plan.copies.length} yeni</span>`);
  if (plan.overwrites.length) bits.push(`<span class="warn">${plan.overwrites.length} güncellenecek (yedekli)</span>`);
  if (plan.renames.length) bits.push(`<span class="ok">${plan.renames.length} yeniden adlandırma</span>`);
  if (plan.extras.length) bits.push(`<span class="warn">${plan.extras.length} fazla dosya arşive</span>`);
  if (!bits.length) return `<span class="ok">Zaten eşit ✓</span> <span class="muted">(${plan.sameCount} dosya)</span>`;
  bits.push(`<span class="muted">${plan.sameCount} dosya aynı · ${fmtBytes(plan.bytes)} kopyalanacak</span>`);
  return bits.join(' · ');
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

  $('scanSync').disabled = true;
  showProgress('Taranıyor…');
  try {
    syncPlans = [];
    const lines = [];
    for (let i = 0; i < mirrors.length; i++) {
      setProgress(i / mirrors.length, path.basename(mirrors[i]) || mirrors[i]);
      const plan = await planMirror(src, mirrors[i]);
      syncPlans.push(plan);
      lines.push(`<div class="mirrorline"><b>${path.basename(mirrors[i]) || mirrors[i]}</b>: ${describePlan(plan)}</div>`);
      const dn = plan.overwrites.filter((o) => o.destNewer).length;
      if (dn) log(`Dikkat: ${mirrors[i]} içinde ${dn} dosya kaynaktakinden DAHA YENİ görünüyor; eşitlersen yedeklenip üzerine yazılır.`, 'warn');
    }
    $('syncSummary').innerHTML = lines.join('');
    const anyWork = syncPlans.some((p) =>
      p.copies.length || p.overwrites.length || p.renames.length || p.extras.length);
    $('applySync').disabled = !anyWork;
    log('Tarama bitti.' + (anyWork ? '' : ' Her şey zaten eşit.'), anyWork ? undefined : 'ok');
  } catch (e) {
    log('Tarama hatası: ' + e.message, 'err');
    invalidateSync();
  } finally {
    hideProgress();
    $('scanSync').disabled = false;
  }
}

async function doApplySync() {
  if (!syncPlans || !syncPlans.length) return;
  $('applySync').disabled = true;
  $('scanSync').disabled = true;

  try {
    const lines = [];
    for (const plan of syncPlans) {
      const name = path.basename(plan.dstRoot) || plan.dstRoot;
      showProgress('Eşitleniyor → ' + name);
      const report = await applyMirror(plan, (p) => {
        const frac = plan.bytes > 0 ? p.doneBytes / plan.bytes
                                    : (p.totalFiles ? p.doneFiles / p.totalFiles : 1);
        setProgress(frac,
          `${p.doneFiles}/${p.totalFiles} dosya` +
          (plan.bytes ? ` · ${fmtBytes(p.doneBytes)} / ${fmtBytes(plan.bytes)}` : '') +
          (p.label ? ` · ${p.label}` : ''));
      });
      const ok = report.errors.length === 0;
      const msg = `${name}: ${report.copied} kopyalandı, ${report.overwritten} güncellendi, ` +
                  `${report.renamed} yeniden adlandırıldı, ${report.archived} arşivlendi` +
                  (ok ? '' : `, ${report.errors.length} HATA`);
      log(msg, ok ? 'ok' : 'err');
      for (const e of report.errors) log(e, 'err');
      lines.push(`<div class="mirrorline"><b>${name}</b>: <span class="${ok ? 'ok' : 'err'}">${msg}</span></div>`);
      if (report.overwritten || report.archived) {
        log(`Yedekler: ${path.join(plan.dstRoot, BACKUP_DIR)}`);
      }
    }
    $('syncSummary').innerHTML = lines.join('');
  } finally {
    hideProgress();
    $('scanSync').disabled = false;
    syncPlans = null; // plan tüketildi; tekrar eşitlemek için yeni tarama gerek
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
