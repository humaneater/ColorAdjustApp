param(
  [int]$Port = 8765,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$listener = $null
$selectedPort = $null
$managedComfyProcess = $null
$managedComfyPid = $null
$managedComfyStartedAt = $null
$lastManagedActivity = Get-Date
$jobs = @{}
$appDataDirectory = Join-Path $env:LOCALAPPDATA "ColorAdjustApp"
$temporaryDirectory = Join-Path $env:TEMP "ColorAdjustApp"
$outputDirectory = Join-Path $root "outputs"
$comfyConfigPath = Join-Path $appDataDirectory "comfy.json"
$workflowPath = Join-Path $root "comfy\PortraitApi.json"

for ($candidate = $Port; $candidate -lt ($Port + 10); $candidate += 1) {
  try {
    $candidateListener = [System.Net.Sockets.TcpListener]::new(
      [System.Net.IPAddress]::Loopback,
      $candidate
    )
    $candidateListener.Start()
    $listener = $candidateListener
    $selectedPort = $candidate
    break
  } catch {
    if ($candidateListener) {
      $candidateListener.Stop()
    }
  }
}

if (-not $listener) {
  throw "Could not start a local server on ports $Port-$($Port + 9)."
}

function Get-ContentType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".css" { return "text/css; charset=utf-8" }
    ".js" { return "text/javascript; charset=utf-8" }
    ".json" { return "application/json; charset=utf-8" }
    ".wasm" { return "application/wasm" }
    ".png" { return "image/png" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".webp" { return "image/webp" }
    ".svg" { return "image/svg+xml" }
    ".ico" { return "image/x-icon" }
    default { return "application/octet-stream" }
  }
}

function Write-HttpResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$ContentType,
    [byte[]]$Body,
    [bool]$HeadOnly = $false,
    [hashtable]$ExtraHeaders = @{}
  )

  if ($null -eq $Body) {
    $Body = [byte[]]::new(0)
  }

  $headers = [System.Collections.Generic.List[string]]::new()
  $headers.Add("HTTP/1.1 $StatusCode $StatusText")
  $headers.Add("Content-Type: $ContentType")
  $headers.Add("Content-Length: $($Body.Length)")
  $headers.Add("Cache-Control: no-cache")
  $headers.Add("Cross-Origin-Opener-Policy: same-origin")
  $headers.Add("Cross-Origin-Embedder-Policy: require-corp")
  $headers.Add("Cross-Origin-Resource-Policy: same-origin")
  $headers.Add("X-Content-Type-Options: nosniff")

  foreach ($name in $ExtraHeaders.Keys) {
    $headers.Add("${name}: $($ExtraHeaders[$name])")
  }

  $headers.Add("Connection: close")
  $headers.Add("")
  $headers.Add("")

  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(
    $headers -join "`r`n"
  )

  $Stream.Write($headerBytes, 0, $headerBytes.Length)

  if (-not $HeadOnly -and $Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }

  $Stream.Flush()
}

function Write-JsonResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    $Payload,
    [bool]$HeadOnly = $false
  )

  $json = $Payload | ConvertTo-Json -Depth 12 -Compress
  $body = [System.Text.Encoding]::UTF8.GetBytes($json)

  Write-HttpResponse `
    -Stream $Stream `
    -StatusCode $StatusCode `
    -StatusText $StatusText `
    -ContentType "application/json; charset=utf-8" `
    -Body $body `
    -HeadOnly $HeadOnly
}

function Write-ErrorResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$Message
  )

  Write-JsonResponse `
    -Stream $Stream `
    -StatusCode $StatusCode `
    -StatusText $StatusText `
    -Payload @{ error = $Message }
}

function Read-AsciiLine {
  param([System.Net.Sockets.NetworkStream]$Stream)

  $buffer = [System.Collections.Generic.List[byte]]::new()

  while ($true) {
    $value = $Stream.ReadByte()

    if ($value -lt 0) {
      if ($buffer.Count -eq 0) {
        return $null
      }

      break
    }

    if ($value -eq 10) {
      break
    }

    if ($value -ne 13) {
      $buffer.Add([byte]$value)
    }

    if ($buffer.Count -gt 65536) {
      throw "HTTP header is too large."
    }
  }

  return [System.Text.Encoding]::ASCII.GetString($buffer.ToArray())
}

function Read-ExactBytes {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$Length
  )

  $buffer = [byte[]]::new($Length)
  $offset = 0

  while ($offset -lt $Length) {
    $read = $Stream.Read($buffer, $offset, $Length - $offset)

    if ($read -le 0) {
      throw "Unexpected end of HTTP request body."
    }

    $offset += $read
  }

  return ,$buffer
}

function Read-HttpRequest {
  param([System.Net.Sockets.NetworkStream]$Stream)

  $requestLine = Read-AsciiLine -Stream $Stream

  if ([string]::IsNullOrWhiteSpace($requestLine)) {
    return $null
  }

  $parts = $requestLine.Split(" ", 3)

  if ($parts.Length -lt 2) {
    throw "Invalid HTTP request line."
  }

  $headers = @{}

  while ($true) {
    $line = Read-AsciiLine -Stream $Stream

    if ($null -eq $line -or $line.Length -eq 0) {
      break
    }

    $separator = $line.IndexOf(":")

    if ($separator -le 0) {
      continue
    }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    $headers[$name] = $value
  }

  $contentLength = 0

  if ($headers.ContainsKey("Content-Length")) {
    $contentLength = [int]$headers["Content-Length"]
  }

  $body = [byte[]]::new(0)

  if ($contentLength -gt 0) {
    $body = Read-ExactBytes -Stream $Stream -Length $contentLength
  }

  return [PSCustomObject]@{
    Method = $parts[0].ToUpperInvariant()
    Target = $parts[1]
    Headers = $headers
    Body = $body
  }
}

function Get-RequestHeader {
  param(
    [hashtable]$Headers,
    [string]$Name,
    [string]$DefaultValue = ""
  )

  if ($Headers.ContainsKey($Name)) {
    return [string]$Headers[$Name]
  }

  return $DefaultValue
}

function Test-ComfyPort {
  param([int]$ComfyPort)

  $client = $null

  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $task = $client.ConnectAsync("127.0.0.1", $ComfyPort)

    if (-not $task.Wait(350)) {
      return $false
    }

    return $client.Connected
  } catch {
    return $false
  } finally {
    if ($client) {
      $client.Dispose()
    }
  }
}

function Get-DefaultComfyCandidates {
  $candidates = [System.Collections.Generic.List[string]]::new()

  if (-not [string]::IsNullOrWhiteSpace($env:COMFYUI_ROOT)) {
    $candidates.Add($env:COMFYUI_ROOT)
  }

  $candidates.Add("D:\AI\ComfyUI")
  $candidates.Add("D:\ComfyUI")
  $candidates.Add((Join-Path $env:USERPROFILE "ComfyUI"))
  $candidates.Add((Join-Path $env:USERPROFILE "Documents\ComfyUI"))

  return $candidates
}

function Resolve-ComfyInstall {
  param([string]$InstallRoot)

  if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    return [PSCustomObject]@{
      valid = $false
      root = ""
      comfyDirectory = ""
      mainPath = ""
      pythonPath = ""
      customNodesDirectory = ""
      modelsDirectory = ""
      tempDirectory = ""
      checkpointsDirectory = ""
      samsDirectory = ""
      detectorPath = ""
      samPath = ""
      error = "ComfyUI path is empty."
    }
  }

  try {
    $fullRoot = [System.IO.Path]::GetFullPath(
      $InstallRoot.Trim().Trim('"')
    )
  } catch {
    return [PSCustomObject]@{
      valid = $false
      root = $InstallRoot
      comfyDirectory = ""
      mainPath = ""
      pythonPath = ""
      customNodesDirectory = ""
      modelsDirectory = ""
      tempDirectory = ""
      checkpointsDirectory = ""
      samsDirectory = ""
      detectorPath = ""
      samPath = ""
      error = "ComfyUI path is invalid."
    }
  }

  $mainPath = Join-Path $fullRoot "ComfyUI\main.py"

  if (-not [System.IO.File]::Exists($mainPath)) {
    $mainPath = Join-Path $fullRoot "main.py"
  }

  $comfyDirectory = Split-Path $mainPath -Parent
  $pythonPath = Join-Path $fullRoot "python_embeded\python.exe"

  if (-not [System.IO.File]::Exists($pythonPath)) {
    $pythonPath = Join-Path $comfyDirectory "..\python_embeded\python.exe"
    $pythonPath = [System.IO.Path]::GetFullPath($pythonPath)
  }

  $valid =
    [System.IO.File]::Exists($mainPath) -and
    [System.IO.File]::Exists($pythonPath)

  return [PSCustomObject]@{
    valid = $valid
    root = $fullRoot
    comfyDirectory = $comfyDirectory
    mainPath = $mainPath
    pythonPath = $pythonPath
    customNodesDirectory = Join-Path $comfyDirectory "custom_nodes"
    modelsDirectory = Join-Path $comfyDirectory "models"
    tempDirectory = Join-Path $comfyDirectory "temp"
    checkpointsDirectory = Join-Path $comfyDirectory "models\checkpoints"
    samsDirectory = Join-Path $comfyDirectory "models\sams"
    detectorPath = Join-Path $comfyDirectory (
      "models\ultralytics\bbox\face_yolov8m.pt"
    )
    samPath = Join-Path $comfyDirectory "models\sams\sam_vit_b_01ec64.pth"
    error = if ($valid) { "" } else { "ComfyUI main.py or python_embeded is missing." }
  }
}

function Get-ComfyConfig {
  $configuredRoot = ""
  $configuredPort = 8188

  if ([System.IO.File]::Exists($comfyConfigPath)) {
    try {
      $saved = Get-Content -Raw -LiteralPath $comfyConfigPath |
        ConvertFrom-Json

      if ($saved.root) {
        $configuredRoot = [string]$saved.root
      }

      if ($saved.port) {
        $configuredPort = [int]$saved.port
      }
    } catch {
      $configuredRoot = ""
    }
  }

  if ([string]::IsNullOrWhiteSpace($configuredRoot)) {
    foreach ($candidate in Get-DefaultComfyCandidates) {
      $resolved = Resolve-ComfyInstall -InstallRoot $candidate

      if ($resolved.valid) {
        $configuredRoot = $resolved.root
        break
      }
    }
  }

  return [PSCustomObject]@{
    root = $configuredRoot
    port = $configuredPort
  }
}

function Save-ComfyConfig {
  param(
    [string]$InstallRoot,
    [int]$ComfyPort
  )

  [System.IO.Directory]::CreateDirectory($appDataDirectory) | Out-Null
  $payload = [ordered]@{
    root = $InstallRoot
    port = $ComfyPort
  }
  $payload |
    ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $comfyConfigPath -Encoding UTF8

  return (Get-ComfyConfig)
}

function Get-CheckpointFiles {
  param($ComfyInfo)

  $models = [System.Collections.Generic.List[string]]::new()

  if ($ComfyInfo.valid -and (Test-Path -LiteralPath $ComfyInfo.checkpointsDirectory)) {
    $extensions = @(".safetensors", ".ckpt", ".pt", ".pth")

    Get-ChildItem `
      -LiteralPath $ComfyInfo.checkpointsDirectory `
      -File `
      -Recurse `
      -ErrorAction SilentlyContinue |
      Where-Object {
        $extensions -contains $_.Extension.ToLowerInvariant()
      } |
      ForEach-Object {
        $relative = $_.FullName.Substring(
          $ComfyInfo.checkpointsDirectory.Length
        ).TrimStart("\")
        $models.Add($relative)
      }
  }

  return @($models | Sort-Object -Unique)
}

function Get-ComfyNodeState {
  param($ComfyInfo)

  $impactPack = $false
  $impactSubpack = $false
  $sam = $false

  if ($ComfyInfo.valid) {
    $impactPack = @(
      Get-ChildItem `
        -LiteralPath $ComfyInfo.customNodesDirectory `
        -Directory `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ComfyUI-Impact-Pack" }
    ).Count -gt 0
    $impactSubpack = @(
      Get-ChildItem `
        -LiteralPath $ComfyInfo.customNodesDirectory `
        -Directory `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "ComfyUI-Impact-Subpack" }
    ).Count -gt 0
    $sam = @(
      Get-ChildItem `
        -LiteralPath $ComfyInfo.samsDirectory `
        -File `
        -ErrorAction SilentlyContinue |
        Where-Object {
          @(".pt", ".pth", ".safetensors") -contains $_.Extension.ToLowerInvariant()
        }
    ).Count -gt 0
  }

  return [ordered]@{
    impactPack = $impactPack
    impactSubpack = $impactSubpack
    faceDetector = $ComfyInfo.valid -and [System.IO.File]::Exists(
      $ComfyInfo.detectorPath
    )
    sam = $sam
  }
}

function Get-ManagedComfyProcess {
  if (-not $managedComfyPid) {
    return $null
  }

  try {
    $process = Get-Process -Id $managedComfyPid -ErrorAction Stop

    if (
      $managedComfyStartedAt -and
      $process.StartTime -ne $managedComfyStartedAt
    ) {
      return $null
    }

    return $process
  } catch {
    $script:managedComfyProcess = $null
    $script:managedComfyPid = $null
    $script:managedComfyStartedAt = $null
    return $null
  }
}

function Stop-ManagedComfyService {
  $process = Get-ManagedComfyProcess

  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }

  $script:managedComfyProcess = $null
  $script:managedComfyPid = $null
  $script:managedComfyStartedAt = $null
}

function Start-ComfyService {
  param($ComfyInfo)

  if (-not $ComfyInfo.valid) {
    throw "ComfyUI path is invalid."
  }

  if (Test-ComfyPort -ComfyPort (Get-ComfyConfig).port) {
    return $false
  }

  [System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
  [System.IO.Directory]::CreateDirectory($appDataDirectory) | Out-Null

  $stdoutPath = Join-Path $temporaryDirectory "comfyui-stdout.log"
  $stderrPath = Join-Path $temporaryDirectory "comfyui-stderr.log"
  $comfyPort = (Get-ComfyConfig).port
  $quotedMain = '"' + $ComfyInfo.mainPath.Replace('"', '""') + '"'
  $arguments = @(
    $quotedMain,
    "--listen",
    "127.0.0.1",
    "--port",
    [string]$comfyPort,
    "--disable-auto-launch"
  )
  $process = Start-Process `
    -FilePath $ComfyInfo.pythonPath `
    -ArgumentList $arguments `
    -WorkingDirectory $ComfyInfo.comfyDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $script:managedComfyProcess = $process
  $script:managedComfyPid = $process.Id
  $script:managedComfyStartedAt = $process.StartTime
  $script:lastManagedActivity = Get-Date

  $deadline = (Get-Date).AddSeconds(90)

  while ((Get-Date) -lt $deadline) {
    if (Test-ComfyPort -ComfyPort $comfyPort) {
      return $true
    }

    if ($process.HasExited) {
      $tail = ""

      if (Test-Path -LiteralPath $stderrPath) {
        $tail = (
          Get-Content -LiteralPath $stderrPath -Tail 8 -ErrorAction SilentlyContinue
        ) -join " "
      }

      Stop-ManagedComfyService
      throw "ComfyUI exited during startup. $tail"
    }

    Start-Sleep -Milliseconds 250
  }

  Stop-ManagedComfyService
  throw "ComfyUI did not become ready within 90 seconds."
}

function Ensure-ComfyService {
  param($ComfyInfo)

  $comfyPort = (Get-ComfyConfig).port

  if (Test-ComfyPort -ComfyPort $comfyPort) {
    return
  }

  Start-ComfyService -ComfyInfo $ComfyInfo | Out-Null
}

function Get-ComfyStatusPayload {
  $config = Get-ComfyConfig
  $info = Resolve-ComfyInstall -InstallRoot $config.root
  $online = Test-ComfyPort -ComfyPort $config.port
  $managedProcess = Get-ManagedComfyProcess
  $models = @(Get-CheckpointFiles -ComfyInfo $info)
  $nodes = Get-ComfyNodeState -ComfyInfo $info

  return [ordered]@{
    valid = $info.valid
    root = $config.root
    port = $config.port
    online = $online
    managed = $null -ne $managedProcess
    nodes = $nodes
    models = $models
    error = $info.error
  }
}

function Invoke-ComfyJson {
  param(
    [string]$Method,
    [string]$Uri,
    $Payload
  )

  $parameters = @{
    Method = $Method
    Uri = $Uri
    UseBasicParsing = $true
    TimeoutSec = 120
  }

  if ($null -ne $Payload) {
    $json = $Payload | ConvertTo-Json -Depth 24 -Compress
    $parameters.ContentType = "application/json; charset=utf-8"
    $parameters.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }

  $response = Invoke-WebRequest @parameters

  if ([string]::IsNullOrWhiteSpace($response.Content)) {
    return $null
  }

  return $response.Content | ConvertFrom-Json
}

function New-MultipartUpload {
  param(
    [byte[]]$FileBytes,
    [string]$FileName
  )

  $boundary = "----ColorAdjustApp$([Guid]::NewGuid().ToString('N'))"
  $stream = [System.IO.MemoryStream]::new()
  $encoding = [System.Text.Encoding]::UTF8
  $lineBreak = "`r`n"

  $fieldText = (
    "--$boundary$lineBreak" +
    "Content-Disposition: form-data; name=`"type`"$lineBreak$lineBreak" +
    "temp$lineBreak" +
    "--$boundary$lineBreak" +
    "Content-Disposition: form-data; name=`"overwrite`"$lineBreak$lineBreak" +
    "true$lineBreak"
  )
  $fieldBytes = $encoding.GetBytes($fieldText)
  $stream.Write($fieldBytes, 0, $fieldBytes.Length)

  $fileHeader = (
    "--$boundary$lineBreak" +
    "Content-Disposition: form-data; name=`"image`"; filename=`"$FileName`"$lineBreak" +
    "Content-Type: image/png$lineBreak$lineBreak"
  )
  $fileHeaderBytes = $encoding.GetBytes($fileHeader)
  $stream.Write($fileHeaderBytes, 0, $fileHeaderBytes.Length)
  $stream.Write($FileBytes, 0, $FileBytes.Length)

  $footerBytes = $encoding.GetBytes(
    "$lineBreak--$boundary--$lineBreak"
  )
  $stream.Write($footerBytes, 0, $footerBytes.Length)

  $body = $stream.ToArray()
  $stream.Dispose()

  return [PSCustomObject]@{
    boundary = $boundary
    body = $body
  }
}

function Upload-ComfyImage {
  param(
    $ComfyInfo,
    [int]$ComfyPort,
    [byte[]]$ImageBytes,
    [string]$FileName
  )

  $multipart = New-MultipartUpload -FileBytes $ImageBytes -FileName $FileName
  $response = Invoke-WebRequest `
    -Method Post `
    -Uri "http://127.0.0.1:$ComfyPort/upload/image" `
    -ContentType "multipart/form-data; boundary=$($multipart.boundary)" `
    -Body $multipart.body `
    -UseBasicParsing `
    -TimeoutSec 180

  return ($response.Content | ConvertFrom-Json)
}

function Get-FirstSamModel {
  param($ComfyInfo)

  if (-not (Test-Path -LiteralPath $ComfyInfo.samsDirectory)) {
    return ""
  }

  $models = Get-ChildItem `
    -LiteralPath $ComfyInfo.samsDirectory `
    -File `
    -ErrorAction SilentlyContinue |
    Where-Object {
      @(".pt", ".pth", ".safetensors") -contains $_.Extension.ToLowerInvariant()
    } |
    Sort-Object Name

  $preferred = $models |
    Where-Object { $_.Name -eq "sam_vit_b_01ec64.pth" } |
    Select-Object -First 1

  if ($preferred) {
    return $preferred.Name
  }

  return [string]$models[0].Name
}

function New-ComfyWorkflow {
  param(
    [string]$Model,
    [string]$InputName,
    [double]$Beautify,
    [double]$DetailRetention,
    $ComfyInfo
  )

  if (-not [System.IO.File]::Exists($workflowPath)) {
    throw "Portrait workflow template is missing."
  }

  $workflow = Get-Content -Raw -LiteralPath $workflowPath |
    ConvertFrom-Json
  $samModel = Get-FirstSamModel -ComfyInfo $ComfyInfo

  if ([string]::IsNullOrWhiteSpace($samModel)) {
    throw "No SAM model was found in ComfyUI models\sams."
  }

  if (-not [System.IO.File]::Exists($ComfyInfo.detectorPath)) {
    throw "face_yolov8m.pt was not found in ComfyUI models."
  }

  # Higher strength redraws more of the face; higher detail retention
  # blends less of the detailer result back over the original crop.
  $denoise = 0.20 + 0.45 * $Beautify
  $blendFactor = (0.35 + 0.65 * $Beautify) * (
    1.0 - 0.25 * $DetailRetention
  )
  $blendFactor = [Math]::Min(1.0, [Math]::Max(0.0, $blendFactor))

  if ($denoise -lt 0.0001 -or $denoise -gt 1.0) {
    throw "Beautify strength produced an out-of-range denoise value."
  }

  $workflow.'1'.inputs.image = "$InputName [temp]"
  $workflow.'2'.inputs.ckpt_name = $Model
  $workflow.'5'.inputs.model_name = "bbox/face_yolov8m.pt"
  $workflow.'6'.inputs.model_name = $samModel
  $workflow.'7'.inputs.bbox_crop_factor = 2.0
  $workflow.'7'.inputs.seed = Get-Random -Minimum 0 -Maximum 2147483647
  $workflow.'7'.inputs.denoise = [Math]::Round($denoise, 4)
  $workflow.'8'.inputs.blend_factor = [Math]::Round($blendFactor, 4)

  return $workflow
}

function Save-UploadBytes {
  param(
    [string]$JobId,
    [byte[]]$Bytes
  )

  [System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
  $path = Join-Path $temporaryDirectory "upload-$JobId.png"
  [System.IO.File]::WriteAllBytes($path, $Bytes)
  return $path
}

function Remove-SafeFile {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $temporaryRoot = [System.IO.Path]::GetFullPath($temporaryDirectory)
    $comfyRoot = ""
    $config = Get-ComfyConfig
    $info = Resolve-ComfyInstall -InstallRoot $config.root

    if ($info.valid) {
      $comfyRoot = [System.IO.Path]::GetFullPath($info.tempDirectory)
    }

    $temporaryPrefix = $temporaryRoot.TrimEnd("\") + "\"
    $comfyPrefix = if ($comfyRoot) {
      $comfyRoot.TrimEnd("\") + "\"
    } else {
      ""
    }
    $allowed =
      $fullPath.StartsWith(
        $temporaryPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or (
        $comfyPrefix -and
        $fullPath.StartsWith(
          $comfyPrefix,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      )

    if ($allowed -and [System.IO.File]::Exists($fullPath)) {
      [System.IO.File]::Delete($fullPath)
    }
  } catch {
    Write-Warning "Failed to remove temporary file: $Path"
  }
}

function Get-ImageInfoFromOutputs {
  param(
    $Outputs,
    [string]$NodeId
  )

  if ($null -eq $Outputs) {
    return $null
  }

  $property = $Outputs.PSObject.Properties[$NodeId]

  if (-not $property) {
    return $null
  }

  $images = $property.Value.images

  if ($null -eq $images -or $images.Count -eq 0) {
    return $null
  }

  return $images[$images.Count - 1]
}

function Get-ComfyImagePath {
  param(
    $ComfyInfo,
    $ImageInfo
  )

  $directory = switch ([string]$ImageInfo.type) {
    "output" { Join-Path $ComfyInfo.comfyDirectory "output" }
    "input" { Join-Path $ComfyInfo.comfyDirectory "input" }
    default { $ComfyInfo.tempDirectory }
  }

  $subfolder = [string]$ImageInfo.subfolder

  if (-not [string]::IsNullOrWhiteSpace($subfolder)) {
    $directory = Join-Path $directory $subfolder
  }

  return [System.IO.Path]::GetFullPath(
    (Join-Path $directory ([string]$ImageInfo.filename))
  )
}

function Get-ComfyImageUrl {
  param(
    [int]$ComfyPort,
    $ImageInfo
  )

  $filename = [System.Uri]::EscapeDataString([string]$ImageInfo.filename)
  $subfolder = [System.Uri]::EscapeDataString([string]$ImageInfo.subfolder)
  $type = [System.Uri]::EscapeDataString([string]$ImageInfo.type)

  return (
    "http://127.0.0.1:$ComfyPort/view" +
    "?filename=$filename&subfolder=$subfolder&type=$type"
  )
}

function Save-ComfyPreviewImage {
  param(
    [int]$ComfyPort,
    $ImageInfo,
    [string]$Destination
  )

  Invoke-WebRequest `
    -Uri (Get-ComfyImageUrl -ComfyPort $ComfyPort -ImageInfo $ImageInfo) `
    -OutFile $Destination `
    -UseBasicParsing `
    -TimeoutSec 180 | Out-Null
}

function Get-SafeOutputFileName {
  param(
    [string]$Name,
    [string]$Fallback
  )

  $candidate = [System.IO.Path]::GetFileName([string]$Name)

  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $candidate = $Fallback
  }

  $invalidCharacters = [System.IO.Path]::GetInvalidFileNameChars()
  $builder = [System.Text.StringBuilder]::new()

  foreach ($character in $candidate.ToCharArray()) {
    if (
      $invalidCharacters -contains $character -or
      [char]::IsControl($character)
    ) {
      [void]$builder.Append("_")
    } else {
      [void]$builder.Append($character)
    }
  }

  $candidate = $builder.ToString().Trim().TrimEnd(".")

  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $candidate = $Fallback
  }

  if (
    -not $candidate.EndsWith(
      ".png",
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    $candidate += ".png"
  }

  if ($candidate.Length -gt 140) {
    $candidate = $candidate.Substring(0, 136) + ".png"
  }

  return $candidate
}

function Save-ComfyJobOutput {
  param($Job)

  if (-not [System.IO.File]::Exists($Job.resultPath)) {
    throw "The AI result file is missing."
  }

  [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
  $fileName = Get-SafeOutputFileName `
    -Name $Job.outputName `
    -Fallback "ColorAdjustAI-$($Job.id).png"
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
  $extension = [System.IO.Path]::GetExtension($fileName)
  $targetPath = Join-Path $outputDirectory $fileName
  $suffix = 2

  while ([System.IO.File]::Exists($targetPath)) {
    $targetPath = Join-Path $outputDirectory "$baseName-$suffix$extension"
    $suffix += 1
  }

  [System.IO.File]::Copy($Job.resultPath, $targetPath, $false)
  $savedFileName = [System.IO.Path]::GetFileName($targetPath)
  $Job.savedPath = $targetPath
  $Job.resultUrl = "/outputs/$([System.Uri]::EscapeDataString($savedFileName))"
}

function Test-MaskContainsFace {
  param([string]$MaskPath)

  if (-not [System.IO.File]::Exists($MaskPath)) {
    return $true
  }

  Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
  $bitmap = $null

  try {
    $bitmap = [System.Drawing.Bitmap]::FromFile($MaskPath)
    $stepX = [Math]::Max(1, [Math]::Floor($bitmap.Width / 160))
    $stepY = [Math]::Max(1, [Math]::Floor($bitmap.Height / 160))

    for ($y = 0; $y -lt $bitmap.Height; $y += $stepY) {
      for ($x = 0; $x -lt $bitmap.Width; $x += $stepX) {
        $pixel = $bitmap.GetPixel($x, $y)

        if ($pixel.R -gt 8 -or $pixel.G -gt 8 -or $pixel.B -gt 8) {
          return $true
        }
      }
    }

    return $false
  } catch {
    return $true
  } finally {
    if ($bitmap) {
      $bitmap.Dispose()
    }
  }
}

function Cleanup-ComfyJobFiles {
  param(
    $Job,
    [switch]$KeepResult
  )

  Remove-SafeFile -Path $Job.localUploadPath
  Remove-SafeFile -Path $Job.comfyUploadPath
  Remove-SafeFile -Path $Job.maskPath
  Remove-SafeFile -Path $Job.comfyMaskPath
  Remove-SafeFile -Path $Job.comfyResultPath

  if (-not $KeepResult) {
    Remove-SafeFile -Path $Job.resultPath
  }
}

function Set-ComfyJobProgress {
  param(
    $Job,
    [double]$Progress
  )

  $Job.progress = [Math]::Max($Job.progress, [Math]::Min(99, $Progress))
}

function Update-ComfyJobState {
  param(
    $Job,
    $ComfyInfo,
    [int]$ComfyPort
  )

  if (
    $Job.state -in @("succeeded", "failed", "cancelled", "no_face")
  ) {
    return
  }

  $Job.updatedAt = Get-Date

  if (-not (Test-ComfyPort -ComfyPort $ComfyPort)) {
    $Job.state = "failed"
    $Job.error = "ComfyUI stopped while the task was running."
    Cleanup-ComfyJobFiles -Job $Job
    return
  }

  try {
    $history = Invoke-ComfyJson `
      -Method "GET" `
      -Uri "http://127.0.0.1:$ComfyPort/history/$($Job.promptId)"
    $recordProperty = $history.PSObject.Properties[$Job.promptId]

    if ($recordProperty) {
      $record = $recordProperty.Value
      $statusText = [string]$record.status.status_str

      if ($statusText -eq "error") {
        $Job.state = "failed"
        $Job.error = "ComfyUI reported an execution error."
        Cleanup-ComfyJobFiles -Job $Job
        return
      }

      if ($statusText -eq "success") {
        $outputs = $record.outputs
        $maskInfo = Get-ImageInfoFromOutputs -Outputs $outputs -NodeId "10"
        $resultInfo = Get-ImageInfoFromOutputs -Outputs $outputs -NodeId "11"

        if ($null -eq $resultInfo) {
          $Job.state = "failed"
          $Job.error = "ComfyUI completed without an output image."
          Cleanup-ComfyJobFiles -Job $Job
          return
        }

        if ($maskInfo) {
          $Job.maskPath = Join-Path `
            $temporaryDirectory `
            "mask-$($Job.id).png"
          Save-ComfyPreviewImage `
            -ComfyPort $ComfyPort `
            -ImageInfo $maskInfo `
            -Destination $Job.maskPath
          $Job.comfyMaskPath = Get-ComfyImagePath `
            -ComfyInfo $ComfyInfo `
            -ImageInfo $maskInfo
        }

        $Job.resultPath = Join-Path `
          $temporaryDirectory `
          "result-$($Job.id).png"
        Save-ComfyPreviewImage `
          -ComfyPort $ComfyPort `
          -ImageInfo $resultInfo `
          -Destination $Job.resultPath
        $Job.comfyResultPath = Get-ComfyImagePath `
          -ComfyInfo $ComfyInfo `
          -ImageInfo $resultInfo

        if ($Job.maskPath -and -not (Test-MaskContainsFace $Job.maskPath)) {
          $Job.state = "no_face"
          $Job.progress = 100
          $Job.updatedAt = Get-Date
          Cleanup-ComfyJobFiles -Job $Job
          return
        }

        Save-ComfyJobOutput -Job $Job
        $Job.state = "succeeded"
        $Job.progress = 100
        $Job.updatedAt = Get-Date
        Cleanup-ComfyJobFiles -Job $Job -KeepResult
        return
      }
    }

    $queue = Invoke-ComfyJson `
      -Method "GET" `
      -Uri "http://127.0.0.1:$ComfyPort/queue"
    $runningIds = @(
      $queue.queue_running | ForEach-Object { [string]$_[1] }
    )
    $pendingIds = @(
      $queue.queue_pending | ForEach-Object { [string]$_[1] }
    )

    if ($runningIds -contains [string]$Job.promptId) {
      $Job.state = "running"
      Set-ComfyJobProgress -Job $Job -Progress 45
    } else {
      $Job.state = "queued"
      Set-ComfyJobProgress -Job $Job -Progress 25
    }
  } catch {
    $Job.state = "failed"
    $Job.error = $_.Exception.Message
    Cleanup-ComfyJobFiles -Job $Job
  }
}

function Cancel-ComfyJobState {
  param(
    $Job,
    [int]$ComfyPort
  )

  if ($Job.state -in @("succeeded", "failed", "cancelled", "no_face")) {
    return
  }

  try {
    if (Test-ComfyPort -ComfyPort $ComfyPort -and $Job.promptId) {
      $queue = Invoke-ComfyJson `
        -Method "GET" `
        -Uri "http://127.0.0.1:$ComfyPort/queue"
      $running = @(
        $queue.queue_running | Where-Object {
          [string]$_[1] -eq [string]$Job.promptId
        }
      ).Count -gt 0
      $pending = @(
        $queue.queue_pending | Where-Object {
          [string]$_[1] -eq [string]$Job.promptId
        }
      ).Count -gt 0

      if ($running) {
        Invoke-ComfyJson `
          -Method "POST" `
          -Uri "http://127.0.0.1:$ComfyPort/interrupt" `
          -Payload @{} | Out-Null
      }

      if ($running -or $pending) {
        Invoke-ComfyJson `
          -Method "POST" `
          -Uri "http://127.0.0.1:$ComfyPort/queue" `
          -Payload @{ delete = @($Job.promptId) } | Out-Null
      }
    }
  } catch {
    Write-Warning "Failed to interrupt ComfyUI job $($Job.id): $_"
  }

  $Job.state = "cancelled"
  Cleanup-ComfyJobFiles -Job $Job
}

function Submit-ComfyJob {
  param(
    [byte[]]$ImageBytes,
    [string]$Model,
    [double]$Beautify,
    [double]$DetailRetention,
    [string]$OutputName
  )

  $config = Get-ComfyConfig
  $comfyPort = $config.port
  $comfyInfo = Resolve-ComfyInstall -InstallRoot $config.root

  if (-not $comfyInfo.valid) {
    throw "ComfyUI is not configured."
  }

  $availableModels = @(Get-CheckpointFiles -ComfyInfo $comfyInfo)

  if ($availableModels -notcontains $Model) {
    throw "The selected checkpoint is not available."
  }

  Ensure-ComfyService -ComfyInfo $comfyInfo

  $jobId = [Guid]::NewGuid().ToString("N")
  $localUploadPath = Save-UploadBytes -JobId $jobId -Bytes $ImageBytes
  $uploadName = "ColorAdjustApp_$jobId.png"
  $job = [ordered]@{
    id = $jobId
    state = "uploading"
    progress = 5
    error = ""
    promptId = ""
    model = $Model
    beautify = $Beautify
    detailRetention = $DetailRetention
    outputName = $OutputName
    localUploadPath = $localUploadPath
    comfyUploadPath = ""
    comfyResultPath = ""
    comfyMaskPath = ""
    maskPath = ""
    resultPath = ""
    savedPath = ""
    resultUrl = ""
    createdAt = Get-Date
    updatedAt = Get-Date
  }
  $jobs[$jobId] = $job

  try {
    $upload = Upload-ComfyImage `
      -ComfyInfo $comfyInfo `
      -ComfyPort $comfyPort `
      -ImageBytes $ImageBytes `
      -FileName $uploadName
    $uploadedName = [string]$upload.name
    $uploadedSubfolder = [string]$upload.subfolder

    if ([string]::IsNullOrWhiteSpace($uploadedName)) {
      throw "ComfyUI did not return an uploaded image name."
    }

    $job.comfyUploadPath = Get-ComfyImagePath `
      -ComfyInfo $comfyInfo `
      -ImageInfo ([PSCustomObject]@{
        filename = $uploadedName
        subfolder = $uploadedSubfolder
        type = "temp"
      })
    $workflow = New-ComfyWorkflow `
      -Model $Model `
      -InputName $uploadedName `
      -Beautify $Beautify `
      -DetailRetention $DetailRetention `
      -ComfyInfo $comfyInfo
    $payload = [ordered]@{
      prompt = $workflow
      client_id = "ColorAdjustApp_$jobId"
    }
    $promptResponse = Invoke-ComfyJson `
      -Method "POST" `
      -Uri "http://127.0.0.1:$comfyPort/prompt" `
      -Payload $payload

    if (-not $promptResponse.prompt_id) {
      throw "ComfyUI did not accept the workflow."
    }

    $job.promptId = [string]$promptResponse.prompt_id
    $job.state = "queued"
    $job.progress = 20
    $job.updatedAt = Get-Date
    Remove-SafeFile -Path $localUploadPath
    return $job
  } catch {
    $job.state = "failed"
    $job.error = $_.Exception.Message
    Cleanup-ComfyJobFiles -Job $job
    throw
  }
}

function Get-JobPayload {
  param($Job)

  return [ordered]@{
    id = $Job.id
    state = $Job.state
    progress = [Math]::Round([double]$Job.progress, 0)
    error = $Job.error
    savedPath = $Job.savedPath
    resultUrl = $Job.resultUrl
  }
}

function Cleanup-ExpiredJobs {
  $expiredIds = @(
    $jobs.Keys | Where-Object {
      $job = $jobs[$_]
      (
        $job.state -in @("succeeded", "failed", "cancelled", "no_face")
      ) -and
      ((Get-Date) - $job.updatedAt).TotalHours -ge 1
    }
  )

  foreach ($jobId in $expiredIds) {
    $job = $jobs[$jobId]
    Cleanup-ComfyJobFiles -Job $job
    $jobs.Remove($jobId)
  }
}

function Test-HasActiveJobs {
  return @(
    $jobs.Values | Where-Object {
      $_.state -in @("uploading", "queued", "running")
    }
  ).Count -gt 0
}

function Stop-IdleManagedComfy {
  if (Test-HasActiveJobs) {
    return
  }

  $process = Get-ManagedComfyProcess

  if (
    $process -and
    ((Get-Date) - $lastManagedActivity).TotalMinutes -ge 10
  ) {
    Stop-ManagedComfyService
  }
}

function Handle-ComfyApi {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    $Request,
    [string]$Path
  )

  if ($Path -eq "/api/comfy/status" -and $Request.Method -eq "GET") {
    Write-JsonResponse `
      -Stream $Stream `
      -StatusCode 200 `
      -StatusText "OK" `
      -Payload (Get-ComfyStatusPayload)
    return
  }

  if ($Path -eq "/api/comfy/config" -and $Request.Method -eq "POST") {
    $payload = [System.Text.Encoding]::UTF8.GetString($Request.Body) |
      ConvertFrom-Json
    $installRoot = [string]$payload.root
    $comfyPort = [int]$payload.port

    if ($comfyPort -lt 1 -or $comfyPort -gt 65535) {
      throw "ComfyUI port must be between 1 and 65535."
    }

    $resolved = Resolve-ComfyInstall -InstallRoot $installRoot

    if (-not $resolved.valid) {
      throw "The folder does not contain ComfyUI\main.py and python_embeded\python.exe."
    }

    Save-ComfyConfig `
      -InstallRoot $resolved.root `
      -ComfyPort $comfyPort | Out-Null
    Write-JsonResponse `
      -Stream $Stream `
      -StatusCode 200 `
      -StatusText "OK" `
      -Payload (Get-ComfyStatusPayload)
    return
  }

  if ($Path -eq "/api/comfy/models" -and $Request.Method -eq "GET") {
    $config = Get-ComfyConfig
    $info = Resolve-ComfyInstall -InstallRoot $config.root

    if (-not $info.valid) {
      throw "ComfyUI is not configured."
    }

    $models = @(Get-CheckpointFiles -ComfyInfo $info)
    $model = if ($models.Count -gt 0) { $models[0] } else { "" }

    Write-JsonResponse `
      -Stream $Stream `
      -StatusCode 200 `
      -StatusText "OK" `
      -Payload ([ordered]@{
        models = $models
        model = $model
      })
    return
  }

  if ($Path -eq "/api/comfy/jobs" -and $Request.Method -eq "POST") {
    if ($Request.Body.Length -eq 0) {
      throw "The uploaded image is empty."
    }

    $modelHeader = Get-RequestHeader `
      -Headers $Request.Headers `
      -Name "X-ColorAdjust-Model"
    $beautifyHeader = Get-RequestHeader `
      -Headers $Request.Headers `
      -Name "X-ColorAdjust-Beautify" `
      -DefaultValue "0.5"
    $detailHeader = Get-RequestHeader `
      -Headers $Request.Headers `
      -Name "X-ColorAdjust-Detail" `
      -DefaultValue "0"
    $outputNameHeader = Get-RequestHeader `
      -Headers $Request.Headers `
      -Name "X-ColorAdjust-Output-Name"
    $model = [System.Uri]::UnescapeDataString($modelHeader)
    $outputName = if ([string]::IsNullOrWhiteSpace($outputNameHeader)) {
      ""
    } else {
      [System.Uri]::UnescapeDataString($outputNameHeader)
    }
    $beautify = [double]::Parse(
      $beautifyHeader,
      [System.Globalization.CultureInfo]::InvariantCulture
    )
    $detailRetention = [double]::Parse(
      $detailHeader,
      [System.Globalization.CultureInfo]::InvariantCulture
    )

    if ([string]::IsNullOrWhiteSpace($model)) {
      throw "No portrait checkpoint was selected."
    }

    $beautify = [Math]::Max(0, [Math]::Min(1, $beautify))
    $detailRetention = [Math]::Max(0, [Math]::Min(1, $detailRetention))
    $job = Submit-ComfyJob `
      -ImageBytes $Request.Body `
      -Model $model `
      -Beautify $beautify `
      -DetailRetention $detailRetention `
      -OutputName $outputName
    $script:lastManagedActivity = Get-Date
    Write-JsonResponse `
      -Stream $Stream `
      -StatusCode 202 `
      -StatusText "Accepted" `
      -Payload (Get-JobPayload -Job $job)
    return
  }

  $jobMatch = [regex]::Match(
    $Path,
    "^/api/comfy/jobs/([0-9a-f]{32})(?:/result)?$"
  )

  if ($jobMatch.Success) {
    $jobId = $jobMatch.Groups[1].Value

    if (-not $jobs.ContainsKey($jobId)) {
      throw "Task not found."
    }

    $job = $jobs[$jobId]
    $config = Get-ComfyConfig
    $info = Resolve-ComfyInstall -InstallRoot $config.root

    if ($Path.EndsWith("/result")) {
      if ($Request.Method -ne "GET") {
        Write-ErrorResponse `
          -Stream $Stream `
          -StatusCode 405 `
          -StatusText "Method Not Allowed" `
          -Message "Method not allowed."
        return
      }

      Update-ComfyJobState `
        -Job $job `
        -ComfyInfo $info `
        -ComfyPort $config.port
      $script:lastManagedActivity = Get-Date

      if ($job.state -ne "succeeded") {
        throw "The task result is not ready."
      }

      if (-not [System.IO.File]::Exists($job.resultPath)) {
        throw "The task result file is missing."
      }

      $body = [System.IO.File]::ReadAllBytes($job.resultPath)
      Write-HttpResponse `
        -Stream $Stream `
        -StatusCode 200 `
        -StatusText "OK" `
        -ContentType "image/png" `
        -Body $body
      return
    }

    if ($Request.Method -eq "GET") {
      Update-ComfyJobState `
        -Job $job `
        -ComfyInfo $info `
        -ComfyPort $config.port
      $script:lastManagedActivity = Get-Date
      Write-JsonResponse `
        -Stream $Stream `
        -StatusCode 200 `
        -StatusText "OK" `
        -Payload (Get-JobPayload -Job $job)
      return
    }

    if ($Request.Method -eq "DELETE") {
      $payload = Get-JobPayload -Job $job

      if ($job.state -in @("succeeded", "failed", "cancelled", "no_face")) {
        Cleanup-ComfyJobFiles -Job $job
        $jobs.Remove($jobId)
      } else {
        Cancel-ComfyJobState -Job $job -ComfyPort $config.port
        $payload = Get-JobPayload -Job $job
      }

      Write-JsonResponse `
        -Stream $Stream `
        -StatusCode 200 `
        -StatusText "OK" `
        -Payload $payload
      return
    }

    Write-ErrorResponse `
      -Stream $Stream `
      -StatusCode 405 `
      -StatusText "Method Not Allowed" `
      -Message "Method not allowed."
    return
  }

  Write-ErrorResponse `
    -Stream $Stream `
    -StatusCode 404 `
    -StatusText "Not Found" `
   -Message "Unknown bridge endpoint."
}

function Handle-OutputApi {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    $Request,
    [string]$Path
  )

  if ($Path -eq "/api/outputs/reveal" -and $Request.Method -eq "POST") {
    $payload = [System.Text.Encoding]::UTF8.GetString($Request.Body) |
      ConvertFrom-Json
    $targetPath = [string]$payload.path

    if ([string]::IsNullOrWhiteSpace($targetPath)) {
      throw "The output path is empty."
    }

    $resolvedPath = [System.IO.Path]::GetFullPath($targetPath)
    $outputPrefix = [System.IO.Path]::GetFullPath(
      $outputDirectory
    ).TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
      [System.IO.Path]::DirectorySeparatorChar

    if (
      -not $resolvedPath.StartsWith(
        $outputPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "The output path is outside the outputs directory."
    }

    if (-not [System.IO.File]::Exists($resolvedPath)) {
      throw "The output file no longer exists."
    }

    Start-Process `
      -FilePath "explorer.exe" `
      -ArgumentList "/select,`"$resolvedPath`""

    Write-JsonResponse `
      -Stream $Stream `
      -StatusCode 200 `
      -StatusText "OK" `
      -Payload ([ordered]@{
        ok = $true
        path = $resolvedPath
      })
    return
  }

  Write-ErrorResponse `
    -Stream $Stream `
    -StatusCode 404 `
    -StatusText "Not Found" `
    -Message "Unknown bridge endpoint."
}

function Get-StaticResponse {
  param(
    [string]$RequestTarget,
    [bool]$HeadOnly
  )

  $requestUri = [System.Uri]::new(
    "http://127.0.0.1:$selectedPort$RequestTarget"
  )
  $relativePath = [System.Uri]::UnescapeDataString(
    $requestUri.AbsolutePath.TrimStart("/")
  )

  if ([string]::IsNullOrWhiteSpace($relativePath)) {
    $relativePath = "index.html"
  }

  $relativePath = $relativePath.Replace(
    "/",
    [System.IO.Path]::DirectorySeparatorChar
  )
  $fullPath = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::Combine($root, $relativePath)
  )
  $rootPrefix = $root.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar
  ) + [System.IO.Path]::DirectorySeparatorChar

  if (
    -not $fullPath.Equals(
      $root,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    -not $fullPath.StartsWith(
      $rootPrefix,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    return [PSCustomObject]@{
      status = 403
      text = "Forbidden"
      contentType = "text/plain; charset=utf-8"
      body = [System.Text.Encoding]::UTF8.GetBytes("Forbidden")
      headOnly = $HeadOnly
    }
  }

  if ([System.IO.Directory]::Exists($fullPath)) {
    $fullPath = [System.IO.Path]::Combine($fullPath, "index.html")
  }

  if (-not [System.IO.File]::Exists($fullPath)) {
    return [PSCustomObject]@{
      status = 404
      text = "Not Found"
      contentType = "text/plain; charset=utf-8"
      body = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
      headOnly = $HeadOnly
    }
  }

  return [PSCustomObject]@{
    status = 200
    text = "OK"
    contentType = Get-ContentType -Path $fullPath
    body = [System.IO.File]::ReadAllBytes($fullPath)
    headOnly = $HeadOnly
  }
}

$url = "http://127.0.0.1:$selectedPort/index.html"
Write-Host ""
Write-Host "ColorAdjustApp is running:"
Write-Host "  $url"
Write-Host ""
Write-Host "Keep this window open. Press Ctrl+C to stop."
Write-Host ""

if (-not $NoBrowser) {
  Start-Process $url
}

try {
  while ($true) {
    $acceptTask = $listener.BeginAcceptTcpClient($null, $null)

    while (-not $acceptTask.AsyncWaitHandle.WaitOne(500)) {
      Stop-IdleManagedComfy
      Cleanup-ExpiredJobs
    }

    $client = $listener.EndAcceptTcpClient($acceptTask)

    try {
      $client.ReceiveTimeout = 180000
      $client.SendTimeout = 180000
      $stream = $client.GetStream()
      $request = Read-HttpRequest -Stream $stream

      if ($null -eq $request) {
        continue
      }

      $requestUri = [System.Uri]::new(
        "http://127.0.0.1:$selectedPort$($request.Target)"
      )
      $path = $requestUri.AbsolutePath

      try {
        if ($path.StartsWith("/api/comfy/")) {
          Handle-ComfyApi `
            -Stream $stream `
            -Request $request `
            -Path $path
          continue
        }

        if ($path.StartsWith("/api/outputs/")) {
          Handle-OutputApi `
            -Stream $stream `
            -Request $request `
            -Path $path
          continue
        }

        if ($request.Method -ne "GET" -and $request.Method -ne "HEAD") {
          Write-ErrorResponse `
            -Stream $stream `
            -StatusCode 405 `
            -StatusText "Method Not Allowed" `
            -Message "Method not allowed."
          continue
        }

        $response = Get-StaticResponse `
          -RequestTarget $request.Target `
          -HeadOnly ($request.Method -eq "HEAD")
        Write-HttpResponse `
          -Stream $stream `
          -StatusCode $response.status `
          -StatusText $response.text `
          -ContentType $response.contentType `
          -Body $response.body `
          -HeadOnly $response.headOnly
      } catch {
        if (
          $path.StartsWith("/api/comfy/") -or
          $path.StartsWith("/api/outputs/")
        ) {
          Write-ErrorResponse `
            -Stream $stream `
            -StatusCode 500 `
            -StatusText "Internal Server Error" `
            -Message $_.Exception.Message
        } else {
          $body = [System.Text.Encoding]::UTF8.GetBytes(
            $_.Exception.Message
          )
          Write-HttpResponse `
            -Stream $stream `
            -StatusCode 500 `
            -StatusText "Internal Server Error" `
            -ContentType "text/plain; charset=utf-8" `
            -Body $body
        }
      }
    } catch {
      Write-Warning $_
    } finally {
      $client.Close()
    }
  }
} finally {
  Stop-ManagedComfyService

  if ($listener) {
    $listener.Stop()
  }

  Write-Host "Server stopped."
}
