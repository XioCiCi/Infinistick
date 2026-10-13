import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import AppServer, Problem, Store, clean_html


PNG = bytes.fromhex('89504e470d0a1a0a') + b'test-image-bytes'


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.topic = self.store.topic({'name': '学习', 'color': 'blue'})

    def tearDown(self):
        self.temp.cleanup()

    def record(self, **overrides):
        return self.store.save_record({'topicId': self.topic['id'], 'time': '2026-10-13T10:20+08:00', **overrides})

    def test_stable_creation_order_blank_and_revision_conflict(self):
        first, second = self.record(), self.record()
        self.assertLess(first['seq'], second['seq'])
        changed = self.store.save_record({**first, 'title': '新标题'}, first['id'])
        self.assertEqual(changed['version'], 2)
        with self.assertRaises(Problem) as error:
            self.store.save_record(first, first['id'])
        self.assertEqual(error.exception.status, 409)
        reopened = Store(self.temp.name).state()['records']
        self.assertEqual(next(r for r in reopened if r['id'] == first['id'])['title'], '新标题')

    def test_backup_round_trip_preserves_images_trash_pin_and_layout(self):
        image = self.store.add_image(PNG)
        record = self.record(body=f'<p>笔记</p><img src="{image["url"]}"><pre><code>a\n  b</code></pre>',
                             pinned=True, deleted=True,
                             layout={'dx': 800, 'dy': -150, 'width': 650, 'height': 700})
        backup = self.store.backup()
        with tempfile.TemporaryDirectory() as dest:
            restored = Store(dest)
            restored.set_password('my-password-123')
            restored.restore(backup)
            result = restored.state()['records'][0]
            for key in ['body', 'pinned', 'deleted', 'layout', 'time', 'seq', 'createdAt', 'updatedAt']:
                self.assertEqual(result[key], record[key])
            self.assertTrue(restored.verify_password('my-password-123'))
            with restored.connect() as db:
                self.assertEqual(db.execute('SELECT data FROM images').fetchone()[0], PNG)
            self.assertEqual(len(list((Path(dest) / 'backups').glob('*.zip'))), 1)

    def test_damaged_import_changes_nothing(self):
        image = self.store.add_image(PNG)
        self.record(body=f'<img src="{image["url"]}">')
        original = self.store.state()
        raw = self.store.backup()
        modified = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive, zipfile.ZipFile(modified, 'w') as output:
            for name in archive.namelist():
                value = archive.read(name)
                if name.startswith('images/'):
                    value += b'corrupted'
                output.writestr(name, value)
        with self.assertRaises(Problem):
            self.store.restore(modified.getvalue())
        self.assertEqual(original, self.store.state())
        with self.assertRaises(Problem):
            self.store.restore(b'not a zip')
        self.assertEqual(original, self.store.state())

    def test_missing_image_and_unsafe_html(self):
        body, images = clean_html('<script>alert(1)</script><p onclick="bad()">正文</p><a href="javascript:bad()">链接</a><span style="background-color:yellow">重点</span>')
        self.assertNotIn('script', body)
        self.assertNotIn('onclick', body)
        self.assertNotIn('javascript', body)
        self.assertIn('class="highlight"', body)
        with self.assertRaises(Problem):
            self.record(body='<img src="/media/11111111-1111-1111-1111-111111111111">')
        highlighted, _ = clean_html('<b style="background-color: rgb(255,232,153)">重点</b><font style="background-color:yellow">标记</font><span class="bold highlight">合并格式</span>')
        self.assertIn('<b class="highlight">重点</b>', highlighted)
        self.assertIn('<font class="highlight">标记</font>', highlighted)
        self.assertIn('class="bold highlight"', highlighted)

    def test_invalid_manifest_and_capacity_rejection_leave_data_unchanged(self):
        self.record(title='已有内容')
        before = self.store.state()
        invalid = io.BytesIO()
        with zipfile.ZipFile(invalid, 'w') as archive:
            archive.writestr('manifest.json', '[]')
        with self.assertRaises(Problem) as error:
            self.store.restore(invalid.getvalue())
        self.assertEqual(error.exception.status, 400)
        with patch('server.MAX_STORAGE', 1):
            with self.assertRaises(Problem):
                self.record(title='不应写入')
            with self.assertRaises(Problem):
                self.store.add_image(PNG)
        self.assertEqual(before, self.store.state())
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM images').fetchone()[0], 0)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        store = Store(self.temp.name)
        store.set_password('test-password-123')
        self.server = AppServer(('127.0.0.1', 0), store)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.temp.cleanup()

    def request(self, path, method='GET', body=None, headers=None):
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                                     method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.loads(response.read()), response.headers
        except urllib.error.HTTPError as response:
            return response.code, json.loads(response.read()), response.headers

    def test_auth_csrf_and_logout(self):
        self.assertEqual(self.request('/api/state')[0], 401)
        code, data, headers = self.request('/api/login', 'POST', {'password': 'test-password-123'})
        self.assertEqual(code, 200)
        cookie = headers['Set-Cookie'].split(';')[0]
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        auth = {'Cookie': cookie, 'X-CSRF-Token': data['csrf']}
        self.assertEqual(self.request('/api/state', headers=auth)[0], 200)
        self.assertEqual(self.request('/api/topics', 'POST', {'name': '测试'}, {'Cookie': cookie})[0], 403)
        self.assertEqual(self.request('/api/topics', 'POST', {'name': '测试', 'color': 'blue'}, auth)[0], 201)
        self.assertEqual(self.request('/api/logout', 'POST', {}, auth)[0], 200)
        self.assertEqual(self.request('/api/state', headers=auth)[0], 401)


if __name__ == '__main__':
    unittest.main()
