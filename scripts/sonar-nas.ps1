[CmdletBinding()]
param([switch]$SkipVerification)

$ErrorActionPreference = 'Stop'
if (-not $env:SONAR_HOST_URL -or -not $env:SONAR_TOKEN) {
    throw 'Set SONAR_HOST_URL and SONAR_TOKEN in the environment. Never commit tokens.'
}
Push-Location (Join-Path $PSScriptRoot '..')
try {
    if (-not $SkipVerification) {
        npm run verify
        if ($LASTEXITCODE -ne 0) { throw 'Local verification failed; scan not started.' }
    }
    $metadata = Join-Path (Get-Location) '.scannerwork/nas-task.txt'
    npm exec --yes --package=@sonar/scan@5.1.0 -- sonar-scanner-npm --define `
        'sonar.projectKey=page-change-checker' 'sonar.organization=' `
        'sonar.projectName=page-change-checker' "sonar.scanner.metadataFilePath=$metadata" `
        'sonar.qualitygate.wait=true'
    if ($LASTEXITCODE -ne 0) { throw 'Sonar scan or server quality gate failed.' }
    $headers = @{ Authorization = "Bearer $env:SONAR_TOKEN" }
    $base = $env:SONAR_HOST_URL.TrimEnd('/')
    $gate = Invoke-RestMethod "$base/api/qualitygates/project_status?projectKey=page-change-checker" -Headers $headers
    if (-not $gate.projectStatus.conditions.Count) {
        throw 'Server returned a gate with no evaluated conditions. Ask the NAS administrator to assign an enforced gate; this is not a meaningful pass.'
    }
    if ($gate.projectStatus.status -ne 'OK') { throw 'Sonar quality gate did not pass.' }
}
finally { Pop-Location }
