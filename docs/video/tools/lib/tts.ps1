param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$VoiceId = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

function Await($asyncOp, $resultType) {
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($asyncOp))
    $task.Wait()
    return $task.Result
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer

if ($VoiceId -ne "") {
    $found = $synth.AllVoices | Where-Object { $_.Id -eq $VoiceId }
    if ($found) { $synth.Voice = $found }
}

Write-Host "voice: $($synth.Voice.DisplayName) ($($synth.Voice.Id))"

$streamOp = $synth.SynthesizeTextToStreamAsync($Text)
$stream = Await $streamOp ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])

$inputStream = $stream.GetInputStreamAt(0)
$reader = New-Object Windows.Storage.Streams.DataReader($inputStream)
$size = [uint32]$stream.Size
$loadOp = $reader.LoadAsync($size)
Await $loadOp ([uint32]) | Out-Null

$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)

[System.IO.File]::WriteAllBytes($OutPath, $bytes)
Write-Host "wrote $OutPath ($($bytes.Length) bytes)"
