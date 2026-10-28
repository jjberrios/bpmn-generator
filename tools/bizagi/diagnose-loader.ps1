param([Parameter(Mandatory=$true)][string]$Installation, [string]$Mode = 'types', [string]$Pattern = 'Persist|Document|ModelLoader|FileManager')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$base = (Resolve-Path -LiteralPath $Installation).Path
$resolve = [System.ResolveEventHandler] {
  param($sender, $eventArgs)
  $file = Join-Path $base ((New-Object System.Reflection.AssemblyName($eventArgs.Name)).Name + '.dll')
  if (Test-Path -LiteralPath $file) { return [System.Reflection.Assembly]::LoadFrom($file) }
  return $null
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($resolve)
$flags = [System.Reflection.BindingFlags]'Public,NonPublic,Static,Instance,DeclaredOnly'
$assemblies = @('Bizagi.ProcessModeler.BusinessEntities.dll', 'Bizagi.ProcessModeler.Persistence.dll', 'Bizagi.ProcessModeler.BusinessLogic.dll', 'Bizagi.Injection.dll', 'Bizagi.DependencyInjector.dll') | ForEach-Object { [System.Reflection.Assembly]::LoadFrom((Join-Path $base $_)) }
$assemblies += [System.Reflection.Assembly]::LoadFrom((Join-Path $base 'Bizagi.UtilCommon.dll'))
if ($Mode -in @('deserialize', 'load')) {
  $instances = @{}
  $constructing = @{}
  $prefix = 'Bizagi.ProcessModeler.Persistence.Interop.XPDL.BPMNXPDL22Adapters.'
  $allTypes = @($assemblies | ForEach-Object { $_.GetTypes() })
  $injector = $null
  $preRegistered = @{}
  if ($Mode -eq 'load') {
    $injector = [Activator]::CreateInstance($assemblies[4].GetType('Bizagi.DependencyInjector.SimpleInjectorImplementation', $true))
    foreach ($a in $assemblies) { $injector.RegisterDefaultInterfaceImplementations($a, [string[]]@()) }
    $injector.RegisterInstance($assemblies[3].GetType('Bizagi.Injection.IDependencyInjector', $true), $injector)
    $flagType = $assemblies[1].GetType(($prefix + 'Util.XpdlCompliantFlag'), $true)
    $instances[$flagType.FullName] = [Activator]::CreateInstance($flagType, @($false))
    $injector.RegisterInstance($flagType, $instances[$flagType.FullName])
    $locatorType = $assemblies[3].GetType('Bizagi.Injection.ServiceLocator.ServiceLocatorInstance', $true)
    $locator = $locatorType.GetProperty('Instance').GetValue($null)
    $locatorType.GetProperty('Injector').SetValue($locator, $injector)
    $stringInterface = $assemblies[0].GetType('Bizagi.ProcessModeler.BusinessEntities.Interfaces.Util.IStringUtil', $true)
    $injector.RegisterInstance($stringInterface, [Activator]::CreateInstance($assemblies[2].GetType('Bizagi.ProcessModeler.BusinessLogic.Util.StringUtil', $true)))
    # Register factory dependencies before a provider constructor resolves its service locator.
    foreach ($service in ($allTypes | Where-Object { $_.IsInterface -and $_.FullName.StartsWith($prefix) })) {
      $implementations = @($allTypes | Where-Object { !$_.IsAbstract -and $service.IsAssignableFrom($_) })
      if ($implementations.Count -eq 1) {
        $injector.RegisterType($service, $implementations[0])
        $preRegistered[$service.FullName] = $true
      }
    }
  }
  function MakeAdapter([Type]$t) {
    if ($instances.ContainsKey($t.FullName)) { return $instances[$t.FullName] }
    if ($t -eq [bool]) { return $false }
    if ($t.FullName -eq 'Bizagi.Injection.IDependencyInjector') { return $injector }
    if ($t.FullName -eq 'Bizagi.ProcessModeler.BusinessEntities.Common.CustomArtifactTypeCollection') { return ,([Activator]::CreateInstance($t)) }
    if ($t.IsGenericType -and $t.GetGenericTypeDefinition() -eq [System.Collections.Generic.List``1]) { return ,([Activator]::CreateInstance($t)) }
    if ($t.IsInterface) {
      $impl = @($allTypes | Where-Object { !$_.IsAbstract -and $t.IsAssignableFrom($_) })
      if ($impl.Count -ne 1) { throw "Implementación ambigua: $($t.FullName): $($impl.FullName -join ', '); camino: $($constructing.Keys -join ' -> ')" }
      $resolved = MakeAdapter $impl[0]
      if (!$script:registrationLocked -and !$preRegistered[$t.FullName]) { $injector.RegisterInstance($t, $resolved) }
      return ,$resolved
    }
    if ($t.FullName -notmatch '^Bizagi\.ProcessModeler\.(Persistence\.(Interop\.XPDL\.|Util\.|IO\.SerializationUtil$|Providers\.Catalog\.(Processes\.ProcessClassPropertiesUtil$|Runtime\.PropertiesFixer$))|BusinessEntities\.Documentation\.ExtendedAttributesHolder|BusinessLogic\.Runtime\.RuntimePropertiesLocalizationService$)') { throw "Constructor fuera del diagnóstico: $($t.FullName)" }
    if ($constructing[$t.FullName]) { throw "Dependencia circular: $($t.FullName)" }
    $constructing[$t.FullName] = $true
    $ctor = @($t.GetConstructors() | Sort-Object { $_.GetParameters().Count })[0]
    if (!$ctor) { throw "Sin constructor: $($t.FullName)" }
    $args = New-Object 'System.Collections.Generic.List[object]'
    foreach ($p in $ctor.GetParameters()) { $args.Add((MakeAdapter $p.ParameterType)) }
    if ($t.FullName -eq ($prefix + 'ProcessAdapter')) { $script:registrationLocked = $true }
    $obj = $ctor.Invoke($args.ToArray())
    $constructing.Remove($t.FullName)
    $instances[$t.FullName] = $obj
    if (!$script:registrationLocked -and $t.FullName.StartsWith($prefix + 'FlowElements.')) { $injector.RegisterInstance($t, $obj) }
    return ,$obj
  }
  $type = $assemblies[0].GetType('Bizagi.ProcessModeler.BusinessEntities.XPDL22.PackageType', $true)
  $serializer = New-Object System.Xml.Serialization.XmlSerializer($type)
  $items = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $result = @()
  foreach ($item in $items) {
    $unknown = New-Object 'System.Collections.Generic.List[string]'
    $handler = [System.Xml.Serialization.XmlElementEventHandler] { param($s,$e) $unknown.Add($e.Element.LocalName + ':' + $e.LineNumber) }
    $serializer.add_UnknownElement($handler)
    try {
      $settings = New-Object System.Xml.XmlReaderSettings; $settings.DtdProcessing = 'Prohibit'; $settings.XmlResolver = $null
      $reader = [System.Xml.XmlReader]::Create((New-Object System.IO.StringReader($item.xml)), $settings)
      $package = $serializer.Deserialize($reader)
      $report = [ordered]@{ name = $item.name; workflows = @($package.WorkflowProcesses.WorkflowProcess).Count; activities = @($package.WorkflowProcesses.WorkflowProcess | ForEach-Object { $_.Activities.Activity } | Where-Object { $null -ne $_ }).Count; unknown_elements = @($unknown.ToArray()) }
      if ($Mode -eq 'load') {
        $null = MakeAdapter ($assemblies[1].GetType(($prefix + 'FlowElements.FlowNodeAdapter'), $true))
        foreach ($adapterType in ($allTypes | Where-Object { $_.IsPublic -and !$_.IsAbstract -and $_.FullName.StartsWith($prefix + 'FlowElements.') -and $_.GetConstructors().Count -gt 0 })) { $null = MakeAdapter $adapterType }
        $adapter = MakeAdapter ($assemblies[1].GetType(($prefix + 'CollaborationAdapter'), $true))
        $method = $adapter.GetType().GetMethod('Load')
        $args = New-Object 'System.Collections.Generic.List[object]'
        foreach ($p in $method.GetParameters()) {
          if ($p.ParameterType -eq $type) { $args.Add($package) }
          elseif ($p.ParameterType.FullName.StartsWith('System.Collections.Generic.List')) { $args.Add([Activator]::CreateInstance($p.ParameterType)) }
          elseif ($p.ParameterType.FullName -eq ($prefix + 'Util.Resources')) {
            $resourceType = $assemblies[0].GetType('Bizagi.ProcessModeler.BusinessEntities.BPMN20.Resource', $true)
            $listType = [System.Collections.Generic.List``1].MakeGenericType(@($resourceType))
            $resourceArgs = New-Object 'object[]' 1
            $resourceArgs[0] = [Activator]::CreateInstance($listType)
            $args.Add($p.ParameterType.GetConstructors()[0].Invoke($resourceArgs))
          } else { $args.Add((MakeAdapter $p.ParameterType)) }
        }
        $collaboration = $method.Invoke($adapter, $args.ToArray())
        $report.collaboration_loaded = ($null -ne $collaboration)
         $report.participants = @($collaboration.Participants | Where-Object { $null -ne $_ }).Count
         $graphics = @()
         $sourceNodes = @($package.WorkflowProcesses.WorkflowProcess | ForEach-Object { $_.Activities.Activity } | Where-Object { $null -ne $_ })
         foreach ($participant in $collaboration.Participants) {
           if (!$participant.Process) { continue }
           foreach ($element in $participant.Process.GraphicalElements) {
             $source = @($sourceNodes | Where-Object { $_.Id -eq $element.Id.ToString() })
             if ($source.Count -ne 1) { continue }
             $g = $element.GraphicalProperties
               # DisplayName es la etiqueta visible; Name es un identificador interno.
                $f = $g.Formatting
                $graphics += [pscustomobject]@{ id = $element.Id.ToString(); name_preserved = ($element.DisplayName -eq $source[0].Name); type = $element.GetType().FullName; text_x = $g.TextLocation.X; text_y = $g.TextLocation.Y; text_width = $g.TextSize.Width; text_height = $g.TextSize.Height; graphical_properties_present = ($null -ne $g); font_name = $f.FontName; font_size = $f.SizeFont; font_argb = $f.ColorFont.ToArgb(); font_alpha = $f.ColorFont.A; font_rgb = @($f.ColorFont.R, $f.ColorFont.G, $f.ColorFont.B); bold = $f.Bold; fill_argb = $g.BackgroundColor.ToArgb() }
           }
         }
         $report.labels = @($graphics)
      }
      $result += [pscustomobject]$report
    } catch { $result += [pscustomobject]@{ name = $item.name; error = $_.Exception.ToString() } }
    finally { $serializer.remove_UnknownElement($handler); if ($reader) { $reader.Dispose() } }
  }
  ConvertTo-Json -Depth 8 -InputObject @($result)
  exit 0
}
$opcodes = @{}
[System.Reflection.Emit.OpCodes].GetFields([System.Reflection.BindingFlags]'Public,Static') | ForEach-Object { $op = $_.GetValue($null); $opcodes[([int]$op.Value -band 65535)] = $op }
function Instructions($method) {
  try { $body = $method.GetMethodBody() } catch { return }
  if (!$body) { return }
  $bytes = $body.GetILAsByteArray(); $i = 0
  while ($i -lt $bytes.Length) {
    $offset = $i; $value = [int]$bytes[$i++]; if ($value -eq 254) { $value = 65024 + [int]$bytes[$i++] }
    $op = $opcodes[$value]; if (!$op) { throw "Opcode desconocido $value" }
    $operand = ''; $size = 0
    switch ($op.OperandType.ToString()) {
      'InlineNone' { }
      'ShortInlineI' { $operand = [string]$bytes[$i]; $size = 1 }
      'ShortInlineVar' { $operand = [string]$bytes[$i]; $size = 1 }
      'InlineVar' { $operand = [string][BitConverter]::ToUInt16($bytes, $i); $size = 2 }
      'ShortInlineBrTarget' { $operand = [string]($i + 1 + [int][sbyte]::Parse($bytes[$i].ToString('X2'), [Globalization.NumberStyles]::HexNumber)); $size = 1 }
      'InlineBrTarget' { $operand = [string]($i + 4 + [BitConverter]::ToInt32($bytes, $i)); $size = 4 }
      'InlineI' { $operand = [string][BitConverter]::ToInt32($bytes, $i); $size = 4 }
      'InlineI8' { $operand = [string][BitConverter]::ToInt64($bytes, $i); $size = 8 }
      'ShortInlineR' { $operand = [string][BitConverter]::ToSingle($bytes, $i); $size = 4 }
      'InlineR' { $operand = [string][BitConverter]::ToDouble($bytes, $i); $size = 8 }
      'InlineSwitch' { $count = [BitConverter]::ToInt32($bytes, $i); $size = 4 + 4 * $count; $operand = "switch $count" }
      default {
        $token = [BitConverter]::ToInt32($bytes, $i); $size = 4
        try {
          if ($op.OperandType.ToString() -eq 'InlineString') { $operand = '"' + $method.Module.ResolveString($token) + '"' }
          else { $member = $method.Module.ResolveMember($token, $method.DeclaringType.GetGenericArguments(), $method.GetGenericArguments()); $operand = $member.DeclaringType.FullName + '::' + $member.ToString() }
        } catch { $operand = 'token:' + $token }
      }
    }
    $i += $size
    [pscustomobject]@{ offset = $offset; op = $op.Name; operand = $operand }
  }
}
$result = @()
foreach ($assembly in $assemblies) {
  try { $types = $assembly.GetTypes() } catch [System.Reflection.ReflectionTypeLoadException] { $types = $_.Exception.Types | Where-Object { $_ } }
  foreach ($type in $types) {
    if ($Mode -eq 'types' -and $type.FullName -match $Pattern) {
      $result += [pscustomobject]@{ type = $type.FullName; methods = @($type.GetMethods($flags) | ForEach-Object { $_.ToString() }); constructors = @($type.GetConstructors($flags) | ForEach-Object { $_.ToString() }); fields = @($type.GetFields($flags) | ForEach-Object { [pscustomobject]@{ name = $_.Name; attributes = @($_.GetCustomAttributesData() | ForEach-Object { $_.ToString() }) } }) }
    } elseif ($Mode -eq 'il') {
      foreach ($method in $type.GetMethods($flags)) {
        if (($type.FullName + '::' + $method.Name) -match $Pattern) {
          $result += [pscustomobject]@{ method = $type.FullName + '::' + $method.ToString(); instructions = @(Instructions $method) }
        }
      }
    } elseif ($Mode -eq 'find') {
      foreach ($method in $type.GetMethods($flags)) {
        $instructions = @(Instructions $method)
        if ($instructions | Where-Object { $_.operand -match $Pattern }) { $result += [pscustomobject]@{ method = $type.FullName + '::' + $method.ToString(); instructions = $instructions } }
      }
    }
  }
}
ConvertTo-Json -Depth 12 -InputObject @($result)
