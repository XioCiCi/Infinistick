"""运行真实 Windows 启动入口，覆盖中文及空格路径和服务就绪。"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

from server import Store


@unittest.skipUnless(os.name == 'nt', 'Windows 启动脚本检查')
class LauncherTests(unittest.TestCase):
    def check_launcher(self, filename, personal=False):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='贴纸启动验证 空格 ') as temp:
            folder = Path(temp)
            shutil.copy2(source / filename, folder / filename)
            shutil.copy2(source / 'server.py', folder / 'server.py')
            if personal:
                Store(folder / 'data').set_password('launch-test-only-password')
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            env = {**os.environ, 'STICKERS_PORT': str(port)}
            with (folder / 'startup.log').open('wb') as output:
                process = subprocess.Popen(['cmd.exe', '/d', '/c', 'call', str(folder / filename)],
                                           cwd=folder, env=env, stdout=output, stderr=subprocess.STDOUT,
                                           stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
                try:
                    ready = False
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline and process.poll() is None:
                        try:
                            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/session', timeout=.3) as response:
                                ready = response.status == 200
                                break
                        except (urllib.error.URLError, TimeoutError):
                            time.sleep(.1)
                    output.flush()
                    log = (folder / 'startup.log').read_bytes().decode('utf-8', errors='replace')
                    self.assertTrue(ready, f'{filename} 未成功启动：\n{log[:1500]}')
                    self.assertNotIn('not recognized', log)
                    self.assertIn('打开 http://127.0.0.1:', log)
                    self.assertIn('关闭此窗口即可停止服务。', log)
                finally:
                    if process.poll() is None:
                        # 仅终止本测试创建且仍运行的 cmd 及其 Python 子进程。
                        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                    process.wait(timeout=5)

    def test_demo_launcher(self):
        self.check_launcher('启动演示.cmd')

    def test_personal_launcher(self):
        self.check_launcher('启动个人空间.cmd', personal=True)


if __name__ == '__main__':
    unittest.main()
