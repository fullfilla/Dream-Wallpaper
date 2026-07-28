using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

[DataContract]
public sealed class EngineState
{
    [DataMember(Name = "id")] public string Id { get; set; }
    [DataMember(Name = "path")] public string MediaPath { get; set; }
    [DataMember(Name = "kind")] public string Kind { get; set; }
    [DataMember(Name = "fit")] public string Fit { get; set; }
    [DataMember(Name = "positionX")] public double PositionX { get; set; }
    [DataMember(Name = "positionY")] public double PositionY { get; set; }
    [DataMember(Name = "muted")] public bool Muted { get; set; }
    [DataMember(Name = "volume")] public double Volume { get; set; }
    [DataMember(Name = "revision")] public string Revision { get; set; }
}

[DataContract]
public sealed class EngineStatus
{
    [DataMember(Name = "pid")] public int Pid { get; set; }
    [DataMember(Name = "updatedAt")] public string UpdatedAt { get; set; }
    [DataMember(Name = "osVersion")] public string OsVersion { get; set; }
    [DataMember(Name = "attached")] public bool Attached { get; set; }
    [DataMember(Name = "mediaLoaded")] public bool MediaLoaded { get; set; }
    [DataMember(Name = "hwnd")] public long Hwnd { get; set; }
    [DataMember(Name = "hostHwnd")] public long HostHwnd { get; set; }
    [DataMember(Name = "hostKind")] public string HostKind { get; set; }
    [DataMember(Name = "mediaPath")] public string MediaPath { get; set; }
    [DataMember(Name = "mediaKind")] public string MediaKind { get; set; }
    [DataMember(Name = "error")] public string Error { get; set; }
    [DataMember(Name = "attachAttempts")] public int AttachAttempts { get; set; }
}

public sealed class WallpaperWindow : Window
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string title);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("kernel32.dll")] private static extern void SetLastError(uint errorCode);
    [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)] private static extern int GetWindowLong32(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)] private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)] private static extern int SetWindowLong32(IntPtr hWnd, int index, int value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)] private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);

    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;
    private const long WsChild = 0x40000000L;
    private const long WsVisible = 0x10000000L;
    private const long WsPopup = unchecked((long)0x80000000L);
    private const long WsCaption = 0x00C00000L;
    private const long WsThickFrame = 0x00040000L;
    private const long WsExTransparent = 0x00000020L;
    private const long WsExToolWindow = 0x00000080L;
    private const long WsExNoActivate = 0x08000000L;
    private const uint SwpShowWindow = 0x0040;
    private const uint SwpFrameChanged = 0x0020;
    private const uint SwpNoActivate = 0x0010;
    private const uint SmtoNormal = 0x0000;
    private const uint SpawnWorkerMessage = 0x052C;
    private static readonly IntPtr HwndBottom = new IntPtr(1);

    private readonly string statePath;
    private readonly string statusPath;
    private readonly Grid root;
    private readonly Image image;
    private readonly MediaElement video;
    private readonly DispatcherTimer pollTimer;
    private readonly DispatcherTimer attachTimer;
    private readonly DispatcherTimer heartbeatTimer;
    private string lastRevision = string.Empty;
    private string currentMediaKey = string.Empty;
    private string currentMediaPath = string.Empty;
    private string currentMediaKind = string.Empty;
    private string attachError = string.Empty;
    private string mediaError = string.Empty;
    private IntPtr handle;
    private IntPtr lastHost = IntPtr.Zero;
    private string lastHostKind = string.Empty;
    private int lastWidth = -1;
    private int lastHeight = -1;
    private int attachAttempts;
    private bool attached;
    private bool mediaLoaded;
    private DateTime lastWorkerRequestUtc = DateTime.MinValue;
    private string lastLoggedAttachError = string.Empty;

    public WallpaperWindow(string stateFile, string statusFile)
    {
        statePath = stateFile;
        statusPath = statusFile;
        Title = "Dream Wallpaper Engine";
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        ShowActivated = false;
        Focusable = false;
        Background = Brushes.Black;
        Left = 0;
        Top = 0;
        Width = Math.Max(1, GetSystemMetrics(0));
        Height = Math.Max(1, GetSystemMetrics(1));

        root = new Grid { Background = Brushes.Black, ClipToBounds = true };
        image = new Image { Stretch = Stretch.UniformToFill, Visibility = Visibility.Collapsed, IsHitTestVisible = false };
        video = new MediaElement
        {
            Stretch = Stretch.UniformToFill,
            Visibility = Visibility.Collapsed,
            LoadedBehavior = MediaState.Manual,
            UnloadedBehavior = MediaState.Manual,
            ScrubbingEnabled = false,
            IsHitTestVisible = false
        };
        video.MediaEnded += delegate { try { video.Position = TimeSpan.Zero; video.Play(); } catch { } };
        video.MediaOpened += delegate
        {
            mediaLoaded = true;
            mediaError = string.Empty;
            try { video.Play(); } catch { }
            WriteStatus();
            Log("video opened " + currentMediaPath);
        };
        video.MediaFailed += delegate(object sender, ExceptionRoutedEventArgs args)
        {
            mediaLoaded = false;
            mediaError = "视频无法解码或播放：" + (args.ErrorException == null ? "未知错误" : args.ErrorException.Message);
            WriteStatus();
            Log("video failed: " + mediaError);
        };
        root.Children.Add(image);
        root.Children.Add(video);
        Content = root;

        SourceInitialized += delegate
        {
            handle = new WindowInteropHelper(this).Handle;
            Dispatcher.BeginInvoke(new Action(delegate
            {
                AttachToDesktop(true);
                LoadState(true);
                WriteStatus();
            }), DispatcherPriority.Background);
        };

        pollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        pollTimer.Tick += delegate { LoadState(false); };
        pollTimer.Start();

        attachTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        attachTimer.Tick += delegate { AttachToDesktop(false); };
        attachTimer.Start();

        heartbeatTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        heartbeatTimer.Tick += delegate { WriteStatus(); };
        heartbeatTimer.Start();

        Closed += delegate
        {
            attached = false;
            WriteStatus();
        };
    }

    private static long GetLong(IntPtr hWnd, int index)
    {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, index).ToInt64() : GetWindowLong32(hWnd, index);
    }

    private static void SetLong(IntPtr hWnd, int index, long value)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, index, new IntPtr(value));
        else SetWindowLong32(hWnd, index, unchecked((int)value));
    }

    private static string WindowClass(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return string.Empty;
        StringBuilder builder = new StringBuilder(256);
        return GetClassName(hWnd, builder, builder.Capacity) > 0 ? builder.ToString() : string.Empty;
    }

    private void RequestWallpaperWorker(IntPtr progman)
    {
        if (progman == IntPtr.Zero) return;
        if (DateTime.UtcNow - lastWorkerRequestUtc < TimeSpan.FromSeconds(10)) return;
        lastWorkerRequestUtc = DateTime.UtcNow;
        IntPtr result;
        SendMessageTimeout(progman, SpawnWorkerMessage, new IntPtr(0xD), new IntPtr(0x1), SmtoNormal, 1000, out result);
        SendMessageTimeout(progman, SpawnWorkerMessage, IntPtr.Zero, IntPtr.Zero, SmtoNormal, 1000, out result);
    }

    private void LocateDesktopHosts(out IntPtr[] hosts, out string[] hostKinds)
    {
        List<IntPtr> foundHosts = new List<IntPtr>();
        List<string> foundKinds = new List<string>();
        IntPtr progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero)
        {
            hosts = foundHosts.ToArray();
            hostKinds = foundKinds.ToArray();
            return;
        }
        RequestWallpaperWorker(progman);

        IntPtr classicWorker = IntPtr.Zero;
        IntPtr iconHost = IntPtr.Zero;
        IntPtr firstWorker = IntPtr.Zero;
        EnumWindows(delegate(IntPtr top, IntPtr ignored)
        {
            string className = WindowClass(top);
            if (firstWorker == IntPtr.Zero && string.Equals(className, "WorkerW", StringComparison.Ordinal)) firstWorker = top;
            IntPtr shell = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (shell != IntPtr.Zero)
            {
                iconHost = top;
                IntPtr nextWorker = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
                if (nextWorker != IntPtr.Zero) classicWorker = nextWorker;
            }
            return true;
        }, IntPtr.Zero);

        AddDesktopHost(foundHosts, foundKinds, classicWorker, "WorkerW-classic");
        AddDesktopHost(foundHosts, foundKinds, iconHost, WindowClass(iconHost) + "-icons");
        AddDesktopHost(foundHosts, foundKinds, firstWorker, "WorkerW-fallback");
        AddDesktopHost(foundHosts, foundKinds, progman, "Progman-fallback");
        hosts = foundHosts.ToArray();
        hostKinds = foundKinds.ToArray();
    }

    private static void AddDesktopHost(List<IntPtr> hosts, List<string> kinds, IntPtr host, string kind)
    {
        if (host == IntPtr.Zero || !IsWindow(host) || hosts.Contains(host)) return;
        hosts.Add(host);
        kinds.Add(string.IsNullOrWhiteSpace(kind) ? "unknown" : kind);
    }

    private void SetAttachFailure(string message)
    {
        attached = false;
        attachError = message;
        if (!string.Equals(lastLoggedAttachError, message, StringComparison.Ordinal))
        {
            lastLoggedAttachError = message;
            Log("attach failed: " + message);
        }
        WriteStatus();
    }

    private void AttachToDesktop(bool force)
    {
        attachAttempts += 1;
        try
        {
            if (handle == IntPtr.Zero || !IsWindow(handle))
            {
                SetAttachFailure("\u58c1\u7eb8\u7a97\u53e3\u5c1a\u672a\u521b\u5efa");
                return;
            }

            IntPtr[] hosts;
            string[] hostKinds;
            LocateDesktopHosts(out hosts, out hostKinds);
            if (hosts.Length == 0)
            {
                SetAttachFailure("Windows Explorer \u684c\u9762\u5c1a\u672a\u51c6\u5907\u597d\uff0c\u6b63\u5728\u81ea\u52a8\u91cd\u8bd5");
                return;
            }

            int width = Math.Max(1, GetSystemMetrics(0));
            int height = Math.Max(1, GetSystemMetrics(1));
            IntPtr actualParent = GetParent(handle);
            bool currentHostHealthy = lastHost != IntPtr.Zero && IsWindow(lastHost) && actualParent == lastHost && attached;
            bool boundsChanged = width != lastWidth || height != lastHeight;
            if (!force && currentHostHealthy && !boundsChanged) return;

            // Convert the WPF top-level window into a child before reparenting. Some Windows 11
            // Explorer builds reject SetParent when WS_POPUP is still present.
            long style = GetLong(handle, GwlStyle);
            style &= ~(WsPopup | WsCaption | WsThickFrame);
            style |= WsChild | WsVisible;
            SetLong(handle, GwlStyle, style);
            long exStyle = GetLong(handle, GwlExStyle) | WsExTransparent | WsExToolWindow | WsExNoActivate;
            SetLong(handle, GwlExStyle, exStyle);

            IntPtr selectedHost = IntPtr.Zero;
            string selectedKind = string.Empty;
            StringBuilder failures = new StringBuilder();
            for (int index = 0; index < hosts.Length; index++)
            {
                IntPtr candidate = hosts[index];
                string candidateKind = hostKinds[index];
                if (!IsWindow(candidate)) continue;

                SetLastError(0);
                IntPtr previousParent = SetParent(handle, candidate);
                int parentError = Marshal.GetLastWin32Error();
                actualParent = GetParent(handle);
                if (actualParent == candidate)
                {
                    selectedHost = candidate;
                    selectedKind = candidateKind;
                    break;
                }

                if (failures.Length > 0) failures.Append("?");
                failures.Append(candidateKind)
                    .Append(" host=").Append(candidate.ToInt64())
                    .Append(" actual=").Append(actualParent.ToInt64())
                    .Append(" previous=").Append(previousParent.ToInt64())
                    .Append(" error=").Append(parentError);
            }

            if (selectedHost == IntPtr.Zero)
            {
                SetAttachFailure("\u65e0\u6cd5\u6302\u8f7d\u5230 Windows \u684c\u9762\u5c42\uff08" + failures.ToString() + "\uff09");
                return;
            }

            if (!SetWindowPos(handle, HwndBottom, 0, 0, width, height, SwpShowWindow | SwpFrameChanged | SwpNoActivate))
            {
                SetAttachFailure("\u58c1\u7eb8\u7a97\u53e3\u5b9a\u4f4d\u5931\u8d25\uff08\u9519\u8bef " + Marshal.GetLastWin32Error() + "\uff0c\u76ee\u6807 " + selectedKind + "\uff09");
                return;
            }

            attached = true;
            attachError = string.Empty;
            lastLoggedAttachError = string.Empty;
            lastHost = selectedHost;
            lastHostKind = selectedKind;
            lastWidth = width;
            lastHeight = height;
            Log("attached hwnd=" + handle + " host=" + selectedHost + " kind=" + selectedKind + " size=" + width + "x" + height);
            WriteStatus();
        }
        catch (Exception error)
        {
            SetAttachFailure("\u6302\u8f7d\u58c1\u7eb8\u7a97\u53e3\u65f6\u53d1\u751f\u5f02\u5e38\uff1a" + error.Message);
            Log("attach exception: " + error);
        }
    }

    private void LoadState(bool force)
    {
        try
        {
            if (!File.Exists(statePath))
            {
                mediaLoaded = false;
                mediaError = "壁纸状态文件不存在";
                WriteStatus();
                return;
            }

            EngineState next;
            using (FileStream stream = new FileStream(statePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                next = (EngineState)new DataContractJsonSerializer(typeof(EngineState)).ReadObject(stream);
            }
            string revision = next == null ? string.Empty : (next.Revision ?? string.Empty);
            if (!force && revision.Length > 0 && string.Equals(revision, lastRevision, StringComparison.Ordinal)) return;
            ApplyState(next);
            lastRevision = revision;
        }
        catch (Exception error)
        {
            mediaLoaded = false;
            mediaError = "读取或应用壁纸失败：" + error.Message;
            WriteStatus();
            Log("state error: " + error);
        }
    }

    private void ApplyState(EngineState next)
    {
        if (next == null || string.IsNullOrWhiteSpace(next.MediaPath))
        {
            mediaLoaded = false;
            mediaError = "尚未选择壁纸";
            WriteStatus();
            return;
        }
        if (!File.Exists(next.MediaPath))
        {
            mediaLoaded = false;
            mediaError = "壁纸文件不存在：" + next.MediaPath;
            WriteStatus();
            return;
        }

        Stretch stretch = next.Fit == "contain" ? Stretch.Uniform : next.Fit == "fill" ? Stretch.Fill : Stretch.UniformToFill;
        HorizontalAlignment horizontal = next.PositionX < 34 ? HorizontalAlignment.Left : next.PositionX > 66 ? HorizontalAlignment.Right : HorizontalAlignment.Center;
        VerticalAlignment vertical = next.PositionY < 34 ? VerticalAlignment.Top : next.PositionY > 66 ? VerticalAlignment.Bottom : VerticalAlignment.Center;
        string key = (next.Kind ?? "image") + "|" + next.MediaPath;
        currentMediaPath = next.MediaPath;
        currentMediaKind = next.Kind ?? "image";
        mediaError = string.Empty;

        if (string.Equals(next.Kind, "video", StringComparison.OrdinalIgnoreCase))
        {
            image.Visibility = Visibility.Collapsed;
            image.Source = null;
            video.Visibility = Visibility.Visible;
            video.Stretch = stretch;
            video.HorizontalAlignment = horizontal;
            video.VerticalAlignment = vertical;
            video.IsMuted = next.Muted;
            video.Volume = Math.Max(0, Math.Min(1, next.Volume));
            if (!string.Equals(key, currentMediaKey, StringComparison.Ordinal))
            {
                mediaLoaded = false;
                video.Stop();
                video.Source = new Uri(next.MediaPath, UriKind.Absolute);
                currentMediaKey = key;
            }
            video.Play();
        }
        else
        {
            video.Stop();
            video.Source = null;
            video.Visibility = Visibility.Collapsed;
            image.Visibility = Visibility.Visible;
            image.Stretch = stretch;
            image.HorizontalAlignment = horizontal;
            image.VerticalAlignment = vertical;
            if (!string.Equals(key, currentMediaKey, StringComparison.Ordinal))
            {
                BitmapImage bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bitmap.UriSource = new Uri(next.MediaPath, UriKind.Absolute);
                bitmap.EndInit();
                bitmap.Freeze();
                image.Source = bitmap;
                currentMediaKey = key;
            }
            mediaLoaded = image.Source != null;
        }
        WriteStatus();
        Log("applied " + next.Id + " " + next.Kind + " path=" + next.MediaPath);
    }

    private string CurrentError()
    {
        if (!string.IsNullOrWhiteSpace(attachError)) return attachError;
        if (!string.IsNullOrWhiteSpace(mediaError)) return mediaError;
        return string.Empty;
    }

    private void WriteStatus()
    {
        if (string.IsNullOrWhiteSpace(statusPath)) return;
        try
        {
            EngineStatus status = new EngineStatus
            {
                Pid = System.Diagnostics.Process.GetCurrentProcess().Id,
                UpdatedAt = DateTime.UtcNow.ToString("o"),
                OsVersion = Environment.OSVersion.VersionString,
                Attached = attached && handle != IntPtr.Zero && lastHost != IntPtr.Zero && IsWindow(lastHost) && GetParent(handle) == lastHost,
                MediaLoaded = mediaLoaded,
                Hwnd = handle.ToInt64(),
                HostHwnd = lastHost.ToInt64(),
                HostKind = lastHostKind,
                MediaPath = currentMediaPath,
                MediaKind = currentMediaKind,
                Error = CurrentError(),
                AttachAttempts = attachAttempts
            };
            string directory = Path.GetDirectoryName(statusPath);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            string temp = statusPath + "." + status.Pid + ".tmp";
            using (FileStream stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.Read))
            {
                new DataContractJsonSerializer(typeof(EngineStatus)).WriteObject(stream, status);
            }
            if (File.Exists(statusPath)) File.Replace(temp, statusPath, null, true);
            else File.Move(temp, statusPath);
        }
        catch { }
    }

    private static void Log(string message)
    {
        try
        {
            string rootPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DreamWallpaper");
            Directory.CreateDirectory(rootPath);
            File.AppendAllText(Path.Combine(rootPath, "engine.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff ") + message + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }
}

public static class WallpaperEngine
{
    [STAThread]
    public static int Main(string[] args)
    {
        string statePath = null;
        string statusPath = null;
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--state") statePath = args[i + 1];
            if (args[i] == "--status") statusPath = args[i + 1];
        }
        if (string.IsNullOrWhiteSpace(statePath)) return 2;
        if (string.IsNullOrWhiteSpace(statusPath)) statusPath = Path.Combine(Path.GetDirectoryName(statePath) ?? Path.GetTempPath(), "engine-status.json");
        try
        {
            try { SetProcessDpiAwareness(); } catch { }
            bool createdNew;
            using (Mutex mutex = new Mutex(true, @"Local\DreamWallpaper.WallpaperEngine.v1", out createdNew))
            {
                if (!createdNew) return 10;
                Application app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                WallpaperWindow window = new WallpaperWindow(statePath, statusPath);
                app.Run(window);
                GC.KeepAlive(mutex);
                return 0;
            }
        }
        catch (Exception error)
        {
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "DreamWallpaperEngine-fatal.log"), error.ToString(), Encoding.UTF8); } catch { }
            return 1;
        }
    }

    private static void SetProcessDpiAwareness()
    {
        try { NativeSetProcessDPIAware(); } catch { }
    }

    [DllImport("user32.dll", EntryPoint = "SetProcessDPIAware")] private static extern bool NativeSetProcessDPIAware();
}
