#!/usr/bin/env python3
"""使用保留的锁文件串行化启动，不删除任何文件。"""
import fcntl,subprocess,sys,os,shutil
from pathlib import Path
root=Path(__file__).resolve().parent.parent
directory=Path(os.environ.get('ANQI_DESKTOP_DIR',str(Path.home()/'Library'/'Application Support'/'cn.csslaw.anqi.local-only')));directory.mkdir(parents=True,exist_ok=True,mode=0o700)
node=root.parent/'bin'/'node'
if not node.is_file():
    node_path=os.environ.get('ANQI_NODE') or shutil.which('node')
    if not node_path:raise RuntimeError('需要 Node.js 22，请设置 ANQI_NODE 或将 node 加入 PATH')
    node=Path(node_path)
with (directory/'start.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    result=subprocess.run([str(node),str(root/'tools'/'desktop-start.cjs')],cwd=root)
    sys.exit(result.returncode)
