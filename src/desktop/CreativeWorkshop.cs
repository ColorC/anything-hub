using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("创意工坊")]
[assembly: AssemblyDescription("创意工坊本机桌面启动入口")]
[assembly: AssemblyCompany("Anything Hub")]
[assembly: AssemblyProduct("创意工坊")]
[assembly: AssemblyVersion("0.2.0.0")]

public static class WorkshopLauncher
{
    // Windows command line quoting, including backslashes preceding quotes.
    public static string QuoteArgument(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
                result.Append('\\', slashes * 2 + 1).Append('"');
            else
                result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    [STAThread]
    public static int Main()
    {
        string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        string launcher = Path.Combine(root, "src", "launch.ps1");
        string runtime = Path.Combine(root, "runtime");
        string logs = Path.Combine(runtime, "logs");
        string desktopLog = Path.Combine(logs, "desktop-launch.log");
        try
        {
            string configuredRuntime = Environment.GetEnvironmentVariable("HUB_HOME");
            if (!String.IsNullOrWhiteSpace(configuredRuntime))
                runtime = Path.GetFullPath(Path.IsPathRooted(configuredRuntime) ? configuredRuntime : Path.Combine(root, configuredRuntime));
            logs = Path.Combine(runtime, "logs");
            desktopLog = Path.Combine(logs, "desktop-launch.log");
            if (!File.Exists(launcher))
                throw new FileNotFoundException("没有找到启动文件。请完整解压创意工坊便携包后，再双击创意工坊.exe。", launcher);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe");
            if (!File.Exists(powershell))
                throw new FileNotFoundException("没有找到 Windows PowerShell。", powershell);
            Directory.CreateDirectory(logs);
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = powershell;
            start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + QuoteArgument(launcher);
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            start.EnvironmentVariables["HUB_HOME"] = runtime;
            using (Process process = Process.Start(start))
            {
                StringBuilder output = new StringBuilder();
                StringBuilder errors = new StringBuilder();
                object outputGate = new object();
                bool capture = true;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs data)
                {
                    if (data.Data == null) return;
                    lock (outputGate) { if (capture && output.Length < 65536) output.AppendLine(data.Data); }
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs data)
                {
                    if (data.Data == null) return;
                    lock (outputGate) { if (capture && errors.Length < 65536) errors.AppendLine(data.Data); }
                };
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                bool exited = process.WaitForExit(45000);
                int exitCode = exited ? process.ExitCode : -1;
                if (!exited) process.Kill();
                // A browser or server can inherit the pipe. Never wait for pipe EOF.
                Thread.Sleep(500);
                try { process.CancelOutputRead(); } catch (InvalidOperationException) { }
                try { process.CancelErrorRead(); } catch (InvalidOperationException) { }
                string text;
                lock (outputGate)
                {
                    capture = false;
                    text = output.ToString() + Environment.NewLine + errors.ToString();
                }
                File.AppendAllText(desktopLog, DateTime.Now.ToString("s") + Environment.NewLine +
                    "PowerShell exit code: " + exitCode + Environment.NewLine + text + Environment.NewLine, Encoding.UTF8);
                if (!exited)
                    throw new TimeoutException("启动超过等待时间。请查看日志后重试。");
                if (exitCode != 0)
                    throw new InvalidOperationException("启动失败。请确认已完整解压安装包，且本机端口没有被其他程序占用。");
            }
            return 0;
        }
        catch (Exception exception)
        {
            try { Directory.CreateDirectory(logs); File.AppendAllText(desktopLog, exception.ToString() + Environment.NewLine, Encoding.UTF8); }
            catch { }
            MessageBox.Show(exception.Message + Environment.NewLine + Environment.NewLine +
                "启动日志：" + desktopLog + Environment.NewLine +
                "服务日志：" + Path.Combine(logs, "server.err.log"),
                "创意工坊启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
