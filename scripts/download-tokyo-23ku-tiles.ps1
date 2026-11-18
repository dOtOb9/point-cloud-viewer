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
