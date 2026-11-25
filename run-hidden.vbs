' 用无窗口方式启动钥匙池（需要 node 在 PATH 里）
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "node """ & dir & "\pool.mjs""", 0, False
