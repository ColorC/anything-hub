param([switch]$UseBuiltDesktop)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$packageRoot=Join-Path $projectRoot '.omni\tmp\windows-trial\package'
$stage=Join-Path $packageRoot 'staging\anything-hub'
$downloads=Join-Path $packageRoot 'downloads'
$publishRoot=Join-Path $projectRoot 'publish\windows'
$zipPath=Join-Path $publishRoot 'AnythingHub-windows-x64.zip'
$ownerPath=Join-Path $packageRoot 'package-owner.json'
$resultPath=Join-Path $packageRoot 'package-result.json'
$clock=[Diagnostics.Stopwatch]::StartNew()
$nodeVersion='24.21.0'
$gitVersion='2.56.0.2'
$tools=@(
  @{name='node';version=$nodeVersion;url="https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip";prefix="node-v$nodeVersion-win-x64/"},
  @{name='git';version=$gitVersion;url="https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-$gitVersion-64-bit.zip";prefix=''}
)
$sourceFiles=@('start.cmd','package.json','package-lock.json','README.md','LICENSE','docs/THIRD_PARTY_NOTICES.md','docs/repository-format.md','src/server.mjs','src/repository.mjs','src/game-policy.mjs','src/launch.ps1','src/package-windows.ps1','src/catalog.json','src/web/index.html','src/web/styles.css','src/web/app.js','src/web/feedback.js','src/desktop/CreativeWorkshop.cs','src/desktop/app.manifest','src/desktop/build.ps1','publish/web/app.js','publish/core/server.mjs')
$versionPath=Join-Path $projectRoot 'publish/version.json'
if(Test-Path -LiteralPath $versionPath -PathType Leaf){$sourceFiles+='publish/version.json'}
$receipt=[ordered]@{ok=$false;zip=$zipPath;stage=$stage;tools=$tools;commands=@();logs=@();files=@();licenses=@();error=$null}
$previousToolFiles=@()
function Check-Deadline {if($clock.Elapsed.TotalSeconds -gt 480){throw 'Packaging exceeded its eight minute bound.'}}
function Assert-PlainPath([string]$target){
  $cursor=[IO.Path]::GetFullPath($target)
  while($cursor){
    if(Test-Path -LiteralPath $cursor){$item=Get-Item -LiteralPath $cursor -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Directory link rejected: $cursor"}}
    $parent=[IO.Directory]::GetParent($cursor);if(!$parent){break};$cursor=$parent.FullName
  }
}
function Plain-Files([string]$root){
  if(!(Test-Path -LiteralPath $root)){return}
  $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($root)
  while($pending.Count){Check-Deadline;foreach($item in Get-ChildItem -LiteralPath $pending.Pop() -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Link rejected: $($item.FullName)"};if($item.PSIsContainer){$pending.Push($item.FullName)}else{$item}}}
}
function Relative-Name([string]$root,[string]$file){$file.Substring($root.TrimEnd('\').Length+1).Replace('\','/')}
function Run-Bounded([string]$name,[string]$exe,[string]$arguments,[int]$timeoutMs){
  Check-Deadline
  $out=Join-Path $packageRoot "$name.stdout.log";$err=Join-Path $packageRoot "$name.stderr.log"
  $receipt.logs+=@{path=$out;role="$name standard output"},@{path=$err;role="$name standard error"}
  $process=Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null=$process.Handle
  if(!$process.WaitForExit($timeoutMs)){$process.Kill();throw "$name exceeded $timeoutMs ms; PID $($process.Id) stopped."}
  $receipt.commands+=@{name=$name;exit=$process.ExitCode;stdout=$out;stderr=$err}
  if($process.ExitCode -ne 0){throw "$name exited $($process.ExitCode). See $err"}
  ([string](Get-Content -LiteralPath $out -Raw)).Trim()
}
try{
  foreach($target in @($packageRoot,$stage,$downloads,$publishRoot)){Assert-PlainPath $target}
  if(Test-Path -LiteralPath $packageRoot){
    if(!(Test-Path -LiteralPath $ownerPath) -and @(Get-ChildItem -LiteralPath $packageRoot -Force).Count){throw "Unowned packaging directory retained: $packageRoot"}
  }
  if(Test-Path -LiteralPath $ownerPath){
    $owner=Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
    if($owner.project -ne $projectRoot -or $owner.node -ne $nodeVersion -or $owner.git -ne $gitVersion){throw 'Existing staging belongs to another project or tool version; retained.'}
    foreach($file in Plain-Files $stage){$name=Relative-Name $stage $file.FullName;if($name -notin $owner.files){throw "Unknown staging content retained: $($file.FullName)"}}
    $previousToolFiles=@($owner.files|Where-Object{$_ -match '^tools/(node|git)/'})
  }elseif(Test-Path -LiteralPath $zipPath){throw "Unowned existing ZIP retained: $zipPath"}
  foreach($name in $sourceFiles){$source=Join-Path $projectRoot $name;if(!(Test-Path -LiteralPath $source -PathType Leaf)){throw "Required input absent: $source"};Assert-PlainPath $source}
  if(Test-Path -LiteralPath $versionPath -PathType Leaf){$version=Get-Content -LiteralPath $versionPath -Raw|ConvertFrom-Json;$receipt.sourceCommit=$version.commit}
  foreach($directory in @($packageRoot,$stage,$downloads,$publishRoot)){[IO.Directory]::CreateDirectory($directory)|Out-Null}
  $owner=[ordered]@{project=$projectRoot;node=$nodeVersion;git=$gitVersion;files=$previousToolFiles;zip=$zipPath}
  $owner|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $ownerPath -Encoding UTF8
  if($UseBuiltDesktop){
    $buildReceipt=Get-Content -LiteralPath (Join-Path $projectRoot '.omni/tmp/windows-trial/desktop-build/build-result.json') -Raw|ConvertFrom-Json
    if(!$buildReceipt.ok -or $buildReceipt.exit -ne 0 -or $buildReceipt.subsystem -ne 2){throw 'Previously built GUI executable was not verified.'}
    $receipt.commands+=@{name='reuse-built-desktop';exit=0;result=$buildReceipt.result;validation='Package the exact GUI binary used in the Windows cold-start verification'}
  }else{
    Run-Bounded 'build-desktop' (Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe') ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $projectRoot 'src/desktop/build.ps1')+'"') 60000|Out-Null
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  foreach($tool in $tools){
    Check-Deadline
    if((Test-Path -LiteralPath (Join-Path $stage "tools/$($tool.name)")) -and @($previousToolFiles|Where-Object{$_ -like "tools/$($tool.name)/*"}).Count){
      $receipt.commands+=@{name="reuse-extracted-$($tool.name)";exit=$null;validation='Owned staging retained; executable versions checked below'}
      continue
    }
    $archive=Join-Path $downloads "$($tool.name)-$($tool.version).zip"
    if(!(Test-Path -LiteralPath $archive)){
      $partial="$archive.partial"
      if(Test-Path -LiteralPath $partial){
        $check=[IO.Compression.ZipFile]::OpenRead($partial)
        try{if(!$check.Entries.Count){throw "Empty cached archive retained: $partial"}}finally{$check.Dispose()}
        $receipt.commands+=@{name="reuse-$($tool.name)-download";exit=$null;validation='Existing complete ZIP opened; previous native exit unavailable';archive=$partial}
      }else{
        Run-Bounded "download-$($tool.name)" (Get-Command curl.exe).Source ('--fail --location --silent --show-error --connect-timeout 10 --max-time 180 --retry 0 --output "'+$partial+'" "'+$tool.url+'"') 190000|Out-Null
      }
      Move-Item -LiteralPath $partial -Destination $archive
    }
    $reader=[IO.Compression.ZipFile]::OpenRead($archive)
    try{
      foreach($entry in $reader.Entries){
        Check-Deadline
        if($entry.FullName.EndsWith('/')){continue}
        if($tool.prefix -and !$entry.FullName.StartsWith($tool.prefix)){throw "Unexpected Node archive root: $($entry.FullName)"}
        $relative=$entry.FullName.Substring($tool.prefix.Length).Replace('\','/')
        if($relative -match '(^/|(^|/)\.\.(/|$)|:)'){throw "Unsafe archive member: $relative"}
        $name="tools/$($tool.name)/$relative";$target=Join-Path $stage $name
        [IO.Directory]::CreateDirectory((Split-Path $target -Parent))|Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true)
        $owner.files+=$name
      }
    }finally{$reader.Dispose();$owner|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $ownerPath -Encoding UTF8}
  }
  foreach($name in $sourceFiles){$target=Join-Path $stage $name;[IO.Directory]::CreateDirectory((Split-Path $target -Parent))|Out-Null;Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $target -Force;$owner.files+=$name}
  Copy-Item -LiteralPath (Join-Path $projectRoot 'publish/windows-launcher/创意工坊.exe') -Destination (Join-Path $stage '创意工坊.exe') -Force
  $owner.files+='创意工坊.exe'
  $noticePath=Join-Path $stage 'tools/README.md'
  @("# Bundled tools","","Node.js $nodeVersion with npm: $($tools[0].url)","Git for Windows MinGit ${gitVersion}: $($tools[1].url)","","These are official portable distributions. Their original license files remain in tools/node and tools/git. Node source: https://github.com/nodejs/node/tree/v$nodeVersion . Git for Windows source: https://github.com/git-for-windows/git/tree/v2.56.0.windows.2 .","No global installation is performed.")|Set-Content -LiteralPath $noticePath -Encoding UTF8
  $owner.files+='tools/README.md';$owner|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $ownerPath -Encoding UTF8
  $node=Join-Path $stage 'tools/node/node.exe'
  $npmCli=Join-Path $stage 'tools/node/node_modules/npm/bin/npm-cli.js'
  $git=Join-Path $stage 'tools/git/cmd/git.exe';if(!(Test-Path -LiteralPath $git)){$git=Join-Path $stage 'tools/git/bin/git.exe'}
  $receipt.node=Run-Bounded 'verify-node' $node '--version' 15000
  $receipt.npm=Run-Bounded 'verify-npm' $node ('"'+$npmCli+'" --version') 15000
  $receipt.git=Run-Bounded 'verify-git' $git '--version' 15000
  $allFiles=@(Plain-Files $stage)
  foreach($file in $allFiles){$name=Relative-Name $stage $file.FullName;if($name -notin $owner.files){throw "Unexpected package file retained: $($file.FullName)"};if($name -match '(^|/)(runtime|reports|tests|\.omni|\.git)(/|$)'){throw "Excluded directory in package: $name"}}
  $receipt.licenses=@($allFiles|Where-Object{$_.Name -match '^(LICENSE|COPYING|NOTICE)'}|ForEach-Object{$_.FullName})
  if(!@($receipt.licenses|Where-Object{$_ -like '*tools\node\*'}).Count -or !@($receipt.licenses|Where-Object{$_ -like '*tools\git\*'}).Count){throw 'Bundled tool license files were not found.'}
  Check-Deadline
  $newZip=Join-Path $packageRoot 'AnythingHub-windows-x64.zip'
  if(Test-Path -LiteralPath $newZip){throw "Existing compression candidate retained: $newZip"}
  [IO.Compression.ZipFile]::CreateFromDirectory($stage,$newZip,[IO.Compression.CompressionLevel]::Optimal,$true)
  Move-Item -LiteralPath $newZip -Destination $zipPath -Force
  $receipt.files=@($allFiles|ForEach-Object{@{path=Relative-Name $stage $_.FullName;bytes=$_.Length}})
  $receipt.bytes=(Get-Item -LiteralPath $zipPath).Length
  $receipt.ok=$true
}catch{$receipt.error=$_.Exception.Message;$receipt.position=$_.InvocationInfo.PositionMessage}
if(Test-Path -LiteralPath $packageRoot){$receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $resultPath -Encoding UTF8}
[ordered]@{ok=$receipt.ok;zip=$zipPath;bytes=$receipt.bytes;node=$receipt.node;npm=$receipt.npm;git=$receipt.git;result=$resultPath;error=$receipt.error}|ConvertTo-Json
if(!$receipt.ok){exit 1}
