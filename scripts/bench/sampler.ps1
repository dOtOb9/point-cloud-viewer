param([int]$RootPid, [string]$Csv)
$inv = [Globalization.CultureInfo]::InvariantCulture
(Get-Process -Id $PID).ProcessorAffinity = [IntPtr]0xFF000
"t,private_mib,procs,free_gb" | Out-File $Csv -Encoding ascii
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
  if (-not (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) { break }
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId
  $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($RootPid)
  do { $n = $ids.Count; foreach ($q in $all) { if ($ids.Contains([int]$q.ParentProcessId)) { [void]$ids.Add([int]$q.ProcessId) } } } while ($ids.Count -ne $n)
  $sum = 0; $c = 0
  foreach ($i in $ids) { try { $sum += (Get-Process -Id $i -ErrorAction Stop).PrivateMemorySize64; $c++ } catch {} }
  $free = (Get-PSDrive C).Free / 1GB
  $line = [string]::Format($inv, "{0:F1},{1:F0},{2},{3:F1}", $sw.Elapsed.TotalSeconds, ($sum / 1MB), $c, $free)
  $line | Out-File $Csv -Append -Encoding ascii
  Start-Sleep -Milliseconds 500
}
