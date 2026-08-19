'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function loadEngine(options) {
  options = options || {};
  const mainPath = path.join(__dirname, '..', 'js', 'main.js');
  const source = fs.readFileSync(mainPath, 'utf8') +
    '\n;globalThis.__kementTest = {' +
    'fullFingerprint, planMirror, applyMirror, applyAllMirrors, verifyAllMirrors, ' +
    'buildMirrorOnlyTree, prepareMirrorOnlyImports, importMirrorOnlyFiles, ' +
    'importAndRefreshPlans, BACKUP_DIR, ' +
    'fingerprint, fingerprintAsync, armStop, disarmStop, requestStop, togglePause, ' +
    'expandRenames, prepareSourceRenames, applySourceRenames, buildRelinkPlan' +
    '};';
  const element = () => ({
    prepend: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    style: {},
    textContent: '',
    innerHTML: '',
  });
  const document = {
    body: { innerHTML: '' },
    getElementById: element,
    createElement: element,
  };
  const context = {
    require,
    Buffer,
    console,
    document,
    window: {},
    setTimeout,
    clearTimeout,
    Date: options.Date || Date,
  };
  vm.runInNewContext(source, context, { filename: mainPath });
  return context.__kementTest;
}

function write(root, rel, contents) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function setMtime(file, secondsAgo) {
  const date = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, date, date);
}

async function run() {
  const engine = loadEngine();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kement-sync-test-'));
  const progress = () => {};
  const deepPlan = (src, dst) => engine.planMirror(src, dst, { deep: true });

  try {
    {
      const a = path.join(tempRoot, 'leave-a');
      const b = path.join(tempRoot, 'leave-b');
      write(a, 'project/master.txt', 'master');
      write(b, 'project/master.txt', 'master');
      write(b, 'other/clip.mov', 'only-on-b');
      fs.mkdirSync(path.join(b, 'unrelated-empty'), { recursive: true });

      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.mirrorOnly.length, 1);
      assert.strictEqual(plan.copies.length, 0);
      const report = await engine.applyMirror(plan, progress);

      assert.strictEqual(report.errors.length, 0);
      assert.ok(fs.existsSync(path.join(b, 'other/clip.mov')));
      assert.ok(fs.existsSync(path.join(b, 'unrelated-empty')));
      assert.ok(!fs.existsSync(path.join(b, engine.BACKUP_DIR)));
    }

    {
      const tree = engine.buildMirrorOnlyTree([
        { rel: 'Footage/Drone/day-1.mov', size: 10 },
        { rel: 'Footage/interview.mov', size: 20 },
        { rel: 'root.wav', size: 5 },
      ], 0);
      assert.strictEqual(tree.count, 3);
      assert.strictEqual(tree.size, 35);
      assert.strictEqual(tree.files.length, 1);
      assert.strictEqual(tree.folderList[0].name, 'Footage');
      assert.strictEqual(tree.folderList[0].count, 2);
      assert.strictEqual(tree.folderList[0].folderList[0].name, 'Drone');
      assert.ok(tree.keys.includes('0:Footage/Drone/day-1.mov'));
    }

    {
      const a = path.join(tempRoot, 'forward-a');
      const b = path.join(tempRoot, 'forward-b');
      write(a, 'project/new.txt', 'from-a');
      write(b, 'personal/keep.txt', 'from-b');

      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.copies.length, 1);
      assert.strictEqual(plan.mirrorOnly.length, 1);
      await engine.applyMirror(plan, progress);

      assert.strictEqual(fs.readFileSync(path.join(b, 'project/new.txt'), 'utf8'), 'from-a');
      assert.strictEqual(fs.readFileSync(path.join(b, 'personal/keep.txt'), 'utf8'), 'from-b');
      assert.ok(!fs.existsSync(path.join(b, engine.BACKUP_DIR)));
    }

    // Aynı içerik, farklı yol = ad değişikliği/taşıma. Varsayılan plan bunu
    // "renames" olarak ayırır; "Dokunma" kararı (expandRenames) eski davranışa
    // döner: A'daki adla kopyala, B'dekini yerinde bırak.
    {
      const a = path.join(tempRoot, 'same-content-path-a');
      const b = path.join(tempRoot, 'same-content-path-b');
      write(a, 'project/logo.png', 'same-image');
      write(b, 'personal/logo-copy.png', 'same-image');

      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.renames.length, 1);
      assert.strictEqual(plan.renames[0].rel, 'project/logo.png');
      assert.strictEqual(plan.renames[0].fromRel, 'personal/logo-copy.png');
      assert.strictEqual(plan.copies.length, 0);
      assert.strictEqual(plan.mirrorOnly.length, 0);
      assert.strictEqual(plan.bytes, 0);

      const expanded = engine.expandRenames(plan);
      assert.strictEqual(expanded.copies.length, 1);
      assert.strictEqual(expanded.mirrorOnly.length, 1);
      assert.strictEqual(expanded.renames.length, 0);
      assert.strictEqual(expanded.bytes, 'same-image'.length);
      const report = await engine.applyMirror(expanded, progress);
      assert.strictEqual(report.errors.length, 0);
      assert.ok(fs.existsSync(path.join(b, 'project/logo.png')));
      assert.ok(fs.existsSync(path.join(b, 'personal/logo-copy.png')));
      assert.ok(!fs.existsSync(path.join(b, engine.BACKUP_DIR)));
    }

    // Karar "B'de yeniden adlandır": kopya yok, B'deki dosya A'daki yola taşınır;
    // kamera klasöründe ACam_ öneki senaryosu. Sonraki tarama A → B tam der.
    {
      const a = path.join(tempRoot, 'rename-mirror-a');
      const b = path.join(tempRoot, 'rename-mirror-b');
      write(a, 'Footage/ACam/ACam_aa342.mov', 'clip-aa342');
      write(a, 'Footage/BCam/BCam_a134.mov', 'clip-a134');
      write(b, 'Footage/ACam/aa342.mov', 'clip-aa342');
      write(b, 'Footage/BCam/a134.mov', 'clip-a134');
      const bIno = fs.statSync(path.join(b, 'Footage/ACam/aa342.mov')).ino;

      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.renames.length, 2);
      assert.strictEqual(plan.copies.length, 0);
      assert.strictEqual(plan.mirrorOnly.length, 0);
      const report = await engine.applyMirror(plan, progress);
      assert.strictEqual(report.errors.length, 0);
      assert.strictEqual(report.renamed, 2);
      assert.strictEqual(report.copied, 0);
      assert.ok(!fs.existsSync(path.join(b, 'Footage/ACam/aa342.mov')));
      assert.strictEqual(fs.readFileSync(path.join(b, 'Footage/ACam/ACam_aa342.mov'), 'utf8'), 'clip-aa342');
      assert.strictEqual(fs.statSync(path.join(b, 'Footage/ACam/ACam_aa342.mov')).ino, bIno); // kopya değil, aynı dosya
      const after = await deepPlan(a, b);
      assert.strictEqual(after.renames.length + after.copies.length + after.mirrorOnly.length, 0);
      assert.strictEqual(after.sameCount, 2);
    }

    // Karar "A'da yeniden adlandır": B'nin adları A'ya uygulanır; iki ayna
    // çelişirse o dosyaya dokunulmaz.
    {
      const a = path.join(tempRoot, 'rename-source-a');
      const b1 = path.join(tempRoot, 'rename-source-b1');
      const b2 = path.join(tempRoot, 'rename-source-b2');
      write(a, 'Cam/aa342.mov', 'clip-1');
      write(a, 'Cam/x.mov', 'clip-x');
      write(b1, 'Cam/ACam_aa342.mov', 'clip-1');
      write(b1, 'Cam/x1.mov', 'clip-x');
      write(b2, 'Cam/ACam_aa342.mov', 'clip-1');
      write(b2, 'Cam/x2.mov', 'clip-x');
      const plans = [await deepPlan(a, b1), await deepPlan(a, b2)];
      assert.strictEqual(plans[0].renames.length, 2);
      const prepared = engine.prepareSourceRenames(plans);
      assert.strictEqual(prepared.files.length, 1);
      assert.strictEqual(prepared.errors.length, 1);
      assert.ok(prepared.errors[0].includes('farklı ad'));
      const report = await engine.applySourceRenames(prepared, progress);
      assert.strictEqual(report.errors.length, 0);
      assert.strictEqual(report.renamed, 1);
      assert.ok(fs.existsSync(path.join(a, 'Cam/ACam_aa342.mov')));
      assert.ok(!fs.existsSync(path.join(a, 'Cam/aa342.mov')));
      assert.ok(fs.existsSync(path.join(a, 'Cam/x.mov')));
      const after = await deepPlan(a, b1);
      assert.strictEqual(after.sameCount, 1);
      assert.strictEqual(after.renames.length, 1); // x.mov ↔ x1.mov hâlâ kararsız
    }

    // Belirsizlik: aynı içerikten iki kopya varsa hangi ad hangisine gitti
    // bilinemez → ad değişikliği sayılmaz, eski davranış korunur. Ayrıca
    // hedef ad B'de doluysa yeniden adlandırma yapılmaz.
    {
      const a = path.join(tempRoot, 'rename-ambiguous-a');
      const b = path.join(tempRoot, 'rename-ambiguous-b');
      write(a, 'dup1.mov', 'same-clip');
      write(a, 'dup2.mov', 'same-clip');
      write(b, 'old1.mov', 'same-clip');
      write(b, 'old2.mov', 'same-clip');
      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.renames.length, 0);
      assert.strictEqual(plan.copies.length, 2);
      assert.strictEqual(plan.mirrorOnly.length, 2);

      const c = path.join(tempRoot, 'rename-busy-a');
      const d = path.join(tempRoot, 'rename-busy-b');
      write(c, 'new.mov', 'clip');
      write(d, 'old.mov', 'clip');
      const busyPlan = await deepPlan(c, d);
      assert.strictEqual(busyPlan.renames.length, 1);
      write(d, 'new.mov', 'something-else'); // taramadan sonra hedef ad doldu
      const report = await engine.applyMirror(busyPlan, progress);
      assert.strictEqual(report.renamed, 0);
      assert.ok(report.errors.some((e) => e.includes('zaten var')));
      assert.strictEqual(fs.readFileSync(path.join(d, 'new.mov'), 'utf8'), 'something-else');
      assert.strictEqual(fs.readFileSync(path.join(d, 'old.mov'), 'utf8'), 'clip');
    }

    {
      const a = path.join(tempRoot, 'import-a');
      const b = path.join(tempRoot, 'import-b');
      fs.mkdirSync(a, { recursive: true });
      write(b, 'extras/take-me.txt', 'bring-to-a');

      const plan = await deepPlan(a, b);
      const selected = new Set(['0:extras/take-me.txt']);
      const prepared = engine.prepareMirrorOnlyImports([plan], selected);
      assert.strictEqual(prepared.errors.length, 0);
      const report = await engine.importMirrorOnlyFiles(prepared, progress);

      assert.strictEqual(report.errors.length, 0);
      assert.strictEqual(fs.readFileSync(path.join(a, 'extras/take-me.txt'), 'utf8'), 'bring-to-a');
      assert.strictEqual(fs.readFileSync(path.join(b, 'extras/take-me.txt'), 'utf8'), 'bring-to-a');
      const verified = await deepPlan(a, b);
      assert.strictEqual(verified.copies.length, 0);
      assert.strictEqual(verified.overwrites.length, 0);
      assert.strictEqual(verified.mirrorOnly.length, 0);
    }

    {
      const a = path.join(tempRoot, 'overwrite-a');
      const b = path.join(tempRoot, 'overwrite-b');
      const source = write(a, 'same.txt', 'new-source-version');
      const mirror = write(b, 'same.txt', 'old-mirror-version');
      setMtime(mirror, 20);
      setMtime(source, 10);

      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.overwrites.length, 1);
      const report = await engine.applyMirror(plan, progress);

      assert.strictEqual(report.errors.length, 0);
      assert.strictEqual(fs.readFileSync(path.join(b, 'same.txt'), 'utf8'), 'new-source-version');
      const backupDates = fs.readdirSync(path.join(b, engine.BACKUP_DIR));
      assert.strictEqual(backupDates.length, 1);
      assert.strictEqual(
        fs.readFileSync(path.join(b, engine.BACKUP_DIR, backupDates[0], 'same.txt'), 'utf8'),
        'old-mirror-version'
      );
    }

    {
      const a = path.join(tempRoot, 'same-metadata-a');
      const b = path.join(tempRoot, 'same-metadata-b');
      const source = write(a, 'equal-size.txt', 'AAAA');
      const mirror = write(b, 'equal-size.txt', 'BBBB');
      const sameDate = new Date(Date.now() - 5000);
      fs.utimesSync(source, sameDate, sameDate);
      fs.utimesSync(mirror, sameDate, sameDate);

      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.sameCount, 0);
      assert.strictEqual(plan.overwrites.length, 1);
      await engine.applyMirror(plan, progress);
      assert.strictEqual(fs.readFileSync(path.join(b, 'equal-size.txt'), 'utf8'), 'AAAA');
    }

    {
      const a = path.join(tempRoot, 'conflict-a');
      const b1 = path.join(tempRoot, 'conflict-b1');
      const b2 = path.join(tempRoot, 'conflict-b2');
      fs.mkdirSync(a, { recursive: true });
      write(b1, 'shared/name.txt', 'first-version');
      write(b2, 'shared/name.txt', 'second-version');
      const plans = [await deepPlan(a, b1), await deepPlan(a, b2)];
      const selected = new Set(['0:shared/name.txt']);
      const prepared = engine.prepareMirrorOnlyImports(plans, selected);

      assert.strictEqual(prepared.files.length, 0);
      assert.ok(prepared.errors.some((error) => error.includes('farklı bir sürüm')));
      assert.ok(!fs.existsSync(path.join(a, 'shared/name.txt')));
    }

    {
      const a = path.join(tempRoot, 'duplicate-a');
      const b1 = path.join(tempRoot, 'duplicate-b1');
      const b2 = path.join(tempRoot, 'duplicate-b2');
      fs.mkdirSync(a, { recursive: true });
      write(b1, 'shared/same.txt', 'same-version');
      write(b2, 'shared/same.txt', 'same-version');
      const plans = [await deepPlan(a, b1), await deepPlan(a, b2)];
      const selected = new Set(['0:shared/same.txt', '1:shared/same.txt']);
      const prepared = engine.prepareMirrorOnlyImports(plans, selected);

      assert.strictEqual(prepared.errors.length, 0);
      assert.strictEqual(prepared.files.length, 1);
      assert.strictEqual(prepared.duplicateCount, 1);
      const report = await engine.importMirrorOnlyFiles(prepared, progress);
      assert.strictEqual(report.errors.length, 0);
      assert.strictEqual(fs.readFileSync(path.join(a, 'shared/same.txt'), 'utf8'), 'same-version');
    }

    {
      const a = path.join(tempRoot, 'stale-a');
      const b = path.join(tempRoot, 'stale-b');
      fs.mkdirSync(a, { recursive: true });
      write(b, 'late.txt', 'from-b');
      const plan = await deepPlan(a, b);
      write(a, 'late.txt', 'appeared-after-scan');
      const prepared = engine.prepareMirrorOnlyImports([plan], new Set(['0:late.txt']));

      assert.strictEqual(prepared.files.length, 0);
      assert.ok(prepared.errors.some((error) => error.includes('üzerine yazılmadı')));
      assert.strictEqual(fs.readFileSync(path.join(a, 'late.txt'), 'utf8'), 'appeared-after-scan');
    }

    {
      const a = path.join(tempRoot, 'restore-a');
      const b = path.join(tempRoot, 'restore-b');
      const source = write(a, 'critical.mov', 'new-version');
      const mirror = write(b, 'critical.mov', 'old-safe-version');
      setMtime(mirror, 20);
      setMtime(source, 10);
      const plan = await deepPlan(a, b);
      fs.unlinkSync(source);
      const report = await engine.applyMirror(plan, progress);

      assert.ok(report.errors.length > 0);
      assert.strictEqual(fs.readFileSync(path.join(b, 'critical.mov'), 'utf8'), 'old-safe-version');
    }

    {
      const a = path.join(tempRoot, 'race-a');
      const b = path.join(tempRoot, 'race-b');
      write(a, 'appears.mov', 'from-a');
      fs.mkdirSync(b, { recursive: true });
      const plan = await deepPlan(a, b);
      write(b, 'appears.mov', 'created-after-scan');
      const report = await engine.applyMirror(plan, progress);

      assert.ok(report.errors.length > 0);
      assert.strictEqual(fs.readFileSync(path.join(b, 'appears.mov'), 'utf8'), 'created-after-scan');
    }

    {
      const a = path.join(tempRoot, 'full-hash-a');
      const b = path.join(tempRoot, 'full-hash-b');
      const size = 8 * 1024 * 1024;
      const source = write(a, 'middle.bin', '');
      const mirror = write(b, 'middle.bin', '');
      fs.truncateSync(source, size);
      fs.truncateSync(mirror, size);
      let fd = fs.openSync(source, 'r+');
      fs.writeSync(fd, Buffer.from([0x41]), 0, 1, 1024 * 1024);
      fs.closeSync(fd);
      fd = fs.openSync(mirror, 'r+');
      fs.writeSync(fd, Buffer.from([0x42]), 0, 1, 1024 * 1024);
      fs.closeSync(fd);
      const sameDate = new Date(Date.now() - 5000);
      fs.utimesSync(source, sameDate, sameDate);
      fs.utimesSync(mirror, sameDate, sameDate);

      const quick = await engine.planMirror(a, b);
      assert.strictEqual(quick.sameCount, 1);
      const exact = await deepPlan(a, b);
      assert.strictEqual(exact.sameCount, 0);
      assert.strictEqual(exact.overwrites.length, 1);
    }

    {
      const a = path.join(tempRoot, 'overwrite-race-a');
      const b = path.join(tempRoot, 'overwrite-race-b');
      write(a, 'same.mov', 'MASTER-NEW!!');
      const mirror = write(b, 'same.mov', 'mirror-old!!');
      const oldTime = new Date(Date.now() - 15000);
      fs.utimesSync(mirror, oldTime, oldTime);
      const plan = await deepPlan(a, b);
      const report = await engine.applyMirror(plan, progress, {
        beforeOverwriteCommit: async ({ dst }) => {
          fs.writeFileSync(dst, 'EXTERNAL-NEW');
          fs.utimesSync(dst, oldTime, oldTime);
        },
      });

      assert.ok(report.errors.length > 0);
      assert.strictEqual(fs.readFileSync(path.join(b, 'same.mov'), 'utf8'), 'EXTERNAL-NEW');
      assert.ok(!fs.existsSync(path.join(b, engine.BACKUP_DIR)));
      assert.ok(!fs.readdirSync(b).some((name) => name.includes('.kement-part-')));
    }

    {
      const fixedMs = Date.UTC(2026, 7, 18, 12, 0, 0, 123);
      class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [fixedMs])); }
        static now() { return fixedMs; }
      }
      const fixedEngine = loadEngine({ Date: FixedDate });
      const a = path.join(tempRoot, 'unique-backup-a');
      const b = path.join(tempRoot, 'unique-backup-b');
      write(a, 'x.txt', 'v2');
      write(b, 'x.txt', 'v1');
      let plan = await fixedEngine.planMirror(a, b, { deep: true });
      let report = await fixedEngine.applyMirror(plan, progress);
      assert.strictEqual(report.errors.length, 0);
      fs.writeFileSync(path.join(a, 'x.txt'), 'v3');
      plan = await fixedEngine.planMirror(a, b, { deep: true });
      report = await fixedEngine.applyMirror(plan, progress);
      assert.strictEqual(report.errors.length, 0);

      const backupRoots = fs.readdirSync(path.join(b, fixedEngine.BACKUP_DIR));
      assert.strictEqual(backupRoots.length, 2);
      const versions = backupRoots.map((root) =>
        fs.readFileSync(path.join(b, fixedEngine.BACKUP_DIR, root, 'x.txt'), 'utf8')
      ).sort();
      assert.deepStrictEqual(versions, ['v1', 'v2']);
      assert.strictEqual(fs.readFileSync(path.join(b, 'x.txt'), 'utf8'), 'v3');
    }

    {
      const a = path.join(tempRoot, 'import-phase-a');
      const b = path.join(tempRoot, 'import-phase-b');
      fs.mkdirSync(a, { recursive: true });
      write(b, 'take.txt', 'chosen-old');
      const plans = [await deepPlan(a, b)];
      const prepared = engine.prepareMirrorOnlyImports(plans, new Set(['0:take.txt']));
      const phase = await engine.importAndRefreshPlans(plans, prepared, progress, {
        afterImports: async () => {
          fs.writeFileSync(path.join(b, 'take.txt'), 'new-edit!!');
        },
        onRefreshProgress: () => {},
      });

      assert.strictEqual(phase.imported.errors.length, 0);
      assert.strictEqual(phase.plans[0].overwrites.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(a, 'take.txt'), 'utf8'), 'chosen-old');
      assert.strictEqual(fs.readFileSync(path.join(b, 'take.txt'), 'utf8'), 'new-edit!!');
      assert.ok(!fs.existsSync(path.join(b, engine.BACKUP_DIR)));
    }

    {
      const a = path.join(tempRoot, 'global-a');
      const b1 = path.join(tempRoot, 'global-b1');
      const b2 = path.join(tempRoot, 'global-b2');
      write(a, 'shared.txt', 'new1');
      write(b1, 'shared.txt', 'old0');
      write(b2, 'shared.txt', 'old0');
      const plans = [await deepPlan(a, b1), await deepPlan(a, b2)];
      const result = await engine.applyAllMirrors(plans, () => {}, {
        afterMirror: async ({ index }) => {
          if (index === 0) fs.writeFileSync(path.join(a, 'shared.txt'), 'new2');
        },
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(fs.readFileSync(path.join(b1, 'shared.txt'), 'utf8'), 'new1');
      assert.strictEqual(fs.readFileSync(path.join(b2, 'shared.txt'), 'utf8'), 'old0');
      assert.ok(result.reports[1].errors.length > 0);
      assert.ok(result.remaining.some((count) => count > 0));
    }

    {
      const a = path.join(tempRoot, 'late-extra-a');
      const b = path.join(tempRoot, 'late-extra-b');
      write(a, 'master.txt', 'new');
      write(b, 'master.txt', 'old');
      const plans = [await deepPlan(a, b)];
      const result = await engine.applyAllMirrors(plans, () => {}, {
        afterMirror: async () => {
          write(b, 'late-extra.txt', 'keep-and-ask');
        },
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.mirrorOnlyStable[0], false);
      assert.strictEqual(result.finalPlans[0].mirrorOnly.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(b, 'late-extra.txt'), 'utf8'), 'keep-and-ask');
    }

    {
      const a = path.join(tempRoot, 'symlink-scan-a');
      const b = path.join(tempRoot, 'symlink-scan-b');
      const outside = path.join(tempRoot, 'symlink-scan-outside');
      write(a, 'linked-folder/master.txt', 'master');
      fs.mkdirSync(b, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(b, 'linked-folder'), 'dir');

      await assert.rejects(() => deepPlan(a, b), /Sembolik bağlantı/);
      assert.ok(!fs.existsSync(path.join(outside, 'master.txt')));
    }

    {
      const a = path.join(tempRoot, 'symlink-race-a');
      const b = path.join(tempRoot, 'symlink-race-b');
      const outside = path.join(tempRoot, 'symlink-race-outside');
      write(a, 'linked-folder/master.txt', 'master');
      fs.mkdirSync(b, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      const plan = await deepPlan(a, b);
      fs.symlinkSync(outside, path.join(b, 'linked-folder'), 'dir');
      const report = await engine.applyMirror(plan, progress);

      assert.ok(report.errors.some((error) => error.includes('Sembolik bağlantı')));
      assert.ok(!fs.existsSync(path.join(outside, 'master.txt')));
    }

    // 21) Hızlı parmak izi: eşzamanlı ve asenkron sürüm birebir aynı değeri
    // üretir (küçük dosya, tek bölge; büyük dosya, beş bölge).
    {
      const a = path.join(tempRoot, 'fp');
      const small = write(a, 'small.bin', Buffer.from('küçük içerik'));
      const big = write(a, 'big.bin', crypto.randomBytes(3 * 1024 * 1024));
      for (const file of [small, big]) {
        const size = fs.statSync(file).size;
        assert.strictEqual(await engine.fingerprintAsync(file, size),
                           engine.fingerprint(file, size));
      }
      const bigHash = engine.fingerprint(big, fs.statSync(big).size);
      const fd = fs.openSync(big, 'r+');
      fs.writeSync(fd, Buffer.from('X'), 0, 1, Math.floor(3 * 1024 * 1024 * 0.5));
      fs.closeSync(fd);
      assert.notStrictEqual(engine.fingerprint(big, fs.statSync(big).size), bigHash);
    }

    // 22) Durdur: silahlıyken tam içerik taraması StopError ile kesilir ve
    // hiçbir şey yazılmaz; silahsızken aynı istek etkisizdir.
    {
      const a = path.join(tempRoot, 'stop-a');
      const b = path.join(tempRoot, 'stop-b');
      write(a, 'one.bin', crypto.randomBytes(9 * 1024 * 1024));
      write(a, 'two.bin', crypto.randomBytes(9 * 1024 * 1024));
      fs.mkdirSync(b, { recursive: true });

      engine.armStop();
      const stoppedPlan = engine.planMirror(a, b, {
        deep: true,
        onProgress: () => engine.requestStop(),
      });
      await assert.rejects(stoppedPlan, (error) => error.stopped === true);
      engine.disarmStop();
      assert.strictEqual(fs.readdirSync(b).length, 0);

      engine.requestStop(); // silahsız: yok sayılır
      const plan = await deepPlan(a, b);
      assert.strictEqual(plan.copies.length, 2);

      const file = path.join(a, 'one.bin');
      engine.armStop();
      engine.requestStop();
      await assert.rejects(() => engine.fullFingerprint(file, fs.statSync(file).size),
                           (error) => error.stopped === true);
      engine.disarmStop();
      const hash = await engine.fullFingerprint(file, fs.statSync(file).size);
      assert.ok(/^\d+:[0-9a-f]{64}$/.test(hash));
    }

    // 23) Duraklat: silahlıyken tarama ilk kontrol noktasında bekler, Devam
    // ile kaldığı yerden bitirir; duraklatılmışken Durdur anında keser.
    {
      const a = path.join(tempRoot, 'pause-a');
      const b = path.join(tempRoot, 'pause-b');
      write(a, 'one.bin', crypto.randomBytes(9 * 1024 * 1024));
      fs.mkdirSync(b, { recursive: true });
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      engine.armStop();
      let progressCalls = 0;
      let settled = false;
      const planPromise = engine.planMirror(a, b, {
        deep: true,
        onProgress: () => { if (++progressCalls === 1) engine.togglePause(); },
      }).finally(() => { settled = true; });
      await sleep(150);
      assert.strictEqual(settled, false);
      const callsWhilePaused = progressCalls;
      await sleep(100);
      assert.strictEqual(progressCalls, callsWhilePaused); // duraklamada ilerleme yok
      engine.togglePause(); // Devam
      const plan = await planPromise;
      assert.strictEqual(plan.copies.length, 1);
      engine.disarmStop();

      engine.armStop();
      let stoppedSettled = false;
      const stoppedPromise = engine.planMirror(a, b, {
        deep: true,
        onProgress: () => engine.togglePause(),
      }).catch((error) => error).finally(() => { stoppedSettled = true; });
      await sleep(100);
      assert.strictEqual(stoppedSettled, false);
      engine.requestStop();
      const error = await stoppedPromise;
      assert.strictEqual(error.stopped, true);
      engine.disarmStop();
      assert.strictEqual(fs.readdirSync(b).length, 0);
    }

    // Aynaya bağla: proje öğeleri A'ya bağlı; B'de aynı yol + içerik → doğrudan,
    // farklı ad aynı içerik → renamed, B'de yok → missing, aynı yolda farklı
    // içerik → differs, A çevrimdışı + B'de yol var → unverified.
    {
      const a = path.join(tempRoot, 'relink-a');
      const b = path.join(tempRoot, 'relink-b');
      write(a, 'Footage/ACam/ACam_aa342.mov', crypto.randomBytes(2 * 1024 * 1024));
      write(b, 'Footage/ACam/ACam_aa342.mov', fs.readFileSync(path.join(a, 'Footage/ACam/ACam_aa342.mov')));
      write(a, 'Footage/BCam/BCam_a134.mov', 'clip-a134');
      write(b, 'Footage/BCam/a134.mov', 'clip-a134');
      write(a, 'Footage/only-a.mov', 'only-a');
      write(a, 'Audio/v1.wav', 'version-1');
      write(b, 'Audio/v1.wav', 'version-2');
      write(b, 'Audio/gone.wav', 'gone');
      const items = [
        { name: 'ACam_aa342', path: path.join(a, 'Footage/ACam/ACam_aa342.mov') },
        { name: 'ACam_aa342 (dup)', path: path.join(a, 'Footage/ACam/ACam_aa342.mov') },
        { name: 'BCam_a134', path: path.join(a, 'Footage/BCam/BCam_a134.mov') },
        { name: 'only-a', path: path.join(a, 'Footage/only-a.mov') },
        { name: 'v1', path: path.join(a, 'Audio/v1.wav') },
        { name: 'gone', path: path.join(a, 'Audio/gone.wav') },
        { name: 'elsewhere', path: path.join(tempRoot, 'elsewhere.mov') },
      ];
      const plan = await engine.buildRelinkPlan(items, a, b, () => {});
      assert.strictEqual(plan.total, 6);
      assert.strictEqual(plan.elsewhere, 1);
      assert.strictEqual(plan.direct.length, 1);
      assert.strictEqual(plan.direct[0].newPath, path.join(b, 'Footage/ACam/ACam_aa342.mov'));
      assert.strictEqual(plan.renamed.length, 1);
      assert.strictEqual(plan.renamed[0].newPath, path.join(b, 'Footage/BCam/a134.mov'));
      assert.strictEqual(plan.missing.length, 1);
      assert.strictEqual(plan.missing[0].rel, 'Footage/only-a.mov');
      assert.strictEqual(plan.differs.length, 1);
      assert.strictEqual(plan.differs[0].rel, 'Audio/v1.wav');
      assert.strictEqual(plan.unverified.length, 1);
      assert.strictEqual(plan.unverified[0].newPath, path.join(b, 'Audio/gone.wav'));
    }

    console.log('sync-engine: 28 senaryo geçti');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
