param()
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$buildRoot=Join-Path $projectRoot '.omni\tmp\windows-trial\desktop-build'
$publishRoot=Join-Path $projectRoot 'publish\windows-launcher'
$exe=Join-Path $publishRoot '创意工坊.exe'
$ownerPath=Join-Path $buildRoot 'build-owner.json'
$resultPath=Join-Path $buildRoot 'build-result.json'
$stdout=Join-Path $buildRoot 'compiler.stdout.log'
$stderr=Join-Path $buildRoot 'compiler.stderr.log'
$result=[ordered]@{ok=$false;exe=$exe;compiler=$null;exit=$null;subsystem=$null;stdout=$stdout;stderr=$stderr;result=$resultPath;error=$null}
function Assert-PlainPath([string]$target){
  $cursor=[IO.Path]::GetFullPath($target)
  while($cursor){if(Test-Path -LiteralPath $cursor){$item=Get-Item -LiteralPath $cursor -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Directory link rejected: $cursor"}};$parent=[IO.Directory]::GetParent($cursor);if(!$parent){break};$cursor=$parent.FullName}
}
try{
  foreach($target in @($buildRoot,$publishRoot,$exe)){Assert-PlainPath $target}
  if((Test-Path -LiteralPath $buildRoot) -and !(Test-Path -LiteralPath $ownerPath) -and @(Get-ChildItem -LiteralPath $buildRoot -Force).Count){throw "Unknown build directory retained: $buildRoot"}
  if(Test-Path -LiteralPath $ownerPath){$owner=Get-Content -LiteralPath $ownerPath -Raw|ConvertFrom-Json;if($owner.project -ne $projectRoot -or $owner.exe -ne $exe){throw 'Existing desktop build belongs to another project; retained.'}}
  elseif(Test-Path -LiteralPath $exe){throw "Unknown executable retained: $exe"}
  $compiler=@((Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),(Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'))|Where-Object{Test-Path -LiteralPath $_}|Select-Object -First 1
  if(!$compiler){throw 'No existing .NET Framework C# compiler was found. No tool was installed.'}
  [IO.Directory]::CreateDirectory($buildRoot)|Out-Null
  [IO.Directory]::CreateDirectory($publishRoot)|Out-Null
  @{project=$projectRoot;exe=$exe}|ConvertTo-Json|Set-Content -LiteralPath $ownerPath -Encoding UTF8
  $result.compiler=$compiler
  $arguments='/nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:"'+$exe+'" /win32manifest:"'+(Join-Path $PSScriptRoot 'app.manifest')+'" "'+(Join-Path $PSScriptRoot 'CreativeWorkshop.cs')+'"'
  $process=Start-Process -FilePath $compiler -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $null=$process.Handle
  if(!$process.WaitForExit(45000)){$process.Kill();throw 'C# compiler exceeded 45 seconds.'}
  $result.exit=$process.ExitCode
  if($process.ExitCode -ne 0){throw "C# compiler failed; inspect $stdout and $stderr"}
  $bytes=[IO.File]::ReadAllBytes($exe);$pe=[BitConverter]::ToInt32($bytes,0x3c)
  if($bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a -or [BitConverter]::ToUInt32($bytes,$pe) -ne 0x00004550){throw 'Compiler output is not a PE executable.'}
  $result.subsystem=[BitConverter]::ToUInt16($bytes,$pe+24+68)
  if($result.subsystem -ne 2){throw 'Compiler output is not Windows GUI subsystem.'}
  $assembly=[Reflection.Assembly]::LoadFile($exe)
  $quote=$assembly.GetType('WorkshopLauncher').GetMethod('QuoteArgument')
  $example='C:\创意工坊 演示\src\launch.ps1'
  $quoted=$quote.Invoke($null,[object[]]@($example))
  if($quoted -ne ('"'+$example+'"')){throw 'Unicode and space argument quoting check failed.'}
  $result.pathQuoteCheck=$quoted
  $result.bytes=$bytes.Length
  $result.ok=$true
}catch{$result.error=$_.Exception.Message}
if(Test-Path -LiteralPath $buildRoot){$result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $resultPath -Encoding UTF8}
$result|ConvertTo-Json -Depth 5
if(!$result.ok){exit 1}
