"""无限贴纸：Python 标准库服务器，SQLite 存储正文、图片与布局。"""
from __future__ import annotations

import argparse
import datetime as dt
import getpass
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from html import escape
from html.parser import HTMLParser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent
MAX_IMAGE = 12 * 1024 * 1024
MAX_BACKUP = 128 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_STORAGE = 96 * 1024 * 1024
ID_RE = re.compile(r"^[a-f0-9-]{36}$")
COLORS = {"yellow", "blue", "pink", "green", "lavender", "white"}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def new_id():
    return str(uuid.uuid4())


class Problem(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def check_id(value):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise Problem(400, "数据标识无效")
    return value


def text_field(value, limit, label):
    if not isinstance(value, str) or len(value) > limit:
        raise Problem(400, f"{label}无效或过长")
    return value


def record_time(value):
    text_field(value, 40, "记录时间")
    try:
        parsed = dt.datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc).replace(second=0, microsecond=0).isoformat()
    except ValueError:
        raise Problem(400, "请选择有效的日期和时间")


def creation_time(value):
    text_field(value, 60, "创建时间")
    try:
        parsed = dt.datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc).isoformat()
    except ValueError:
        raise Problem(400, "备份创建时间无效")


def layout_field(value):
    if not isinstance(value, dict):
        raise Problem(400, "贴纸布局无效")
    result = {}
    for key, default, low, high in [("dx", -130, -20000, 20000), ("dy", 50, -20000, 20000),
                                   ("width", 430, 320, 1000), ("height", 460, 280, 1000)]:
        number = value.get(key, default)
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not low <= number <= high:
            raise Problem(400, "贴纸位置或尺寸超出范围")
        result[key] = round(number, 2)
    return result


class CleanHTML(HTMLParser):
    allowed = {"p", "div", "br", "strong", "b", "em", "i", "mark", "h1", "h2", "h3",
               "ul", "ol", "li", "a", "pre", "code", "img", "blockquote", "span", "font"}
    void = {"br", "img"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.images, self.stack = [], set(), []
        self.blocked = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "iframe", "object"}:
            self.blocked += 1
            return
        if self.blocked or tag not in self.allowed:
            return
        props, safe = dict(attrs), []
        if tag == "a":
            href = props.get("href", "").strip()
            if href.lower().startswith(("https://", "http://", "mailto:")):
                safe += [f'href="{escape(href, quote=True)}"', 'target="_blank"', 'rel="noopener noreferrer"']
        if tag == "img":
            src = props.get("src", "")
            if not src.startswith("/media/") or not ID_RE.fullmatch(src[7:]):
                return
            self.images.add(src[7:])
            safe += [f'src="{src}"', f'alt="{escape(props.get("alt", "图片")[:200], quote=True)}"']
        style = props.get("style", "").lower().replace(" ", "")
        classes = set(props.get("class", "").split()) & {"highlight", "bold"}
        if "background-color:" in style or "background:" in style:
            classes.add("highlight")
        if "font-weight:700" in style or "font-weight:bold" in style:
            classes.add("bold")
        if classes:
            safe.append(f'class="{" ".join(sorted(classes))}"')
        self.parts.append(f'<{tag}{(" " + " ".join(safe)) if safe else ""}>')
        if tag not in self.void:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in {"script", "style", "iframe", "object"}:
            self.blocked = max(0, self.blocked - 1)
        elif not self.blocked and tag in self.stack:
            while self.stack:
                closing = self.stack.pop()
                self.parts.append(f"</{closing}>")
                if closing == tag:
                    break

    def handle_data(self, data):
        if not self.blocked:
            self.parts.append(escape(data))

    def result(self):
        while self.stack:
            self.parts.append(f"</{self.stack.pop()}>")
        return "".join(self.parts), self.images


def clean_html(value):
    parser = CleanHTML()
    parser.feed(text_field(value, 1000000, "正文"))
    return parser.result()


def image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in {b"GIF87a", b"GIF89a"}:
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise Problem(400, "仅支持 PNG、JPEG、GIF 和 WebP 图片")


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "canvas.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires REAL NOT NULL);
            ''')

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30, factory=ClosingConnection)
        db.row_factory = sqlite3.Row
        return db

    def has_password(self):
        with self.connect() as db:
            return bool(db.execute("SELECT value FROM meta WHERE key='password'").fetchone())

    def set_password(self, password):
        if len(password) < 10:
            raise Problem(400, "密码至少需要 10 个字符")
        salt = secrets.token_bytes(16)
        hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO meta VALUES ('password', ?)", (salt.hex() + ":" + hashed,))
            db.execute("DELETE FROM sessions")

    def verify_password(self, password):
        with self.connect() as db:
            row = db.execute("SELECT value FROM meta WHERE key='password'").fetchone()
        if not row:
            return False
        salt, expected = row[0].split(":")
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(actual, expected)

    def state(self, db=None):
        if db is None:
            with self.connect() as connection:
                connection.execute("BEGIN")
                return self.state(connection)
        return {"topics": [dict(r) for r in db.execute("SELECT * FROM topics ORDER BY rowid")],
                "records": [json.loads(r[0]) for r in db.execute("SELECT payload FROM records")]}

    def check_capacity(self, db):
        # 为清单与 ZIP 目录预留空间，保证应用导出的完整备份可重新导入。
        records = db.execute("SELECT COALESCE(SUM(length(CAST(payload AS BLOB)) - length(CAST(json_extract(payload, '$.version') AS TEXT)) + 20), 0) FROM records").fetchone()[0]
        pictures, count = db.execute("SELECT COALESCE(SUM(length(data)), 0), COUNT(*) FROM images").fetchone()
        topics = db.execute("SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + 200), 0) FROM topics").fetchone()[0]
        if records + pictures + count * 400 + topics + 512000 > MAX_STORAGE or count >= 20000:
            raise Problem(413, "已达到首版完整备份容量上限（96 MB）。请导出备份并使用新的数据目录继续记录；本次操作未写入。")

    def topic(self, data, topic_id=None):
        name = text_field(data.get("name"), 80, "主题名称").strip()
        color = data.get("color", "blue")
        if not name or color not in COLORS:
            raise Problem(400, "请填写主题名称并选择颜色")
        topic_id = check_id(topic_id) if topic_id else new_id()
        with self.lock, self.connect() as db:
            db.execute("INSERT INTO topics VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color",
                       (topic_id, name, color))
            self.check_capacity(db)
        return {"id": topic_id, "name": name, "color": color}

    def save_record(self, data, record_id=None):
        with self.lock, self.connect() as db:
            old = None
            if record_id:
                row = db.execute("SELECT payload FROM records WHERE id=?", (check_id(record_id),)).fetchone()
                if not row:
                    raise Problem(404, "便签不存在")
                old = json.loads(row[0])
                if data.get("version") != old["version"]:
                    raise Problem(409, "这张便签已在其他窗口修改，请复制当前内容后刷新")
            topic_id = check_id(data.get("topicId"))
            if not db.execute("SELECT id FROM topics WHERE id=?", (topic_id,)).fetchone():
                raise Problem(400, "所属主题不存在")
            body, images = clean_html(data.get("body", ""))
            for image_id in images:
                if not db.execute("SELECT id FROM images WHERE id=?", (image_id,)).fetchone():
                    raise Problem(400, "图片尚未上传成功，请重试")
            stamp = now()
            seq_row = db.execute("SELECT value FROM meta WHERE key='next_seq'").fetchone()
            seq = int(seq_row[0]) if seq_row else 1
            result = {"id": old["id"] if old else new_id(), "topicId": topic_id,
                      "time": record_time(data.get("time")), "title": text_field(data.get("title", ""), 200, "标题"),
                      "body": body, "tags": text_field(data.get("tags", ""), 200, "标签"),
                      "color": data.get("color", "yellow"), "pinned": data.get("pinned", False),
                      "layout": layout_field(data.get("layout", {})), "deleted": data.get("deleted", False),
                      "createdAt": old["createdAt"] if old else stamp, "updatedAt": stamp,
                      "seq": old["seq"] if old else seq, "version": old["version"] + 1 if old else 1}
            if result["color"] not in COLORS or type(result["pinned"]) is not bool or type(result["deleted"]) is not bool:
                raise Problem(400, "便签颜色或状态无效")
            db.execute("INSERT OR REPLACE INTO records VALUES (?, ?)", (result["id"], json.dumps(result, ensure_ascii=False)))
            if not old:
                db.execute("INSERT OR REPLACE INTO meta VALUES ('next_seq', ?)", (str(seq + 1),))
            self.check_capacity(db)
            return result

    def add_image(self, data):
        if not data or len(data) > MAX_IMAGE:
            raise Problem(413, "每张图片最大 12 MB")
        mime, image_id = image_type(data), new_id()
        with self.lock, self.connect() as db:
            db.execute("INSERT INTO images VALUES (?, ?, ?)", (image_id, mime, data))
            self.check_capacity(db)
        return {"id": image_id, "url": "/media/" + image_id}

    def backup(self, db=None):
        if db is None:
            with self.lock, self.connect() as connection:
                connection.execute("BEGIN")
                return self.backup(connection)
        state = self.state(db)
        manifest = {"format": "infinite-stickers", "version": 1, "exportedAt": now(), **state, "images": []}
        self.check_capacity(db)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for row in db.execute("SELECT * FROM images"):
                entry = {"id": row["id"], "mime": row["mime"], "path": "images/" + row["id"],
                         "sha256": hashlib.sha256(row["data"]).hexdigest()}
                manifest["images"].append(entry)
                archive.writestr(entry["path"], row["data"])
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        if stream.tell() > MAX_BACKUP:
            raise Problem(413, "完整备份超出导入容量，请联系维护者调整容量设置")
        return stream.getvalue()

    def restore(self, raw):
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries = archive.infolist()
                if len(entries) > 20000 or sum(e.file_size for e in entries) > MAX_EXPANDED:
                    raise Problem(400, "备份解压后的数据过大")
                if len({e.filename for e in entries}) != len(entries):
                    raise Problem(400, "备份包含重复文件")
                manifest = json.loads(archive.read("manifest.json"))
                if not isinstance(manifest, dict):
                    raise Problem(400, "备份清单结构无效；已有数据未改变")
                if manifest.get("format") != "infinite-stickers" or manifest.get("version") != 1:
                    raise Problem(400, "不支持此备份格式或版本")
                topics, records, images = manifest["topics"], manifest["records"], manifest["images"]
                if not all(isinstance(items, list) for items in [topics, records, images]):
                    raise Problem(400, "备份结构无效")
                topic_ids, image_ids, record_ids, seqs = set(), set(), set(), set()
                cleaned_topics, cleaned_records, cleaned_images = [], [], []
                for t in topics:
                    tid = check_id(t["id"])
                    name = text_field(t["name"], 80, "主题名称").strip()
                    if tid in topic_ids or not name or t["color"] not in COLORS:
                        raise Problem(400, "备份主题数据无效")
                    topic_ids.add(tid)
                    cleaned_topics.append((tid, name, t["color"]))
                for image in images:
                    iid = check_id(image["id"])
                    if iid in image_ids or image["path"] != "images/" + iid:
                        raise Problem(400, "备份图片标识无效")
                    data = archive.read(image["path"])
                    if len(data) > MAX_IMAGE or image_type(data) != image["mime"] or hashlib.sha256(data).hexdigest() != image["sha256"]:
                        raise Problem(400, "备份图片损坏或校验失败")
                    image_ids.add(iid)
                    cleaned_images.append((iid, image["mime"], data))
                if {e.filename for e in entries} != {"manifest.json"} | {"images/" + i for i in image_ids}:
                    raise Problem(400, "备份文件清单不匹配")
                for r in records:
                    rid = check_id(r["id"])
                    if rid in record_ids or r["topicId"] not in topic_ids or type(r["seq"]) is not int or r["seq"] <= 0 or r["seq"] in seqs:
                        raise Problem(400, "备份记录关联或顺序无效")
                    body, refs = clean_html(r["body"])
                    if not refs <= image_ids:
                        raise Problem(400, "备份缺少记录引用的图片")
                    if r["color"] not in COLORS or type(r["pinned"]) is not bool or type(r["deleted"]) is not bool:
                        raise Problem(400, "备份便签状态无效")
                    clean = {"id": rid, "topicId": r["topicId"], "time": record_time(r["time"]),
                             "title": text_field(r["title"], 200, "标题"), "body": body,
                             "tags": text_field(r.get("tags", ""), 200, "标签"), "color": r["color"],
                             "pinned": r["pinned"], "deleted": r["deleted"], "layout": layout_field(r["layout"]),
                             "createdAt": creation_time(r["createdAt"]), "updatedAt": creation_time(r["updatedAt"]), "seq": r["seq"],
                             "version": secrets.randbelow(1000000000) + 1000000000}
                    record_ids.add(rid)
                    seqs.add(r["seq"])
                    cleaned_records.append((rid, json.dumps(clean, ensure_ascii=False)))
        except Problem:
            raise
        except (KeyError, ValueError, TypeError, zipfile.BadZipFile, RuntimeError, OSError):
            raise Problem(400, "备份无效、损坏或缺少必要文件；已有数据未改变")
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            before = self.backup(db)
            backups = self.directory / "backups"
            backups.mkdir(exist_ok=True)
            filename = "before-restore-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3) + ".zip"
            (backups / filename).write_bytes(before)
            db.execute("DELETE FROM records")
            db.execute("DELETE FROM topics")
            db.execute("DELETE FROM images")
            db.executemany("INSERT INTO topics VALUES (?, ?, ?)", cleaned_topics)
            db.executemany("INSERT INTO records VALUES (?, ?)", cleaned_records)
            db.executemany("INSERT INTO images VALUES (?, ?, ?)", cleaned_images)
            db.execute("INSERT OR REPLACE INTO meta VALUES ('next_seq', ?)", (str(max(seqs, default=0) + 1),))
            self.check_capacity(db)
        return {"ok": True, "backup": filename, "records": len(records)}


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, secure=False):
        super().__init__(address, Handler)
        self.store, self.secure = store, secure
        self.attempts = {}
        self.attempt_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "InfiniteStickers"

    def log_message(self, fmt, *args):
        # 不记录 cookie、密码、请求正文。
        print(f"{self.client_address[0]} {fmt % args}")

    def send(self, status, data, mime="application/json; charset=utf-8", extra=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def body(self, limit):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise Problem(400, "请求长度无效")
        if size < 0 or size > limit:
            raise Problem(413, "文件或请求过大")
        self.connection.settimeout(30)
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise Problem(400, "请求不完整")
        return raw

    def json_body(self):
        try:
            value = json.loads(self.body(2 * 1024 * 1024))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeDecodeError):
            raise Problem(400, "请求内容无效")

    def session(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["canvas_session"].value
        except (KeyError, ValueError):
            return None
        with self.server.store.connect() as db:
            return db.execute("SELECT * FROM sessions WHERE token=? AND expires>?",
                              (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()

    def origin(self):
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            raise Problem(403, "请求来源不受信任")
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise Problem(403, "请求来源不受信任")

    def authorized(self, mutate=False):
        session = self.session()
        if not session:
            raise Problem(401, "请先登录")
        if mutate:
            self.origin()
            if not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), session["csrf"]):
                raise Problem(403, "会话校验失败，请重新登录")
        return session

    def login(self):
        self.origin()
        ip = self.client_address[0]
        with self.server.attempt_lock:
            recent = [t for t in self.server.attempts.get(ip, []) if t > time.time() - 300]
            if len(recent) >= 10:
                raise Problem(429, "尝试过于频繁，请 5 分钟后重试")
            self.server.attempts[ip] = recent + [time.time()]
        password = text_field(self.json_body().get("password"), 1024, "密码")
        if not self.server.store.verify_password(password):
            raise Problem(401, "密码不正确")
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.server.store.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (hashlib.sha256(token.encode()).hexdigest(), csrf, time.time() + 86400 * 7))
        with self.server.attempt_lock:
            self.server.attempts.pop(ip, None)
        cookie = f"canvas_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800" + ("; Secure" if self.server.secure else "")
        self.send(200, {"authenticated": True, "csrf": csrf}, extra={"Set-Cookie": cookie})

    def dispatch(self):
        path = urlsplit(self.path).path
        store = self.server.store
        if self.command == "GET":
            static = {"/": "index.html", "/app.js": "app.js", "/core.js": "core.js", "/style.css": "style.css"}
            if path in static:
                file = ROOT / "web" / static[path]
                mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}[file.suffix]
                return self.send(200, file.read_bytes(), mime + "; charset=utf-8")
            if path == "/api/session":
                session = self.session()
                return self.send(200, {"authenticated": bool(session), "csrf": session["csrf"] if session else ""})
            self.authorized()
            if path == "/api/state":
                return self.send(200, store.state())
            if path == "/api/backup":
                return self.send(200, store.backup(), "application/zip", {"Content-Disposition": 'attachment; filename="infinite-stickers.zip"'})
            if path.startswith("/media/"):
                with store.connect() as db:
                    row = db.execute("SELECT mime, data FROM images WHERE id=?", (check_id(path[7:]),)).fetchone()
                if not row:
                    raise Problem(404, "图片不存在")
                return self.send(200, row["data"], row["mime"])
        elif self.command in {"POST", "PATCH"}:
            if path == "/api/login" and self.command == "POST":
                return self.login()
            session = self.authorized(True)
            if path == "/api/logout":
                with store.connect() as db:
                    db.execute("DELETE FROM sessions WHERE token=?", (session["token"],))
                return self.send(200, {"ok": True}, extra={"Set-Cookie": "canvas_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"})
            if path == "/api/topics" and self.command == "POST":
                return self.send(201, store.topic(self.json_body()))
            if path.startswith("/api/topics/") and self.command == "PATCH":
                return self.send(200, store.topic(self.json_body(), path[12:]))
            if path == "/api/records" and self.command == "POST":
                return self.send(201, store.save_record(self.json_body()))
            if path.startswith("/api/records/") and self.command == "PATCH":
                return self.send(200, store.save_record(self.json_body(), path[13:]))
            if path == "/api/images" and self.command == "POST":
                return self.send(201, store.add_image(self.body(MAX_IMAGE)))
            if path == "/api/restore" and self.command == "POST":
                return self.send(200, store.restore(self.body(MAX_BACKUP)))
        raise Problem(404, "页面或接口不存在")

    def handle_request(self):
        try:
            self.dispatch()
        except Problem as problem:
            self.send(problem.status, {"error": problem.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            import traceback
            traceback.print_exc()
            self.send(500, {"error": "服务暂时无法完成操作，当前内容请保留并重试"})

    do_GET = handle_request
    do_POST = handle_request
    do_PATCH = handle_request


def demo_seed(store):
    if store.state()["topics"]:
        return
    topics = [store.topic({"name": name, "color": color}) for name, color in
              [("项目 A · 灵感与进展", "blue"), ("英语学习", "pink"), ("每日工作日记", "yellow")]]
    examples = [
        ("一个新的开始", "<p>把想法留在这里，让每一步都有迹可循。</p><p>这次想做一个真正属于自己的记录空间。</p>"),
        ("整理第一版思路", "<p>记录不需要很正式，一句话、一张图，都值得留下。</p><ul><li>按时间自然排列</li><li>随时回头看</li></ul>"),
        ("把问题拆小一点", "<p>今天把一个大问题拆成了三个小步骤。</p><p><mark>先让最重要的路径走通。</mark></p>"),
        ("值得保留的片刻", "<p>午后有了一点新灵感。留下一张草图，下次继续。</p>"),
        ("试着换一个角度", "<p>回看前面的记录，发现有些事情已经慢慢清楚了。</p>"),
        ("今天的小进展", "<p>完成了最开始觉得棘手的一步。</p><pre><code>记录 → 回顾 → 调整\n一步一步继续。</code></pre>"),
        ("继续往前", "<p>下一步：把想法变成可以体验的东西。</p>"),
        ("阶段回顾", "<p>回顾这一周，事情没有一开始想得那么复杂。</p><p>钉住几张记录，放在一起看看。</p>"),
        ("补充一条想法", "<p>好的工具应该让记录变轻松。</p>"),
        ("留给明天", "<p>明天从这里接着做。</p>"),
        ("重新梳理重点", "<p>把最重要的三件事写下来，今天只专注其中一件。</p>"),
        ("试验一个小方案", "<p>先做一次小尝试，看看是否符合预期。</p>"),
        ("记录遇到的问题", "<p>把当时的现象和解决过程一起留下，下次可以少走一点弯路。</p>"),
        ("找到了新的线索", "<p>对照前面的几张便签，发现这几件事其实有关联。</p>"),
        ("第一轮整理", "<p>今天把零散的笔记整理了一遍。主题里的故事正在慢慢完整。</p>"),
        ("一张随手的草稿", "<p>不必等想法完全成熟再记录，先把它放在时间线上。</p>"),
        ("留一点空白", "<p>有些问题暂时没有答案，先记在这里，之后回来再看。</p>"),
        ("把经验写下来", "<p>下次开始前，先回顾这一次的经验。</p>"),
        ("新的尝试", "<p>今天从另一个方向继续。改变方法之后，事情顺畅了一些。</p>"),
        ("阶段小结", "<p>已经积累了一些有用的片刻，可以缩小画布看一看全貌。</p>"),
        ("继续完善", "<p>一步一步补充，把值得保留的细节记下来。</p>"),
        ("下一段旅程", "<p>时间线还会继续延伸，下一张便签等着新的故事。</p>")]
    colors = ["yellow", "blue", "pink", "green", "yellow", "lavender"]
    for index, (title, body) in enumerate(examples):
        store.save_record({"topicId": topics[0]["id"], "title": title, "body": body,
                           "time": f"2026-10-{index + 1:02d}T09:00:00+08:00", "color": colors[index % len(colors)]})


def main():
    parser = argparse.ArgumentParser(description="无限贴纸服务器")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--data-dir", default=str(ROOT / "data"))
    parser.add_argument("--init", action="store_true", help="设置或重置单用户登录密码后退出")
    parser.add_argument("--demo", action="store_true", help="仅本机演示，初始密码 canvas-demo")
    parser.add_argument("--secure-cookie", action="store_true", help="HTTPS 反向代理部署时开启")
    args = parser.parse_args()
    store = Store(args.data_dir)
    if args.init:
        password = getpass.getpass("设置登录密码（至少 10 个字符）: ")
        if password != getpass.getpass("再次输入: "):
            parser.error("两次密码不一致")
        store.set_password(password)
        print("密码已设置，所有旧登录会话已失效。")
        return
    if args.demo:
        if args.host != "127.0.0.1":
            parser.error("演示只能绑定 127.0.0.1")
        if not store.has_password():
            store.set_password("canvas-demo")
        demo_seed(store)
    if not store.has_password():
        parser.error("请先运行 python server.py --init 设置登录密码")
    server = AppServer((args.host, args.port), store, args.secure_cookie)
    print(f"无限贴纸已启动：http://{args.host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
