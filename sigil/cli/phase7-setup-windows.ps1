# Phase 7 owner-run setup: narrow Windows helper for hidden prompts and the
# protected-directory ACL. It holds no business logic.
#
# The operation is chosen by the non-secret -Action argument. No secret ever
# arrives in argv or a -Command string. A prompted value leaves this process
# only on the private stdout pipe, base64-framed, and is never echoed.
# Every result is one framed line: SIGIL-HELPER:OK, SIGIL-HELPER:ERR:<CODE>
# or SIGIL-HELPER:SECRET:<base64>. Nothing else on stdout or stderr is read.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Prompt', 'ProtectDir', 'VerifyAcl')]
  [string]$Action,

  [string]$Path,

  [ValidateSet('Directory', 'File')]
  [string]$Kind = 'Directory'
)

$ErrorActionPreference = 'Stop'
$Frame = 'SIGIL-HELPER:'

function Send-Frame([string]$Body) {
  [Console]::Out.WriteLine($Frame + $Body)
  [Console]::Out.Flush()
}

function Exit-Error([string]$Code) {
  Send-Frame ('ERR:' + $Code)
  exit 1
}

$SystemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$AdminsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# Approved Nov 11: owner, SYSTEM and Administrators only, until the relay
# service account is verified. No Users, Authenticated Users or Everyone.
$AllowedSids = @($CurrentSid.Value, $SystemSid.Value, $AdminsSid.Value)

# File system and ACL work goes through .NET, not cmdlets, so it never depends
# on which module path the process inherited.
function Get-Entry([string]$Target, [string]$EntryKind) {
  if ($EntryKind -eq 'Directory') { $entry = [System.IO.DirectoryInfo]::new($Target) }
  else { $entry = [System.IO.FileInfo]::new($Target) }
  if (-not $entry.Exists) { return $null }
  return $entry
}

function Test-ReparsePoint($Entry) {
  return [bool]($Entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# Windows PowerShell (.NET Framework) has the instance methods; PowerShell 7
# (.NET) has them as System.IO.FileSystemAclExtensions, whose assembly may not
# be loaded yet.
function Get-AclExtensions {
  $ext = 'System.IO.FileSystemAclExtensions' -as [type]
  if ($null -eq $ext) {
    [void][System.Reflection.Assembly]::Load('System.IO.FileSystem.AccessControl')
    $ext = 'System.IO.FileSystemAclExtensions' -as [type]
  }
  if ($null -eq $ext) { Exit-Error 'ACL_API_MISSING' }
  return $ext
}

function Get-EntryAcl($Entry) {
  if ($null -ne $Entry.GetType().GetMethod('GetAccessControl', [Type[]]@())) { return $Entry.GetAccessControl() }
  return (Get-AclExtensions)::GetAccessControl($Entry)
}

function Set-EntryAcl($Entry, $Security) {
  if ($null -ne $Entry.GetType().GetMethod('SetAccessControl', [Type[]]@($Security.GetType()))) { $Entry.SetAccessControl($Security); return }
  (Get-AclExtensions)::SetAccessControl($Entry, $Security)
}

try {
  switch ($Action) {
    'Prompt' {
      # Masked console input. No -Prompt: the parent prints the label itself,
      # because host output may land on the redirected stdout pipe.
      $secure = Read-Host -AsSecureString
      if ($null -eq $secure -or $secure.Length -eq 0) { Exit-Error 'PROMPT_EMPTY' }
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      $bytes = $null
      try {
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
        $plain = $null
        Send-Frame ('SECRET:' + [Convert]::ToBase64String($bytes))
      } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $secure.Dispose()
      }
      exit 0
    }

    'ProtectDir' {
      if (-not $Path) { Exit-Error 'PATH_REQUIRED' }
      $entry = Get-Entry $Path 'Directory'
      if ($null -eq $entry) { Exit-Error 'NOT_A_DIRECTORY' }
      if (Test-ReparsePoint $entry) { Exit-Error 'REPARSE_POINT' }
      $acl = [System.Security.AccessControl.DirectorySecurity]::new()
      $acl.SetAccessRuleProtection($true, $false)
      $acl.SetOwner($CurrentSid)
      $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      $propagate = [System.Security.AccessControl.PropagationFlags]::None
      $full = [System.Security.AccessControl.FileSystemRights]::FullControl
      $allow = [System.Security.AccessControl.AccessControlType]::Allow
      foreach ($sid in @($CurrentSid, $SystemSid, $AdminsSid)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inherit, $propagate, $allow)
        $acl.AddAccessRule($rule)
      }
      Set-EntryAcl $entry $acl
      Send-Frame 'OK'
      exit 0
    }

    'VerifyAcl' {
      if (-not $Path) { Exit-Error 'PATH_REQUIRED' }
      $entry = Get-Entry $Path $Kind
      if ($null -eq $entry) { Exit-Error 'WRONG_KIND' }
      if (Test-ReparsePoint $entry) { Exit-Error 'REPARSE_POINT' }
      $acl = Get-EntryAcl $entry
      $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
      if ($owner.Value -ne $CurrentSid.Value -and $owner.Value -ne $AdminsSid.Value) { Exit-Error 'OWNER' }
      if ($Kind -eq 'Directory' -and -not $acl.AreAccessRulesProtected) { Exit-Error 'INHERITANCE_ENABLED' }
      $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      $ownerHasFull = $false
      $full = [System.Security.AccessControl.FileSystemRights]::FullControl
      foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Value
        if ($AllowedSids -notcontains $sid) { Exit-Error 'BROAD_SID' }
        if ($sid -eq $CurrentSid.Value -and (($rule.FileSystemRights -band $full) -eq $full)) { $ownerHasFull = $true }
      }
      if (-not $ownerHasFull) { Exit-Error 'OWNER_ACCESS' }
      Send-Frame 'OK'
      exit 0
    }
  }
} catch {
  # Never forward exception text: it can echo paths or values.
  Exit-Error 'HELPER_EXCEPTION'
}
