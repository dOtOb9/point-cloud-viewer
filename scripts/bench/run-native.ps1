# Runs one executable pinned to the P cores (0xFFF on the i5-14600K, TaskSheets/BENCH-measurement-cores.md),
# samples its private memory and the free space of C: every 0.2 s, and stops it if C: free space drops below -MinFreeGB.
# usage: run-native.ps1 -Exe <exe> -ArgLine <args> -Tag <name> -OutDir <dir> [-TempDir <dir>] [-MinFreeGB 25]
# Output: <OutDir>\<Tag>.stdout / .stderr / .csv (see sampler.ps1 about the format) / .result
param([string]$Exe, [string]$ArgLine, [string]$Tag, [string]$OutDir, [string]$TempDir = "", [int]$MinFreeGB = 25)
$inv = [Globalization.CultureInfo]::InvariantCulture
if ($TempDir -ne "") { $env:TEMP = $TempDir; $env:TMP = $TempDir }
$p = Start-Process -FilePath $Exe -ArgumentList $ArgLine -PassThru -NoNewWindow -RedirectStandardOutput "$OutDir\$Tag.stdout" -RedirectStandardError "$OutDir\$Tag.stderr"
$p.ProcessorAffinity = [IntPtr]0xFFF
$sw = [Diagnostics.Stopwatch]::StartNew()
$peakPriv = 0; $minFree = [double]::MaxValue
"t,private_mib,free_gb" | Out-File "$OutDir\$Tag.csv" -Encoding ascii
while (-not $p.HasExited) {
  try { $p.Refresh(); $priv = $p.PrivateMemorySize64 / 1MB } catch { $priv = 0 }
  $free = (Get-PSDrive C).Free / 1GB
  if ($priv -gt $peakPriv) { $peakPriv = $priv }
  if ($free -lt $minFree) { $minFree = $free }
  [string]::Format($inv, "{0:F1},{1:F0},{2:F1}", $sw.Elapsed.TotalSeconds, $priv, $free) | Out-File "$OutDir\$Tag.csv" -Append -Encoding ascii
  if ($free -lt $MinFreeGB) { Stop-Process -Id $p.Id -Force; "KILLED low disk" | Out-File "$OutDir\$Tag.stdout" -Append; break }
  Start-Sleep -Milliseconds 200
}
$p.WaitForExit()
[string]::Format($inv, "RESULT tag={0} wall_s={1:F1} peak_private_mib={2:F0} min_free_gb={3:F1}", $Tag, $sw.Elapsed.TotalSeconds, $peakPriv, $minFree) | Tee-Object -FilePath "$OutDir\$Tag.result"
