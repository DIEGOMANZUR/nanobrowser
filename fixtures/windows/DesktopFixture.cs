using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

internal static class DesktopFixture
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        var form = new Form { Text = "Nanobrowser Visual Fixture", ClientSize = new Size(520, 320), StartPosition = FormStartPosition.CenterScreen };
        var editor = new TextBox { AccessibleName = "New note", Location = new Point(48, 60), Width = 420 };
        var button = new Button { Text = "Add marker", Location = new Point(48, 124), Size = new Size(144, 40) };
        var status = new Label { Text = "Ready", Location = new Point(48, 190), AutoSize = true };
        button.Click += (sender, e) => { status.Text = "Marker added"; File.AppendAllText(args[0], "click\n"); };
        editor.TextChanged += (sender, e) => File.WriteAllText(args[1], editor.Text);
        editor.KeyDown += (sender, e) => { if (e.KeyCode == Keys.Right) File.WriteAllText(args[3], "key"); };
        editor.MouseWheel += (sender, e) => File.WriteAllText(args[4], "scroll");
        form.Controls.AddRange(new Control[] { editor, button, status });
        form.Shown += (sender, e) => { form.Activate(); editor.Focus(); File.WriteAllText(args[2], "ready"); };
        Application.Run(form);
    }
}
