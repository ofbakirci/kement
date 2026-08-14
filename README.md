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
Kaynak → Ayna 1 (+ isteğe bağlı Ayna 2) tek yönlü incremental mirror.
Yol olarak diskin kendisi de (`/Volumes/DiskAdı`) bir klasör de seçilebilir.

Kurallar:
- **Sadece fark kopyalanır.** Boyut + değişiklik tarihi aynı olan dosyaya dokunulmaz.
- **Yedeksiz üzerine yazılmaz.** Güncellenen dosyanın eski hali aynadaki
  `_kement_yedek/<tarih-saat>/` klasörüne taşınır.
- **Silme yok.** Kaynakta artık olmayan dosyalar silinmez, aynı yedek klasörüne taşınır.
- **Rename algılama.** Kaynakta sadece adı/konumu değişen dosya (boyut + baş/son
  256KB sha1 parmak izi eşleşmesiyle) tespit edilir ve aynada gigabaytlarca
  kopya yapmak yerine sadece **yeniden adlandırılır**.
- Önce **Tara** → ne yapılacağını gösterir (kaç yeni, kaç güncelleme, kaç rename,
  kaç arşiv), sonra **Eşitle** → uygular. Süreç progress bar'da izlenir.
- Kopyalar önce `.kement-part` geçici dosyasına yazılır, bitince adlandırılır —
  yarım kopya asla gerçek dosya gibi görünmez. Değişiklik tarihleri korunur.
- Aynadaki bir dosya kaynaktakinden daha yeniyse tarama sırasında uyarır
  (yanlış yönde eşitlemeye karşı sigorta).

## Kurulum

```bash
./install.sh
```

Sonra Premiere Pro'yu yeniden başlat → **Window > Extensions > Kement**.

Script, paneli `~/Library/Application Support/Adobe/CEP/extensions/` altına
symlink'ler ve imzasız panel çalışabilsin diye Adobe CEP `PlayerDebugMode`
tercihini açar (CEP 9–12). Kod güncellenince Premiere'i yeniden başlatmak yeter.

## Yapı

- `CSXS/manifest.xml` — CEP manifest (Premiere 13.0+, Node.js açık)
- `index.html` + `css/style.css` — panel arayüzü
- `js/main.js` — eşitleme motoru, rename algılama, toplama akışı, UI
- `jsx/kement.jsx` — ExtendScript: proje medya yollarını okuma + relink
- `assets/kement.svg` — logo: [koboyo](https://koboyo.com/icons/cartoon-lasso)
  el çizimi "cartoon-lasso" ikonu (ticari kullanım dahil ücretsiz lisans)

## Notlar

- Eşitleme tek yönlü: Kaynak her zaman doğru kabul edilir. İki yönlü sync
  bilinçli olarak yok (video arşivinde iki yönlü sync veri kaybı davetiyesidir).
- `.DS_Store`, `.Spotlight-V100`, `.Trashes` gibi sistem çöpleri ve `._*`
  AppleDouble dosyaları es geçilir.
- `_kement_yedek` klasörü eşitleme kapsamı dışındadır; ara sıra elle boşalt.
