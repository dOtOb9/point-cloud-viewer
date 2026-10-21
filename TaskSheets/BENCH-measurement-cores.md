# 計測の時間が日によって3〜4倍ぶれる原因（P コアと E コア）

- 日付: 2026-10-22（コーディネーター）
- きっかけ: G1-T11 で、渋谷のラスタの書き出しが G1-T6（2026-10-21）の 178 秒に対して 516〜755 秒かかった。
  旧版の example でも 737 秒かかったので、コードの変更ではなかった（[G1-T11](./G1-T11-raster-window.md) の「切り分け」）

## 分かったこと

この PC の CPU は Intel Core i5-14600K（論理プロセッサ 20 = P コア 6 基×2 スレッドの 0〜11 と、E コア 8 基の 12〜19）。
電源プランは「バランス」。ターミナルから裏で走らせた計測のプロセスは、Windows が **E コア（省電力のコア）** に回していた（推定。下の数値と合う）。

同じ example（`rasterize_copc export <入力> <出力>.tif 1 zMean`、`origin/main` の 2026-10-22 時点）を、
PowerShell の `Start-Process` で起動し、起動直後に `ProcessorAffinity` / `PriorityClass` を変えて比べた。他の重い処理は無し。

autzen（`autzen-classified.copc.laz`、1,065万点。example が出す `elapsed`）:

| 条件 | 1回目 | 2回目 |
|---|---|---|
| そのまま | 10.16 秒 | 9.49 秒 |
| P コアだけ（affinity `0xFFF`） | 4.84 秒 | 4.51 秒 |
| E コアだけ（affinity `0xFF000`） | 9.78 秒 | ― |
| 優先度「高」 | 7.31 秒 | ― |

「そのまま」は「E コアだけ」と同じ速さ。

渋谷（`tokyo-shibuya-merged-v2.copc.laz`、3.48億点、6462 ノード）:

| 条件 | 時間 | ピーク private |
|---|---|---|
| そのまま（2026-10-22 01 時台） | 754.93 秒 | 124 MiB |
| P コアだけ（affinity `0xFFF`） | 244.95 秒 | 123 MiB |

G1-T6 の 178 秒との差（245 秒との違い）の原因は**調べていない**。

## 計測の手順（これから）

時間を比べる計測は、**P コアに固定して**走らせる。そうしないと、同じ処理でも日によって3〜4倍ぶれる。

```powershell
$p = Start-Process -FilePath $exe -ArgumentList $args -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
$p.ProcessorAffinity = [IntPtr]0xFFF   # P cores only (logical 0-11 on this i5-14600K)
$p.WaitForExit()
```

- `0xFFF` はこの PC（i5-14600K）の値。別の PC では P コアの番号が違うので、そのまま使わない
- 起動からアフィニティを変えるまでの一瞬は E コアで動きうる（数秒以上の計測なら無視できる大きさ、と推定）
- これまでの `TaskSheets/` の時間の数値は、どのコアで走ったかが分からない。比べるときは同じ日に同じ条件で測り直す

## 確かめていないこと

- アプリ（Tauri の画面）を前面で使うとき、変換やラスタ化のスレッドが E コアに回されるか。Windows は前面のアプリを
  P コアに回しやすい、と言われている（未確認）。所有者が、アプリでの変換中にタスクマネージャーの「パフォーマンス」で
  P コア（0〜11）が使われているかを見れば分かる
- 電源プランを「高パフォーマンス」にしたとき、affinity なしでも速くなるか
- 優先度「高」がなぜ中間の速さ（7.31 秒）なのか
