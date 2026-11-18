# Produces a NEW sibling folder. Never modifies or replaces the production extension.
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($PSScriptRoot)
$parent = [IO.Directory]::GetParent($source).FullName
$destination = [IO.Path]::GetFullPath((Join-Path $parent 'sellerflex-inventory-local-test'))
if ([IO.Directory]::GetParent($destination).FullName -ne $parent) { throw 'Destination escaped extension parent' }
if (Test-Path -LiteralPath $destination) { throw 'Local test directory already exists. Use the existing test copy or choose a fresh workspace.' }
New-Item -ItemType Directory -Path $destination | Out-Null
Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Extension -in '.js', '.json', '.html', '.css', '.md', '.txt' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination $_.Name) }
$manifestPath = Join-Path $destination 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.name = 'Seller Flex 库存助手 [本地模拟测试]'
$manifest.host_permissions += 'http://127.0.0.1/*'
# Local tests must not inject or retain the manual uploader in real Amazon pages.
$manifest.PSObject.Properties.Remove('content_scripts')
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
$backgroundPath = Join-Path $destination 'background.js'
$background = [IO.File]::ReadAllText($backgroundPath)
if (-not $background.Contains('const LOCAL_TEST = false;')) { throw 'Unexpected worker source' }
[IO.File]::WriteAllText($backgroundPath, $background.Replace('const LOCAL_TEST = false;', 'const LOCAL_TEST = true;'), [Text.UTF8Encoding]::new($false))
Write-Output "Created isolated local test extension: $destination"
