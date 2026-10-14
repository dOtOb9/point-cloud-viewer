# 東京都 区部点群データの図郭(LAS)をダウンロードして展開する。
# 使い方(リポジトリのルートから):
#   pwsh scripts/download-tokyo-23ku-tiles.ps1 `
#     -ListFile TaskSheets/BENCH-1b-tiles.txt `
#     -OutDir C:\rust\point-cloud-viewer\data\tokyo-23ku-1b `
#     -ExistingDir C:\rust\point-cloud-viewer\data\tokyo-shibuya
# 動き: 一覧のうち、OutDir か ExistingDir に <図郭>.las が既にあるものは飛ばす。
#   残りを同時 $Parallel 本でダウンロード→展開→zip削除。失敗は再試行。
#   C ドライブの空きが $MinFreeGB を下回りそうなら、新しい取得を始めずに止まる。
# 出典: 東京都デジタルツイン実現プロジェクト「区部点群データ」(CC BY 4.0)
param(
  [Parameter(Mandatory)][string]$ListFile,
  [Parameter(Mandatory)][string]$OutDir,
  [string]$ExistingDir = '',
  [int]$Parallel = 3,
  [int]$MinFreeGB = 80
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$base = 'https://gic-tokyo.s3.ap-northeast-1.amazonaws.com/2024/dig/lp/'
$todo = Get-Content $ListFile | ? { $_ -match '^\w+$' } | ? {
  -not (Test-Path (Join-Path $OutDir "$_.las")) -and
  -not ($ExistingDir -and (Test-Path (Join-Path $ExistingDir "$_.las")))
}
"取得対象: $($todo.Count) 枚"
$failed = $todo | ForEach-Object -ThrottleLimit $Parallel -Parallel {
  $n = $_
  $free = (Get-PSDrive C).Free / 1GB
  # 1枚あたり zip 約0.12GB + 展開 約0.2GB。並列分の余裕として +2GB を見る
  if ($free -lt ($using:MinFreeGB + 2)) { "$n(空き不足で未着手)"; return }
  $zip = Join-Path $using:OutDir "$n.zip"
  $tmp = Join-Path $using:OutDir "_tmp_$n"
  $ok = $false
  foreach ($try in 1..4) {
    try {
      Invoke-WebRequest -Uri "$using:base$n.zip" -OutFile $zip -TimeoutSec 600
      New-Item -ItemType Directory -Force $tmp | Out-Null
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $las = Get-ChildItem $tmp -Recurse -Filter *.las
      if ($las.Count -ne 1) { throw "zip の中の .las が $($las.Count) 個" }
      Move-Item $las[0].FullName (Join-Path $using:OutDir "$n.las") -Force
      $ok = $true; break
    } catch {
      Start-Sleep -Seconds (5 * $try)
    } finally {
      if (Test-Path $zip) { Remove-Item $zip -Force }
      if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    }
  }
  if (-not $ok) { $n }
}
if ($failed) { "取れなかった図郭: $($failed -join ' ')" } else { '全て取得できた' }
"C ドライブの空き: {0:N1} GB" -f ((Get-PSDrive C).Free / 1GB)
