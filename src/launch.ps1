param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$runtimeRoot=if($env:HUB_HOME){if([IO.Path]::IsPathRooted($env:HUB_HOME)){[IO.Path]::GetFullPath($env:HUB_HOME)}else{[IO.Path]::GetFullPath((Join-Path $projectRoot $env:HUB_HOME))}}else{Join-Path $projectRoot 'runtime'}
$port=42100
if($env:HUB_PORT -and (![int]::TryParse($env:HUB_PORT,[ref]$port) -or $port -lt 1 -or $port -gt 65535)){throw 'HUB_PORT must be an integer between 1 and 65535.'}
$url="http://127.0.0.1:$port/"
$healthUrl=$url+'api/health'
$env:HUB_HOME=$runtimeRoot
$env:HUB_PORT=[string]$port
$env:HUB_PROJECT_ROOT=$projectRoot
$portableNode=Join-Path $projectRoot 'tools\node\node.exe'
$nodePath=if(Test-Path -LiteralPath $portableNode){$portableNode}else{(Get-Command node -ErrorAction SilentlyContinue).Source}
if(!$nodePath){throw 'Node.js was not found. Use the portable Windows package or install Node.js LTS.'}
$toolPaths=@((Split-Path -Parent $nodePath))
foreach($gitDirectory in @('tools\git\cmd','tools\git\bin')){
  $candidate=Join-Path $projectRoot $gitDirectory
  if(Test-Path -LiteralPath $candidate){$toolPaths+=$candidate}
}
$env:PATH=($toolPaths -join [IO.Path]::PathSeparator)+[IO.Path]::PathSeparator+$env:PATH
New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'logs') -Force | Out-Null
$ready=$false
function Read-HubHealth{try{Invoke-RestMethod $healthUrl -TimeoutSec 2}catch{$null}}
$health=Read-HubHealth
if($health.ok){
  if([string]$health.runtime -ne $runtimeRoot){throw "Port $port is occupied by another Hub runtime: $($health.runtime). Choose another HUB_PORT."}
  $ready=$true
}
if(!$ready){
  if(!(Test-Path -LiteralPath (Join-Path $projectRoot 'publish\web\app.js')) -or !(Test-Path -LiteralPath (Join-Path $projectRoot 'publish\core\server.mjs'))){throw 'The package is incomplete: prebuilt core and frontend are required.'}
  $proc=Start-Process -FilePath $nodePath -ArgumentList ('"'+(Join-Path $projectRoot 'publish\core\server.mjs')+'"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'logs\server.out.log') -RedirectStandardError (Join-Path $runtimeRoot 'logs\server.err.log')
  $proc.Id | Set-Content -LiteralPath (Join-Path $runtimeRoot 'server.pid')
  $deadline=(Get-Date).AddSeconds(20)
  do{
    $health=Read-HubHealth
    if($health.ok -and [string]$health.runtime -ne $runtimeRoot){throw "Port $port is occupied by another Hub runtime: $($health.runtime). Choose another HUB_PORT."}
    $ready=$health.ok -and ([string]$health.runtime -eq $runtimeRoot)
    if(!$ready){$proc.Refresh();if($proc.HasExited){throw "Startup exited; inspect $(Join-Path $runtimeRoot 'logs\server.err.log')."};Start-Sleep -Milliseconds 350}
  }while(!$ready -and (Get-Date) -lt $deadline)
  if(!$ready){throw "Startup timed out; inspect $(Join-Path $runtimeRoot 'logs\server.err.log')."}
}
if(!$NoBrowser){Start-Process $url}
[ordered]@{ok=$true;url=$url;runtime=$runtimeRoot;stdout=(Join-Path $runtimeRoot 'logs\server.out.log');stderr=(Join-Path $runtimeRoot 'logs\server.err.log');pidFile=(Join-Path $runtimeRoot 'server.pid')} | ConvertTo-Json
