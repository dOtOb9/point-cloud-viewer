#!/bin/sh
# ThinkBook の C:\pcv-bench\out\ を、開発機の指定ディレクトリへ持ってくる。
# 使い方: sh scripts/igpu-bench/collect.sh <保存先ディレクトリ>
set -e
dest="${1:?保存先ディレクトリを指定してください}"
mkdir -p "$dest"
scp -r -i ~/.ssh/thinkbook_ed25519 masa1@192.168.10.104:C:/pcv-bench/out/. "$dest/"
echo "回収しました: $dest"
