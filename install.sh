#!/bin/bash
# Kement panelini Premiere Pro'ya kurar (symlink ile — kod güncellenince
# yeniden kurulum gerekmez, Premiere'i yeniden başlatmak yeter).
set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_BASE="$HOME/Library/Application Support/Adobe/CEP/extensions"
EXT_DIR="$EXT_BASE/com.ofb.kement"

mkdir -p "$EXT_BASE"
rm -rf "$EXT_DIR"
rm -rf "$EXT_BASE/com.ofb.eslenti"   # eski kod adıyla kurulmuş sürüm varsa temizle
ln -sfn "$SRC_DIR" "$EXT_DIR"

# İmzasız panel çalışabilsin diye Adobe'nin debug modu (CEP 9–12)
for v in 9 10 11 12; do
  defaults write com.adobe.CSXS.$v PlayerDebugMode 1
done

echo "Kuruldu: $EXT_DIR"
echo "Premiere Pro'yu yeniden başlat → Window > Extensions > Kement"
