# PowerShell 7. Online collection only reads public data. All local writes go to CacheDir and Database.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CacheDir,
    [Parameter(Mandatory)][string]$Database,
    [string]$Python = 'python',
    [ValidateRange(1,365)][int]$Days = 7,
    [ValidateRange(1,1000)][int]$CourtPages = 100,
    [switch]$FetchCourtPdfs
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
$CacheDir = (Resolve-Path -LiteralPath $CacheDir).Path
function Save-Json($Object, $Name) {
    $dst = Join-Path $CacheDir $Name
    ConvertTo-Json -InputObject $Object -Depth 10 | Set-Content -Encoding utf8 -LiteralPath ($dst+'.part')
    Move-Item -Force -LiteralPath ($dst+'.part') -Destination $dst
}
$repo = 'illeatmyhat/uspto-trademarks-bronze'
$next = "https://huggingface.co/api/datasets/$repo/tree/main/daily?limit=1000"
$files = @()
while ($next) {
    $page = Invoke-WebRequest -Uri $next -TimeoutSec 60
    $files += @($page.Content | ConvertFrom-Json | Where-Object path -Match '^daily/apc[0-9]{6}\.zip$')
    $links = $page.Headers['Link'] -join ','
    $next = if ($links -match '<([^>]+)>;\s*rel="next"') { $Matches[1] }
}
if (!$files.Count) { throw 'The public mirror did not list any daily XML files.' }
$files = @($files | Sort-Object path)
$selected = @($files | Select-Object -Last $Days)
if (Test-Path -LiteralPath $Database) {
    $cutoff = & $Python -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select coalesce(max(name),char(32)) from imports').fetchone()[0])" $Database
    if ($LASTEXITCODE -ne 0) {throw 'Cannot read XML import checkpoint.'}
    if ($cutoff.Trim()) {
        $selected = @($files | Where-Object { (Split-Path $_.path -Leaf) -gt $cutoff -or $_.path -ge $selected[0].path })
    }
}
foreach ($f in $selected) {
    $dst = Join-Path $CacheDir (Split-Path $f.path -Leaf)
    if ((Test-Path -LiteralPath $dst) -and (Get-FileHash -LiteralPath $dst).Hash -eq $f.lfs.oid) {continue}
    $url = "https://huggingface.co/datasets/$repo/resolve/main/"+$f.path
    Invoke-WebRequest $url -OutFile ($dst+'.part') -TimeoutSec 180 -MaximumRetryCount 2
    if ((Get-FileHash -LiteralPath ($dst+'.part')).Hash -ne $f.lfs.oid) {throw "Checksum mismatch: $dst"}
    Move-Item -Force -LiteralPath ($dst+'.part') -Destination $dst
}
Save-Json $files 'bronze_index.json'
$apiKey = if ($env:GOVINFO_API_KEY) {$env:GOVINFO_API_KEY} else {'DEMO_KEY'}
$cursor = '*'
$results = @()
for ($i=0; $i -lt $CourtPages; $i++) {
    $query = @{
        query='collection:USCOURTS "temporary restraining order" "Schedule A" (counterfeit OR trademark OR copyright OR patent)'
        resultLevel='default';offsetMark=$cursor;pageSize=100;sorts=@(@{field='publishdate';sortOrder='DESC'})
    } | ConvertTo-Json -Depth 4
    $response = Invoke-RestMethod -Uri 'https://api.govinfo.gov/search' -Method Post -Headers @{'X-Api-Key'=$apiKey} -ContentType 'application/json' -Body $query -TimeoutSec 90
    $results += @($response.results | Where-Object granuleId)
    if (!$response.offsetMark -or $response.offsetMark -eq $cursor -or $response.results.Count -lt 100) {break}
    $cursor = $response.offsetMark
}
Save-Json @{count=$response.count;results=$results;retrieved=[datetime]::UtcNow.ToString('o')} 'gsearch.json'
if ($FetchCourtPdfs) {
    $dir = Join-Path $CacheDir 'govdocs'
    New-Item -ItemType Directory -Force $dir | Out-Null
    foreach ($r in $results) {
        if ($r.granuleId -notmatch '^USCOURTS-[A-Za-z0-9_-]+$') {continue}
        $dst=Join-Path $dir ($r.granuleId+'.pdf')
        $stamp=$dst+'.modified'
        if ((Test-Path $dst) -and (Test-Path $stamp) -and (Get-Content $stamp -Raw).Trim() -eq $r.lastModified) {continue}
        $url='https://www.govinfo.gov/content/pkg/'+$r.packageId+'/pdf/'+$r.granuleId+'.pdf'
        Invoke-WebRequest $url -OutFile ($dst+'.part') -TimeoutSec 60 -MaximumRetryCount 2
        Move-Item -LiteralPath ($dst+'.part') -Destination $dst -Force
        Set-Content -LiteralPath $stamp -Value $r.lastModified
    }
}
& $Python (Join-Path $PSScriptRoot 'public_title_import.py') --cache $CacheDir --db $Database --days $Days
if ($LASTEXITCODE -ne 0) {throw 'Import failed. Rerun with the same cache and database.'}
Write-Output ("Mirror latest: {0}; fetched GovInfo records: {1}; review new rulings before updating case counts." -f $files[-1].path,$results.Count)
