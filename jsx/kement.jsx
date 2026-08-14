// Kement — Premiere Pro ExtendScript tarafı.
// Panel (CEP/JS) buradaki ESL fonksiyonlarını evalScript ile çağırır;
// cevaplar her zaman JSON string döner.

var ESL = (function () {

  var BIN_TYPE = (typeof ProjectItemType !== "undefined") ? ProjectItemType.BIN : 2;

  function collectItems(item, out) {
    for (var i = 0; i < item.children.numItems; i++) {
      var child = item.children[i];
      if (child.type === BIN_TYPE) {
        collectItems(child, out);
      } else {
        out.push(child);
      }
    }
  }

  // ExtendScript'te (ES3) JSON yok; string'i elle kaçırıyoruz.
  function esc(s) {
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === "\\") out += "\\\\";
      else if (c === '"') out += '\\"';
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += c;
    }
    return '"' + out + '"';
  }

  return {

    ping: function () {
      return '{"ok":true}';
    },

    // Projedeki tüm medya öğelerini {name, path} olarak döner.
    getMediaPaths: function () {
      try {
        if (!app.project) return '{"ok":false,"err":"Açık proje yok"}';
        var items = [];
        collectItems(app.project.rootItem, items);
        var parts = [];
        for (var i = 0; i < items.length; i++) {
          var p = "";
          try { p = items[i].getMediaPath(); } catch (e) {}
          if (p) {
            parts.push('{"name":' + esc(items[i].name) + ',"path":' + esc(p) + '}');
          }
        }
        return '{"ok":true,"projectName":' + esc(app.project.name) +
               ',"items":[' + parts.join(",") + ']}';
      } catch (e) {
        return '{"ok":false,"err":' + esc(e.toString()) + '}';
      }
    },

    // oldPath'e bağlı TÜM proje öğelerini newPath'e bağlar.
    relink: function (oldPath, newPath) {
      try {
        if (!app.project) return '{"ok":false,"err":"Açık proje yok"}';
        var items = [];
        collectItems(app.project.rootItem, items);
        var n = 0, skipped = 0;
        for (var i = 0; i < items.length; i++) {
          var p = "";
          try { p = items[i].getMediaPath(); } catch (e) {}
          if (p === oldPath) {
            var can = true;
            try {
              if (items[i].canChangeMediaPath) can = items[i].canChangeMediaPath();
            } catch (e) {}
            if (can) {
              try {
                items[i].changeMediaPath(newPath, true);
                n++;
              } catch (e) {
                skipped++;
              }
            } else {
              skipped++;
            }
          }
        }
        return '{"ok":true,"count":' + n + ',"skipped":' + skipped + '}';
      } catch (e) {
        return '{"ok":false,"err":' + esc(e.toString()) + '}';
      }
    },

    // Açık projenin .prproj yolu (varsayılan hedef klasör önerisi için).
    getProjectPath: function () {
      try {
        var p = (app.project && app.project.path) ? app.project.path : "";
        return '{"ok":true,"path":' + esc(p) + '}';
      } catch (e) {
        return '{"ok":false,"err":' + esc(e.toString()) + '}';
      }
    }
  };
})();
