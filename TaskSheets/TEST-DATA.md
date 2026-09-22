# テストデータ

## なぜ実データが要るか

合成データや小規模データでは、**この構成の主張が何ひとつ検証できない**。

[ADR-0001](./ADR-0001-architecture.md) で COPC を採用し、[M1](./M1-point-rendering.md) で
octree LOD と点予算を実装した。その主張は「**ファイルがどれだけ大きくても、
開く時間とメモリ使用量は一定である**」というものである。

20万点の合成データで動いても、この主張は検証されない。**数億点で初めて意味を持つ。**
逆に言えば、数億点で破綻するなら構成そのものが間違っている。

## データ一覧

すべて公開データ。**リポジトリにはコミットしない**（`.gitignore` で `*.laz` / `*.copc.laz` /
`/data` を除外済み）。`data/` に置く。

| ファイル | 点数 | サイズ | 用途 |
|---|---|---|---|
| （テスト内で生成） | 2,000 〜 20万 | 0 | ユニットテスト・CI。`copc-writer` でその場生成 |
| `autzen-classified.copc.laz` | 10,653,336 | 78 MB | 日常の反復。分類コード付き |
| `sofi.copc.laz` | **364,384,576** | 2.03 GB | **受け入れ判定。数億点で破綻しないことの確認** |

### 取得方法

```bash
mkdir -p data && cd data
curl -L -O https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz
curl -L -O https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz
```

### 出典

- **Autzen Stadium** — Watershed Sciences, Inc. (2010) が取得、Hobu, Inc. の Max Sampson が
  2021 年に分類。PDAL / COPC の標準的なテストデータ
- **SoFi Stadium** — Hobu, Inc. が COPC 形式で公開

いずれも公開データだが、**成果物に同梱して再配布はしない**。各自でダウンロードする。

### 使えなかったもの

- `https://s3.amazonaws.com/data.entwine.io/millsite.copc.laz` — HTTP でエラー応答（XML）が
  返り取得できなかった。文献上は 1.9 GB とされているが、現在は利用できない

## 点数の確認方法

ダウンロードせずに点数とサイズを確認できる。LAS 1.4 のヘッダは先頭 375 バイトにあり、
オフセット 247 に点数が u64 リトルエンディアンで入っている。
**GB 単位を落としてから「思ったより小さかった」を避けられる。**

```bash
node -e "
fetch('<URL>', { headers: { Range: 'bytes=0-511' } })
  .then(r => r.arrayBuffer())
  .then(a => {
    const b = Buffer.from(a);
    console.log(b.toString('ascii',0,4), Number(b.readBigUInt64LE(247)).toLocaleString());
  });
"
```

## 規模ごとに何を見るか

| 規模 | 見るもの |
|---|---|
| 合成データ（〜20万点） | 正しさ。ノードの点数一致、境界の点の帰属、バイナリ形式の往復 |
| autzen（1,065万点） | 実データでの見た目。分類コード、座標精度、カメラ操作 |
| **sofi（3億6,438万点）** | **構成の妥当性。開く時間とメモリがファイルサイズに依存しないこと** |

**合成データで正しさを、autzen で見た目を、sofi で設計を検証する。**
どれか一つでも欠けると、検証できていない領域が残る。
