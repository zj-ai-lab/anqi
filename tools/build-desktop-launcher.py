#!/usr/bin/env python3
"""构建自包含本机应用；不包含数据、密钥、同步配置或 Git。"""
import pathlib,plistlib,subprocess,shutil,hashlib,uuid,os
root=pathlib.Path(__file__).resolve().parent.parent
app=root/'build-local'/'案齐本地版.app';contents=app/'Contents';resources=contents/'Resources';runtime=resources/'runtime'
(contents/'MacOS').mkdir(parents=True,exist_ok=True);runtime.mkdir(parents=True,exist_ok=True);(resources/'bin').mkdir(exist_ok=True)
paths=subprocess.check_output(['git','ls-files','-z','server.js','package.json','package-lock.json','LICENSE','src','public','rules'],cwd=root).decode().split('\0')
paths += ['tools/desktop-start.py','tools/desktop-start.cjs','tools/local-backup.cjs']
for name in set(paths):
    if not name:continue
    source=root/name
    if not source.is_file():continue
    target=runtime/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
def copy_tree(source,target):
    target.mkdir(parents=True,exist_ok=True)
    for item in source.iterdir():
        out=target/item.name
        if item.is_symlink():
            value=item.readlink()
            if out.is_symlink():
                if out.readlink()!=value:raise RuntimeError('已有链接不匹配，保留旧文件并停止')
            elif out.exists():raise RuntimeError('已有目标不是链接，停止')
            else:out.symlink_to(value)
        elif item.is_dir():copy_tree(item,out)
        else:shutil.copy2(item,out)
copy_tree(root/'node_modules',runtime/'node_modules')
node_path=os.environ.get('ANQI_NODE') or shutil.which('node')
if not node_path:raise RuntimeError('需要 Node.js 22，请设置 ANQI_NODE 或将 node 加入 PATH')
node_source=pathlib.Path(node_path)
if not subprocess.check_output([str(node_source),'--version']).decode().startswith('v22.'):raise RuntimeError('构建需要 Node.js 22')
node_target=resources/'bin'/'node'
retained=app.parent/'launcher-build-backups';retained.mkdir(mode=0o700,exist_ok=True)
def preserve_binary(target):
    if target.exists():target.rename(retained/(target.name+'-'+uuid.uuid4().hex))
# macOS 对原地重写的已执行二进制可能保留失效的代码页签名缓存。
# 不重写可运行的相同 Node；确需替换时先移动留存，再创建新文件。
replace_node=not node_target.is_file() or hashlib.sha256(node_source.read_bytes()).digest()!=hashlib.sha256(node_target.read_bytes()).digest()
if not replace_node:
    probe=subprocess.run([str(node_target),'--version'],capture_output=True)
    replace_node=probe.returncode!=0
if replace_node:
    preserve_binary(node_target);shutil.copy2(node_source,node_target)
subprocess.run([str(node_target),'--version'],check=True,capture_output=True)
info={'CFBundleName':'案齐','CFBundleDisplayName':'案齐本地版','CFBundleIdentifier':'cn.csslaw.anqi.launcher.local-only','CFBundleVersion':'6','CFBundleShortVersionString':'1.5','CFBundleExecutable':'ANQI','CFBundlePackageType':'APPL','NSHighResolutionCapable':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True}}
if (root/'build'/'icon.icns').is_file():shutil.copy2(root/'build'/'icon.icns',resources/'ANQI.icns');info['CFBundleIconFile']='ANQI.icns'
with (contents/'Info.plist').open('wb') as f:plistlib.dump(info,f)
preserve_binary(contents/'MacOS'/'ANQI')
subprocess.run(['xcrun','swiftc','-parse-as-library',str(root/'desktop'/'Launcher.swift'),'-framework','AppKit','-framework','WebKit','-o',str(contents/'MacOS'/'ANQI')],check=True)
subprocess.run(['codesign','--force','--sign','-',str(app)],check=True)
print(app)
