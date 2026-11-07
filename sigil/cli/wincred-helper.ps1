[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Read', 'Write', 'Delete')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$Target
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinCredNative {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite([In] ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree([In] IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static bool Write(string target, string secret) {
        byte[] bytes = System.Text.Encoding.Unicode.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = 1; // Generic
            cred.TargetName = target;
            cred.CredentialBlobSize = (uint)bytes.Length;
            cred.CredentialBlob = blob;
            cred.Persist = 2; // Local machine / user session
            cred.UserName = Environment.UserName;
            return CredWrite(ref cred, 0);
        } finally {
            Marshal.FreeHGlobal(blob);
        }
    }

    public static string Read(string target) {
        IntPtr credPtr;
        if (!CredRead(target, 1, 0, out credPtr)) {
            return null;
        }
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
            return System.Text.Encoding.Unicode.GetString(bytes);
        } finally {
            CredFree(credPtr);
        }
    }

    public static bool Delete(string target) {
        return CredDelete(target, 1, 0);
    }
}
"@

if ($Action -eq 'Delete') {
  $ok = [WinCredNative]::Delete($Target)
  if (-not $ok) {
    # If already absent, treat as success or not-found
    exit 0
  }
  exit 0
}

if ($Action -eq 'Read') {
  $val = [WinCredNative]::Read($Target)
  if ($null -eq $val) {
    [Console]::Error.WriteLine("CREDENTIAL_NOT_FOUND")
    exit 2
  }
  [Console]::Out.Write($val)
  exit 0
}

if ($Action -eq 'Write') {
  $secret = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrEmpty($secret)) {
    [Console]::Error.WriteLine("SECRET_EMPTY")
    exit 3
  }
  $ok = [WinCredNative]::Write($Target, $secret)
  if (-not $ok) {
    [Console]::Error.WriteLine("CREDENTIAL_WRITE_FAILED")
    exit 4
  }
  exit 0
}
