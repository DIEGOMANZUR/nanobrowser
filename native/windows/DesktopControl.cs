using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

internal sealed class DesktopControl : IDisposable
{
    private static readonly Regex SensitiveApp = new Regex(
        @"^(chrome|msedge|firefox|brave|opera|vivaldi|chromium|chatgpt|codex|cmd|powershell|pwsh|windowsterminal|openconsole|conhost|wsl|bash|mintty|regedit|taskmgr|credentialui.*|consent|logonui|lockapp|systemsettings|securityhealth.*|keepass.*|1password.*|bitwarden.*|mstsc|anydesk|teamviewer)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Destructive = new Regex(
        @"\b(delete|remove|erase|purge|discard|overwrite|empty recycle bin|borrar|eliminar|papelera|descartar|sobrescribir|reemplazar)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        { "Tab", 0x09 }, { "Enter", 0x0D }, { "Escape", 0x1B }, { "PageUp", 0x21 }, { "PageDown", 0x22 },
        { "End", 0x23 }, { "Home", 0x24 }, { "ArrowLeft", 0x25 }, { "ArrowUp", 0x26 }, { "ArrowRight", 0x27 }, { "ArrowDown", 0x28 },
    };
    private readonly Dictionary<string, Window> windows = new Dictionary<string, Window>();
    private Capture observed;

    [StructLayout(LayoutKind.Sequential)] private struct Point { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct GuiInfo {
        internal int Size, Flags; internal IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; internal Rect CaretRect;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Input { internal uint Type; internal InputData Data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputData {
        [FieldOffset(0)] internal Mouse Mouse;
        [FieldOffset(0)] internal Key Key;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Mouse {
        internal int X, Y, Data; internal uint Flags, Time; internal UIntPtr ExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Key {
        internal ushort Virtual, Scan; internal uint Flags, Time; internal UIntPtr ExtraInfo;
    }

    private delegate bool EnumerateWindow(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumerateWindow callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr drawing, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint threadId, ref GuiInfo info);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] input, int size);

    private sealed class Window { internal IntPtr Handle; internal uint ProcessId; internal long StartedAt; internal string App, Title; }
    private sealed class Capture : IDisposable {
        internal string Id; internal Window Window; internal Rectangle Bounds; internal IntPtr FocusHandle;
        internal int[] FocusRuntimeId;
        internal int Width, Height; internal Bitmap Bitmap; internal DateTime At;
        public void Dispose() { Bitmap.Dispose(); }
    }

    internal static void SetDpiAwareness()
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
    }

    private static Window Inspect(IntPtr handle)
    {
        if (handle == IntPtr.Zero || !IsWindowVisible(handle)) return null;
        var title = new StringBuilder(260);
        if (GetWindowText(handle, title, title.Capacity) == 0) return null;
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        try
        {
            using (var process = Process.GetProcessById((int)processId))
            {
                if (SensitiveApp.IsMatch(process.ProcessName)) return null;
                return new Window {
                    Handle = handle, ProcessId = processId, StartedAt = process.StartTime.ToUniversalTime().Ticks,
                    App = process.ProcessName, Title = title.ToString(),
                };
            }
        }
        catch (System.ComponentModel.Win32Exception) { return null; }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    internal object List()
    {
        Dispose();
        var previous = windows.ToArray();
        windows.Clear();
        var list = new List<object>();
        EnumWindows((handle, _) => {
            if (GetWindow(handle, 4) != IntPtr.Zero) return true; // Child dialogs are observed through their parent.
            var window = Inspect(handle);
            if (window == null) return true;
            var id = previous.FirstOrDefault(item => item.Value.Handle == window.Handle && item.Value.ProcessId == window.ProcessId && item.Value.StartedAt == window.StartedAt).Key ?? Guid.NewGuid().ToString("N");
            windows[id] = window;
            list.Add(new { id, app = window.App, title = window.Title, foreground = handle == GetForegroundWindow() });
            return list.Count < 25;
        }, IntPtr.Zero);
        return new { windows = list };
    }

    private static Window Validate(Window prior)
    {
        var current = Inspect(prior.Handle);
        if (current == null || current.ProcessId != prior.ProcessId || current.StartedAt != prior.StartedAt || current.Title != prior.Title)
            throw new InvalidOperationException("The Windows target changed. List the windows and select it again.");
        return current;
    }

    private static void Foreground(Window window)
    {
        Validate(window);
        if (GetForegroundWindow() != window.Handle)
        {
            if (IsIconic(window.Handle)) ShowWindowAsync(window.Handle, 9);
            SetForegroundWindow(window.Handle);
            for (var attempt = 0; attempt < 85 && GetForegroundWindow() != window.Handle; attempt++) Thread.Sleep(100);
        }
        if (GetForegroundWindow() != window.Handle)
            throw new InvalidOperationException("Bring the approved window to the foreground and take a fresh capture.");
        Validate(window);
    }

    private static Rectangle Bounds(Window window)
    {
        Rect rect;
        var point = new Point();
        if (!GetClientRect(window.Handle, out rect) || !ClientToScreen(window.Handle, ref point))
            throw new InvalidOperationException("The window client area is unavailable.");
        var bounds = new Rectangle(point.X, point.Y, rect.Right, rect.Bottom);
        if (bounds.Width <= 0 || bounds.Height <= 0 || (long)bounds.Width * bounds.Height > 24 * 1024 * 1024 || !Screen.AllScreens.Any(display => display.Bounds.Contains(bounds)))
            throw new InvalidOperationException("Move this window fully onto one monitor before capturing it.");
        return bounds;
    }

    private static bool IsTarget(Window window, Point point)
    {
        return GetAncestor(WindowFromPoint(point), 2) == window.Handle;
    }

    private static IntPtr FocusOf(Window window)
    {
        var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
        uint process;
        return GetGUIThreadInfo(GetWindowThreadProcessId(window.Handle, out process), ref info) ? info.Focus : IntPtr.Zero;
    }

    private static void CheckOverlays(Window target, Rectangle bounds)
    {
        var visited = 0;
        for (var other = GetTopWindow(IntPtr.Zero); other != IntPtr.Zero; other = GetWindow(other, 2))
        {
            if (other == target.Handle) return;
            if (++visited > 512) break;
            if (!IsWindowVisible(other) || IsIconic(other)) continue;
            int cloaked;
            if (DwmGetWindowAttribute(other, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) continue;
            Rect rect;
            if (GetWindowRect(other, out rect) && Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom).IntersectsWith(bounds))
                throw new InvalidOperationException("Another window overlaps the selected app. Uncover it before capturing.");
        }
        throw new InvalidOperationException("Windows could not verify that this app is uncovered.");
    }

    private static Bitmap WindowImage(Window window, Rectangle bounds)
    {
        // Prefer rendering the selected window itself. The image then excludes overlay windows.
        var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
        var rendered = false;
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var context = graphics.GetHdc();
            try { rendered = PrintWindow(window.Handle, context, 3); }
            finally { graphics.ReleaseHdc(context); }
        }
        if (rendered)
        {
            var first = bitmap.GetPixel(0, 0);
            for (var y = 0; y < bounds.Height; y += Math.Max(1, bounds.Height / 12))
                for (var x = 0; x < bounds.Width; x += Math.Max(1, bounds.Width / 12))
                    if (bitmap.GetPixel(x, y) != first) return bitmap;
        }
        bitmap.Dispose();
        return ReadPixels(window, bounds, bounds);
    }

    internal object Snapshot(string id)
    {
        Window window;
        if (!windows.TryGetValue(id, out window)) throw new ArgumentException("Choose an application from the latest Windows list.");
        Dispose();
        Foreground(window);
        var bounds = Bounds(window);
        var points = new[] { new Point { X = bounds.Left + 4, Y = bounds.Top + 4 },
            new Point { X = bounds.Right - 5, Y = bounds.Bottom - 5 },
            new Point { X = bounds.Left + bounds.Width / 2, Y = bounds.Top + bounds.Height / 2 } };
        if (points.Any(point => !IsTarget(window, point)))
            throw new InvalidOperationException("Another window covers the target. Uncover it before taking a capture.");
        var raw = WindowImage(window, bounds);
        observed = new Capture { Id = Guid.NewGuid().ToString("N"), Window = window, Bounds = bounds, Bitmap = raw,
            FocusHandle = FocusOf(window), At = DateTime.UtcNow };
        try
        {
            var focus = AutomationElement.FocusedElement;
            if (focus != null) observed.FocusRuntimeId = focus.GetRuntimeId();
            var codec = ImageCodecInfo.GetImageEncoders().First(info => info.FormatID == ImageFormat.Jpeg.Guid);
            foreach (var limit in new[] { 1600, 1200, 900 })
            {
                var scale = Math.Min(1.0, (double)limit / Math.Max(bounds.Width, bounds.Height));
                observed.Width = Math.Max(1, (int)Math.Round(bounds.Width * scale));
                observed.Height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
                using (var image = new Bitmap(observed.Width, observed.Height))
                using (var graphics = Graphics.FromImage(image))
                using (var encoded = new MemoryStream())
                using (var settings = new EncoderParameters(1))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.DrawImage(raw, 0, 0, image.Width, image.Height);
                    settings.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                    image.Save(encoded, codec, settings);
                    if (encoded.Length <= 680000)
                        return new { snapshotId = observed.Id, title = window.Title, width = image.Width, height = image.Height,
                            data = Convert.ToBase64String(encoded.ToArray()) };
                }
            }
            throw new IOException("This screenshot is too large.");
        }
        catch { Dispose(); throw; }
    }

    private static void CheckControl(AutomationElement element, bool typing)
    {
        if (element == null || element.Current.IsPassword || !element.Current.IsEnabled || Destructive.IsMatch(element.Current.Name ?? ""))
            throw new InvalidOperationException("This control is protected, disabled, or destructive.");
        var ancestor = element;
        for (var depth = 0; depth < 4 && ancestor != null; depth++)
        {
            if (ancestor.Current.ControlType == ControlType.Window) break;
            ancestor = TreeWalker.ControlViewWalker.GetParent(ancestor);
            if (ancestor != null && (ancestor.Current.IsPassword || Destructive.IsMatch(ancestor.Current.Name ?? "")))
                throw new InvalidOperationException("This control belongs to a protected or destructive action.");
        }
        if (!typing) return;
        var type = element.Current.ControlType;
        if (type != ControlType.Edit && type != ControlType.Document)
            throw new InvalidOperationException("Focus an editable text field in the approved window first.");
        object pattern;
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
        {
            if (((TextPattern)pattern).GetSelection().Any(range => range.GetText(1).Length > 0))
                throw new InvalidOperationException("Deselect existing text before inserting new text.");
        }
        else if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            var value = (ValuePattern)pattern;
            if (value.Current.IsReadOnly || !String.IsNullOrEmpty(value.Current.Value))
                throw new InvalidOperationException("Use an empty editable field or place the caret in an editor that exposes its selection.");
        }
        else throw new InvalidOperationException("Windows could not verify that inserting text would preserve existing content.");
    }

    private static Point Pixel(Capture capture, int x, int y)
    {
        if (x < 0 || y < 0 || x >= capture.Width || y >= capture.Height)
            throw new ArgumentException("Point outside the latest screenshot.");
        return new Point { X = capture.Bounds.Left + (int)((long)x * capture.Bounds.Width / capture.Width),
            Y = capture.Bounds.Top + (int)((long)y * capture.Bounds.Height / capture.Height) };
    }

    private static void CheckVisualTarget(Capture capture, Point point)
    {
        if (!IsTarget(capture.Window, point)) throw new InvalidOperationException("A different window is at that point.");
        var localX = point.X - capture.Bounds.Left;
        var localY = point.Y - capture.Bounds.Top;
        var x = Math.Max(0, localX - 16);
        var y = Math.Max(0, localY - 12);
        var width = Math.Min(33, capture.Bounds.Width - x);
        var height = Math.Min(25, capture.Bounds.Height - y);
        using (var current = WindowImage(capture.Window, capture.Bounds))
        {
            var changed = 0;
            for (var row = 0; row < height; row++) for (var column = 0; column < width; column++)
            {
                var before = capture.Bitmap.GetPixel(x + column, y + row);
                var now = current.GetPixel(x + column, y + row);
                if (Math.Abs(before.R - now.R) + Math.Abs(before.G - now.G) + Math.Abs(before.B - now.B) > 32) changed++;
            }
            if (changed > Math.Max(10, width * height / 8))
                throw new InvalidOperationException("The visual target changed. Take a new screenshot before trying again.");
        }
    }

    private static Bitmap ReadPixels(Window window, Rectangle region, Rectangle full)
    {
        var bitmap = new Bitmap(region.Width, region.Height, PixelFormat.Format24bppRgb);
        try
        {
            if (GetForegroundWindow() != window.Handle) throw new InvalidOperationException("The approved window lost focus.");
            CheckOverlays(window, region);
            using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(region.Left, region.Top, 0, 0, region.Size);
            if (GetForegroundWindow() != window.Handle || Bounds(window) != full) throw new InvalidOperationException("The window moved or lost focus.");
            CheckOverlays(window, region);
            return bitmap;
        }
        catch { bitmap.Dispose(); throw; }
    }

    internal object Act(string id, string action, int x, int y, int scroll, string text, string key)
    {
        var capture = observed;
        observed = null; // Every input consumes its screenshot, including refused input.
        if (capture == null) throw new InvalidOperationException("Take a fresh screenshot first.");
        using (capture)
        {
            if (capture.Id != id || (DateTime.UtcNow - capture.At).TotalSeconds > 120)
                throw new InvalidOperationException("The screenshot expired. Take a fresh screenshot and request approval again.");
            var window = capture.Window;
            Foreground(window);
            if (Bounds(window) != capture.Bounds) throw new InvalidOperationException("The approved window moved. Take a new screenshot.");
            if (new[] { 0x01, 0x02, 0x10, 0x11, 0x12, 0x5B, 0x5C }.Any(code => (GetAsyncKeyState(code) & 0x8000) != 0))
                throw new InvalidOperationException("Release pressed mouse buttons and modifier keys first.");
            Input[] events;
            if (action == "click" || action == "scroll")
            {
                var pixel = Pixel(capture, x, y);
                CheckVisualTarget(capture, pixel);
                if (action == "click") CheckControl(AutomationElement.FromPoint(new System.Windows.Point(pixel.X, pixel.Y)), false);
                if (!SetCursorPos(pixel.X, pixel.Y) || !IsTarget(window, pixel)) throw new InvalidOperationException("The pointer target changed.");
                if (action == "click") events = new[] { MouseEvent(0x0002), MouseEvent(0x0004) };
                else if (scroll >= -6 && scroll <= 6 && scroll != 0) events = new[] { MouseEvent(0x0800, scroll * 120) };
                else throw new ArgumentException("Scroll must be between -6 and 6 steps.");
            }
            else if (action == "key" || action == "type")
            {
                var focus = FocusOf(window);
                if (focus == IntPtr.Zero || focus != capture.FocusHandle) throw new InvalidOperationException("The focused control changed.");
                var control = AutomationElement.FocusedElement;
                CheckControl(control, action == "type");
                if (capture.FocusRuntimeId == null || !control.GetRuntimeId().SequenceEqual(capture.FocusRuntimeId))
                    throw new InvalidOperationException("The focused control changed.");
                if (control.Current.ProcessId != (int)window.ProcessId) throw new InvalidOperationException("The focused control belongs to another application.");
                if (action == "type")
                {
                    if (String.IsNullOrEmpty(text) || text.Length > 2000 || text.Any(Char.IsControl))
                        throw new ArgumentException("Insert at most 2,000 characters of text on one line.");
                    events = text.SelectMany(character => new[] { KeyEvent(0, character, 4), KeyEvent(0, character, 6) }).ToArray();
                }
                else
                {
                    ushort code;
                    if (!Keys.TryGetValue(key, out code)) throw new ArgumentException("Choose a supported navigation key.");
                    var flags = code >= 0x21 && code <= 0x28 ? 1U : 0U;
                    events = new[] { KeyEvent(code, 0, flags), KeyEvent(code, 0, flags | 2) };
                }
            }
            else throw new ArgumentException("Unknown desktop operation.");
            if (GetForegroundWindow() != window.Handle) throw new InvalidOperationException("The approved window lost focus.");
            var sent = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input)));
            // A verified input can change the document title. Update only the identity of that same window.
            if (sent > 0)
            {
                Thread.Sleep(90);
                var current = Inspect(window.Handle);
                if (current != null && current.ProcessId == window.ProcessId && current.StartedAt == window.StartedAt)
                    window.Title = current.Title;
            }
            return new { sent, expected = events.Length, complete = sent == events.Length };
        }
    }

    private static Input MouseEvent(uint flags, int data = 0) { return new Input { Data = new InputData { Mouse = new Mouse { Flags = flags, Data = data } } }; }
    private static Input KeyEvent(ushort key, ushort scan, uint flags) { return new Input { Type = 1, Data = new InputData { Key = new Key { Virtual = key, Scan = scan, Flags = flags } } }; }
    public void Dispose() { if (observed != null) observed.Dispose(); observed = null; }
}
