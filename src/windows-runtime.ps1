param([ValidateSet('run', 'stop')][string]$Mode, [string]$JobName)
$ErrorActionPreference = 'Stop'
# The supervisor joins its job BEFORE starting the runtime, so every descendant
# inherits containment. No PID-based tree walk, shell command, or breakaway flag.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class WorkNaruJob {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, Reserved2; public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation {
        public IntPtr Process, Thread; public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation result);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    // CommandLineToArgvW / CRT quoting, including trailing backslashes and quotes.
    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            text.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            text.Append(ch); slashes = 0;
        }
        text.Append('\\', slashes * 2); return text.Append('"').ToString();
    }
    static void Child(IntPtr job, Stream input, string executable, string[] arguments, string cwd) {
        var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Inherit = 1 };
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
        IntPtr errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        var process = new ProcessInformation();
        try {
            Check(CreatePipe(out inputRead, out inputWrite, ref security, 0));
            Check(CreatePipe(out outputRead, out outputWrite, ref security, 0));
            Check(CreatePipe(out errorRead, out errorWrite, ref security, 0));
            Check(SetHandleInformation(inputWrite, 1, 0));
            Check(SetHandleInformation(outputRead, 1, 0));
            Check(SetHandleInformation(errorRead, 1, 0));
            var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Flags = 0x100, Input = inputRead, Output = outputWrite, Error = errorWrite };
            var command = new StringBuilder(Quote(executable));
            foreach (var arg in arguments) command.Append(' ').Append(Quote(arg));
            Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out process));
            // Explicit suspended assignment also covers launchers that do not inherit jobs.
            Check(AssignProcessToJobObject(job, process.Process));
            Check(ResumeThread(process.Thread) != uint.MaxValue);
            CloseHandle(inputRead); inputRead = IntPtr.Zero;
            CloseHandle(outputWrite); outputWrite = IntPtr.Zero;
            CloseHandle(errorWrite); errorWrite = IntPtr.Zero;
            using (var writer = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write))
            using (var reader = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read))
            using (var errors = new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read)) {
                inputWrite = outputRead = errorRead = IntPtr.Zero;
                Task incoming = Task.Run(() => {
                    try {
                        var buffer = new byte[8192]; int length;
                        while ((length = input.Read(buffer, 0, buffer.Length)) > 0) {
                            writer.Write(buffer, 0, length); writer.Flush();
                        }
                    } finally { TerminateJobObject(job, 1); }
                });
                Task outgoing = Task.Run(() => reader.CopyTo(Console.OpenStandardOutput()));
                Task diagnostics = Task.Run(() => errors.CopyTo(Stream.Null));
                WaitForSingleObject(process.Process, uint.MaxValue);
                // Root exit must also stop descendants holding pipe handles open.
                TerminateJobObject(job, 1);
            }
        } finally {
            if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 1); CloseHandle(process.Process); }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            foreach (var handle in new[] { inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite })
                if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }

    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    static void Check(bool ok) { if (!ok) throw new IOException("Job operation failed"); }
    static void Validate(string name) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, @"^Local\\WorkNaru-[0-9a-f-]{36}$"))
            throw new IOException("Invalid job identity");
    }
    public static bool Stop(string name) {
        Validate(name);
        IntPtr job = OpenJobObject(0x0004 | 0x0008, false, name); // query + terminate
        if (job == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == 2) return true;
            throw new IOException("Cannot inspect job");
        }
        IntPtr info = Marshal.AllocHGlobal(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        try {
            Check(TerminateJobObject(job, 1));
            for (int n = 0; n < 100; n++) {
                Check(QueryInformationJobObject(job, 1, info, 48, IntPtr.Zero));
                if (Marshal.ReadInt32(info, 40) == 0) return true; // ActiveProcesses
                Thread.Sleep(50);
            }
            return false;
        } finally { Marshal.FreeHGlobal(info); CloseHandle(job); }
    }
    public static void Run(string name, string executable, string[] arguments, string cwd, uint ownerPid) {
        Validate(name);
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new IOException("Cannot create job");
        if (Marshal.GetLastWin32Error() == 183) { CloseHandle(job); throw new IOException("Job already exists"); }
        var limit = new ExtendedLimit();
        limit.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf<ExtendedLimit>();
        IntPtr info = Marshal.AllocHGlobal(size);
        IntPtr owner = IntPtr.Zero;
        try {
            // Capture a process handle BEFORE acknowledging startup. The daemon
            // must still answer through its private pipe, so a reused PID cannot
            // authorize launch. Never terminate the process identified by this PID.
            owner = OpenProcess(0x00100000, false, ownerPid); // SYNCHRONIZE only
            Check(owner != IntPtr.Zero);
            Marshal.StructureToPtr(limit, info, false);
            Check(SetInformationJobObject(job, 9, info, (uint)size));
            Check(AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle));
            // Independent of forwarding: a blocked runtime stdin must not prevent
            // detection of daemon death. This handle continues to identify the
            // original process after its PID is reused.
            var ownerWatcher = new Thread(() => {
                WaitForSingleObject(owner, uint.MaxValue);
                TerminateJobObject(job, 1);
            });
            ownerWatcher.IsBackground = true;
            ownerWatcher.Start();
            // The daemon must acknowledge this marker. If it died before the
            // job existed, EOF prevents a late runtime launch after recovery.
            Console.Error.WriteLine("WORKNARU_JOB_READY");
            Console.Error.Flush();
            Stream input = Console.OpenStandardInput();
            if (input.ReadByte() != 1) return;
            Child(job, input, executable, arguments, cwd);
        } finally {
            Marshal.FreeHGlobal(info);
            // Closing the job terminates this supervisor, including ownerWatcher.
            // Its process handle is released by the OS at the same time.
            CloseHandle(job); // kills the supervisor itself and all remaining descendants
            if (owner != IntPtr.Zero) CloseHandle(owner); // setup failed before joining job
        }
    }
}
'@
try {
    if ($Mode -eq 'stop') {
        if ([WorkNaruJob]::Stop($JobName)) { exit 0 } else { exit 1 }
    }
    $runtimeConfig = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WORKNARU_RUNTIME_CONFIG)) | ConvertFrom-Json
    Remove-Item Env:WORKNARU_RUNTIME_CONFIG
    [WorkNaruJob]::Run($JobName, $runtimeConfig.executable, [string[]]$runtimeConfig.arguments, $runtimeConfig.cwd, [uint32]$runtimeConfig.ownerPid)
} catch {
    [Console]::Error.WriteLine('WORKNARU_JOB_FAILED')
    exit 1
}
