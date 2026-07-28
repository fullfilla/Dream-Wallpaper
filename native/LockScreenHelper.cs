using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class LockScreenHelper
{
    private static string Json(string value)
    {
        if (value == null) return "null";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
    }

    private static void WriteResult(bool ok, string code, string message, string path)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine("{\"ok\":" + (ok ? "true" : "false") + ",\"code\":" + Json(code) + ",\"message\":" + Json(message) + ",\"path\":" + Json(path) + "}");
    }

    private static Type WinRtType(string typeName, string assemblyName)
    {
        Type type = Type.GetType(typeName + ", " + assemblyName + ", ContentType=WindowsRuntime", false);
        if (type == null) throw new PlatformNotSupportedException("Windows Runtime 类型不可用：" + typeName);
        return type;
    }

    private static Type ExtensionsType()
    {
        string runtimeDirectory = RuntimeEnvironment.GetRuntimeDirectory();
        Assembly assembly = Assembly.LoadFrom(Path.Combine(runtimeDirectory, "System.Runtime.WindowsRuntime.dll"));
        Type type = assembly.GetType("System.WindowsRuntimeSystemExtensions", true);
        return type;
    }

    private static object AwaitOperation(object operation, Type resultType)
    {
        Type extensions = ExtensionsType();
        MethodInfo method = extensions.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(item => item.Name == "AsTask" && item.IsGenericMethodDefinition)
            .Where(item => item.GetParameters().Length == 1)
            .First(item =>
            {
                Type parameter = item.GetParameters()[0].ParameterType;
                return parameter.IsGenericType && parameter.GetGenericTypeDefinition().FullName == "Windows.Foundation.IAsyncOperation`1";
            })
            .MakeGenericMethod(resultType);
        Task task = (Task)method.Invoke(null, new object[] { operation });
        task.GetAwaiter().GetResult();
        return task.GetType().GetProperty("Result").GetValue(task, null);
    }

    private static void AwaitAction(object action)
    {
        Type extensions = ExtensionsType();
        MethodInfo method = extensions.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(item => item.Name == "AsTask" && !item.IsGenericMethodDefinition)
            .Where(item => item.GetParameters().Length == 1)
            .First(item => item.GetParameters()[0].ParameterType.FullName == "Windows.Foundation.IAsyncAction");
        Task task = (Task)method.Invoke(null, new object[] { action });
        task.GetAwaiter().GetResult();
    }

    [STAThread]
    public static int Main(string[] args)
    {
        string imagePath = args.Length > 0 ? args[0] : "";
        try
        {
            if (string.IsNullOrWhiteSpace(imagePath))
            {
                WriteResult(false, "missing-path", "未提供锁屏图片路径。", imagePath);
                return 2;
            }

            imagePath = Path.GetFullPath(imagePath);
            if (!File.Exists(imagePath))
            {
                WriteResult(false, "file-not-found", "锁屏图片文件不存在。", imagePath);
                return 2;
            }

            Type storageFileType = WinRtType("Windows.Storage.StorageFile", "Windows.Storage");
            MethodInfo getFile = storageFileType.GetMethod("GetFileFromPathAsync", BindingFlags.Public | BindingFlags.Static);
            object fileOperation = getFile.Invoke(null, new object[] { imagePath });
            object storageFile = AwaitOperation(fileOperation, storageFileType);

            Type lockScreenType = WinRtType("Windows.System.UserProfile.LockScreen", "Windows.System.UserProfile");
            MethodInfo setImage = lockScreenType.GetMethod("SetImageFileAsync", BindingFlags.Public | BindingFlags.Static);
            object setOperation = setImage.Invoke(null, new object[] { storageFile });
            AwaitAction(setOperation);

            WriteResult(true, "applied", "锁屏壁纸已更新。", imagePath);
            return 0;
        }
        catch (TargetInvocationException error)
        {
            Exception inner = error.InnerException ?? error;
            WriteResult(false, "exception", inner.GetType().Name + ": " + inner.Message, imagePath);
            return 10;
        }
        catch (Exception error)
        {
            WriteResult(false, "exception", error.GetType().Name + ": " + error.Message, imagePath);
            return 10;
        }
    }
}
