$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskBase=Join-Path $taskRoot ('state\hook-init-regression-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskBase -Force|Out-Null
$taskNative=[Security.SecurityElement]::Escape((Join-Path $PSScriptRoot 'native-hook'))
$taskReviewed=[Security.SecurityElement]::Escape((Join-Path $taskRoot 'components\WeChat-Hook'))
$taskProject=@'
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
<ItemGroup Label="ProjectConfigurations"><ProjectConfiguration Include="Release|x64"><Configuration>Release</Configuration><Platform>x64</Platform></ProjectConfiguration></ItemGroup>
<PropertyGroup><Configuration>Release</Configuration><Platform>x64</Platform><WindowsTargetPlatformVersion>10.0</WindowsTargetPlatformVersion></PropertyGroup>
<Import Project="$(VCTargetsPath)\Microsoft.Cpp.Default.props"/>
<PropertyGroup Label="Configuration"><ConfigurationType>Application</ConfigurationType><PlatformToolset>v143</PlatformToolset><CharacterSet>Unicode</CharacterSet></PropertyGroup>
<Import Project="$(VCTargetsPath)\Microsoft.Cpp.props"/>
<PropertyGroup><OutDir>$(ProjectDir)bin\</OutDir><IntDir>$(ProjectDir)obj\</IntDir><TargetName>InitProbe</TargetName></PropertyGroup>
<ItemDefinitionGroup><ClCompile><AdditionalIncludeDirectories>__NATIVE__;__REVIEWED__\include;__REVIEWED__\3rdparty;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories><PreprocessorDefinitions>_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR;%(PreprocessorDefinitions)</PreprocessorDefinitions><LanguageStandard>stdcpp20</LanguageStandard><AdditionalOptions>/utf-8 %(AdditionalOptions)</AdditionalOptions><ExceptionHandling>Async</ExceptionHandling></ClCompile><Link><AdditionalDependencies>ws2_32.lib;%(AdditionalDependencies)</AdditionalDependencies><SubSystem>Console</SubSystem></Link></ItemDefinitionGroup>
<ItemGroup><ClCompile Include="__NATIVE__\init_probe.cpp"/><ClCompile Include="__NATIVE__\deferred_init.cpp"/><ClCompile Include="__NATIVE__\http_server.cpp"/></ItemGroup>
<Import Project="$(VCTargetsPath)\Microsoft.Cpp.targets"/>
</Project>
'@
$taskProject=$taskProject.Replace('__NATIVE__',$taskNative).Replace('__REVIEWED__',$taskReviewed)
$taskFile=Join-Path $taskBase 'probe.vcxproj';[IO.File]::WriteAllText($taskFile,$taskProject,[Text.UTF8Encoding]::new($false))
$taskCore=$taskProject.Replace('<ConfigurationType>Application</ConfigurationType>','<ConfigurationType>DynamicLibrary</ConfigurationType>').Replace('<TargetName>InitProbe</TargetName>','<TargetName>Weixin</TargetName>').Replace('obj\','core-obj\')
$taskCore=[regex]::Replace($taskCore,'<ItemGroup><ClCompile Include="[^\r\n]+?</ItemGroup>','<ItemGroup><ClCompile Include="'+$taskNative+'\init_probe_core.cpp"/></ItemGroup>')
$taskCoreFile=Join-Path $taskBase 'core.vcxproj';[IO.File]::WriteAllText($taskCoreFile,$taskCore,[Text.UTF8Encoding]::new($false))
$taskVsWhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$taskMsBuild=(& $taskVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'MSBuild\**\Bin\MSBuild.exe'|Select-Object -First 1)
foreach($taskTarget in @($taskCoreFile,$taskFile)){& $taskMsBuild $taskTarget /m /v:minimal /nologo;if($LASTEXITCODE -ne 0){throw 'Native initialization test build failed.'}}
$taskConfig=Get-Content -LiteralPath (Join-Path $taskRoot 'config\wechatagent.json') -Raw -Encoding UTF8|ConvertFrom-Json
& $taskConfig.runtime.python (Join-Path $PSScriptRoot 'test-hook-init-native.py') $taskBase
if($LASTEXITCODE -ne 0){throw 'Native initialization regression failed.'}
Write-Output ('Native initialization regression artifacts: '+$taskBase)
