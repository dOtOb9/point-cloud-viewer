# LAS ファイルのヘッダー(と GeoKey)だけを読んで、点数・point format・EPSG・範囲を表にする。
# 点データは読まない。使い方:
#   pwsh scripts/las-header-report.ps1 -Dir data\tokyo-shibuya,data\tokyo-23ku-1b -ListFile TaskSheets/BENCH-1b-tiles.txt
# 出力: 図郭ごとの CSV 風の行と、合計・point format の種類・EPSG の種類。
param(
  [Parameter(Mandatory)][string[]]$Dir,
  [string]$ListFile = ''
)
$files = Get-ChildItem -Path $Dir -Filter *.las
if ($ListFile) {
  $want = @{}; Get-Content $ListFile | % { $want[$_.Trim()] = 1 }
  $files = $files | ? { $want.ContainsKey($_.BaseName) }
}
$rows = foreach ($f in $files | Sort-Object Name) {
  $fs = [IO.File]::OpenRead($f.FullName)
  try {
    $b = New-Object byte[] 375
    [void]$fs.Read($b, 0, 375)
    $verMinor = $b[25]
    $offToPoints = [BitConverter]::ToUInt32($b, 96)
    $nVlr = [BitConverter]::ToUInt32($b, 100)
    $fmt = $b[104] -band 0x3F
    $recLen = [BitConverter]::ToUInt16($b, 105)
    $n = [BitConverter]::ToUInt32($b, 107)
    if ($verMinor -ge 4) { $n = [BitConverter]::ToUInt64($b, 247) }
    # 仕様の位置: scale 131..155, offset 155..179, max/min x,y,z 179..227
    $sx = [BitConverter]::ToDouble($b, 131); $sy = [BitConverter]::ToDouble($b, 139); $sz = [BitConverter]::ToDouble($b, 147)
    $maxx = [BitConverter]::ToDouble($b, 179); $minx = [BitConverter]::ToDouble($b, 187)
    $maxy = [BitConverter]::ToDouble($b, 195); $miny = [BitConverter]::ToDouble($b, 203)
    $maxz = [BitConverter]::ToDouble($b, 211); $minz = [BitConverter]::ToDouble($b, 219)
    # VLR を走査して GeoKeyDirectory(LASF_Projection, record 34735)から EPSG を取る
    $hdrSize = [BitConverter]::ToUInt16($b, 94)
    $fs.Position = $hdrSize
    $epsg = ''
    for ($i = 0; $i -lt $nVlr; $i++) {
      $v = New-Object byte[] 54; [void]$fs.Read($v, 0, 54)
      $user = [Text.Encoding]::ASCII.GetString($v, 2, 16).Trim([char]0)
      $rid = [BitConverter]::ToUInt16($v, 18); $len = [BitConverter]::ToUInt16($v, 20)
      $data = New-Object byte[] $len; [void]$fs.Read($data, 0, $len)
      if ($user -eq 'LASF_Projection' -and $rid -eq 34735) {
        $nk = [BitConverter]::ToUInt16($data, 6)
        for ($k = 0; $k -lt $nk; $k++) {
          $o = 8 + 8 * $k
          $key = [BitConverter]::ToUInt16($data, $o)
          if ($key -eq 3072) { $epsg = [BitConverter]::ToUInt16($data, $o + 6) }
        }
      }
    }
    [pscustomobject]@{ Tile = $f.BaseName; Ver = "1.$verMinor"; Fmt = $fmt; RecLen = $recLen; NVlr = $nVlr; Points = [uint64]$n
      Scale = "$sx,$sy,$sz"; EPSG = $epsg; MinX = $minx; MaxX = $maxx; MinY = $miny; MaxY = $maxy; MinZ = $minz; MaxZ = $maxz; Bytes = $f.Length }
  } finally { $fs.Dispose() }
}
$rows | Format-Table Tile, Ver, Fmt, RecLen, Points, Scale, EPSG, MinX, MaxX, MinY, MaxY, MinZ, MaxZ -AutoSize | Out-String -Width 250
"タイル数: $($rows.Count)"
"合計点数: $(($rows | Measure-Object Points -Sum).Sum)"
"合計バイト: $(($rows | Measure-Object Bytes -Sum).Sum)"
"point format / recLen / version の種類: " + (($rows | % { "fmt$($_.Fmt)/len$($_.RecLen)/v$($_.Ver)" } | Sort-Object -Unique) -join ', ')
"EPSG の種類: " + (($rows | % { $_.EPSG } | Sort-Object -Unique) -join ', ')
"CRS 情報(GeoKey 3072)が無い図郭: " + (($rows | ? { $_.EPSG -eq '' } | % { "$($_.Tile)(VLR=$($_.NVlr))" }) -join ' ')
"scale の種類: " + (($rows | % { $_.Scale } | Sort-Object -Unique) -join ' | ')
"X 範囲: $(($rows | Measure-Object MinX -Minimum).Minimum) .. $(($rows | Measure-Object MaxX -Maximum).Maximum)"
"Y 範囲: $(($rows | Measure-Object MinY -Minimum).Minimum) .. $(($rows | Measure-Object MaxY -Maximum).Maximum)"
"Z 範囲: $(($rows | Measure-Object MinZ -Minimum).Minimum) .. $(($rows | Measure-Object MaxZ -Maximum).Maximum)"
