# kement

Premiere Pro paneli: başıboş footage'a kement atar, projeyi yeniden bağlar,
diskleri eşitler.

## Ne yapar

### Topla & Bağla
Projede kullanılan ama seçtiğin medya klasörünün **dışında** kalan dosyaları
(Downloads'ta unutulanlar vb.) bulur, klasöre kopyalar ve projeyi **otomatik
yeni yola bağlar** (relink). Zaten klasörde olanlara dokunmaz — Project
Manager'ın "her şeyi baştan taşı" derdi yok. Hedefte aynı isimde ama farklı
içerikte dosya varsa `(2)` ekleyerek çakışmayı önler; içerik aynıysa
kopyalamaz, sadece bağlar.

### Eşitle
Ana akış Kaynak → Ayna 1 (+ isteğe bağlı Ayna 2) incremental mirror'dır.
Yol olarak diskin kendisi de (`/Volumes/DiskAdı`) bir klasör de seçilebilir.

Kurallar:
- **Sadece fark kopyalanır.** Dosyalar tam SHA-256 içerik özetiyle karşılaştırılır.
- **Yedeksiz üzerine yazılmaz.** Güncellenen dosyanın eski hali aynadaki
  `_kement_yedek/<tarih-saat>/` klasörüne taşınır.
- **Aynaya özgü dosyaya dokunulmaz.** B'de olup A'da olmayan dosyalar klasör
  ağacında gösterilir. Seçtiklerin aynı yoluyla A'ya kopyalanır; seçmediklerin
  B'de yerinde kalır.
- Önce **Tara** → A → B planını ve yalnızca B'de bulunanları gösterir. Seçtiğin
  B dosyaları önce A'ya alınır. Kement sonra güncel A → B planını yeniden
  gösterir; ikinci onayla aynaları eşitler. Süreç progress bar'da izlenir ve
  A'daki her dosyanın aynaya geçtiği tam SHA-256 içerik özetiyle doğrulanır.
- Kopyalar önce benzersiz `.kement-part-*` geçici dosyasına yazılır ve tam
  içerikle doğrulanır. Hedef bu sırada oluşur veya değişirse üzerine yazılmaz.
  Değişiklik tarihleri korunur.
- Aynadaki bir dosya kaynaktakinden daha yeniyse tarama sırasında uyarır
  (yanlış yönde eşitlemeye karşı sigorta).
- **Ad değişikliği kopya değildir.** İçeriği birebir aynı olup yalnızca adı
  veya yolu farklı olan çiftleri (örn. `aa342.mov` → `ACam_aa342.mov`) ayrı
  listeler ve sorar: *B'de yeniden adlandır* (A'nın adları, kopya yok),
  *A'da yeniden adlandır* (B'nin adları) ya da *dokunma* (kopyala, eskisi B'de
  kalsın). Aynı içerikten birden fazla kopya varsa eşleşme belirsiz sayılır ve
  eski davranış korunur.
- Tarama ve doğrulama aşamaları **Duraklat / Durdur** ile kesilebilir; bu
  aşamalar yalnızca okur, yarıda kesmenin zararı yoktur. Yazma aşamalarında
  butonlar gizlenir.

### Aynaya Bağla
Projeyi A diskinden B diskine taşıdın, B'de açtın ama medya hâlâ A'ya bakıyor.
İki disk de takılıyken **Tara**: her proje öğesi için B'deki karşılık aranır.
Aynı yol + aynı içerik doğrudan bağlanır; adı/yolu değişmiş kopya içerikten
bulunur ve ayrı grupta gösterilir (isteğe bağlı bağlanır). B'de olmayan ya da
farklı içerikte olanlar listelenir — önce Eşitle, sonra yeniden tara.
Doğrulama hızlı parmak iziyle (boyut + beş bölge SHA-256) yapılır; proje
bağlantısı geri alınabilir olduğundan tam içerik okunmaz. Yön seçilebilir
(Kaynak → Ayna veya tersi).

## Kurulum

**Kolay yol:** [Releases](https://github.com/ofbakirci/kement/releases/latest)'ten
`Kement_x.y.z.zxp` indir, [aescripts ZXP Installer](https://aescripts.com/learn/zxp-installer/)
penceresine sürükle-bırak.

**Geliştirici yolu:**

```bash
./install.sh
```

Her iki yolda da sonra Premiere Pro'yu yeniden başlat → **Window > Extensions > Kement**.

Dağıtım paketi üretmek için: `./package.sh` → `dist/Kement_<sürüm>.zxp`
(ilk çalıştırmada ZXPSignCmd'yi indirir, self-signed sertifika üretir; `dist/` git dışıdır).

Script, paneli `~/Library/Application Support/Adobe/CEP/extensions/` altına
symlink'ler ve imzasız panel çalışabilsin diye Adobe CEP `PlayerDebugMode`
tercihini açar (CEP 9–12). Kod güncellenince Premiere'i yeniden başlatmak yeter.

## Yapı

- `CSXS/manifest.xml` — CEP manifest (Premiere 13.0+, Node.js açık)
- `index.html` + `css/style.css` — panel arayüzü
- `js/main.js` — eşitleme motoru, içerik doğrulama, toplama akışı, UI
- `jsx/kement.jsx` — ExtendScript: proje medya yollarını okuma + relink (tekil ve toplu)
- `tests/sync-engine.test.js` — dosya sistemi eşitleme güvenlik senaryoları
- `assets/kement.svg` — logo: [koboyo](https://koboyo.com/icons/cartoon-lasso)
  el çizimi "cartoon-lasso" ikonu (ticari kullanım dahil ücretsiz lisans)

## Notlar

- Kaynak, A → B yönünde master kabul edilir. Otomatik iki yönlü merge yoktur.
  Yalnızca açıkça seçtiğin B'ye özgü dosyalar A'ya geri kopyalanır.
- `.DS_Store`, `.Spotlight-V100`, `.Trashes` gibi sistem çöpleri ve `._*`
  AppleDouble dosyaları es geçilir.
- `_kement_yedek` yalnızca üzerine yazılan eski sürümleri tutar ve eşitleme
  kapsamı dışındadır; ara sıra elle boşalt.
