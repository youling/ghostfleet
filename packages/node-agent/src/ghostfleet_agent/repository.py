"""Transactional task truth. SQLite owns atomic commit/recovery, not JSON files.

默认 DELETE + EXTRA；仅限本地文件系统。任务终态/结果/投递状态同一事务，
HTTP 在事务外；ACK 丢失只重发原摘要。数据库故障后关闭连接，不带病执行。
No network calls, credentials, archive segments or background maintenance here.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
from typing import Callable, Iterator

SCHEMA_VERSION = 1
APPLICATION_ID = 0x47465431
TERMINAL = frozenset({'SUCCEEDED', 'REFUSED', 'FAILED', 'UNKNOWN'})
FENCED = 'MAY_HAVE_EXECUTED'
MAX_BODY_BYTES = 65536


class RepositoryError(Exception):
    """Storage failed or is untrusted; stop dispatch and reopen after recovery."""
    code = 'TASK_REPOSITORY_FAILED'


class Conflict(RepositoryError):
    code = 'TASK_RECORD_CONFLICT'


class Capacity(RepositoryError):
    code = 'TASK_BACKPRESSURE'


def canonical(value: object) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'),
                          ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
        raise Conflict('non-canonical JSON') from exc


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 256:
        raise Conflict('invalid ' + name)
    return value


def _private(path: Path, *, directory: bool = False) -> None:
    info = path.lstat()
    regular = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not regular or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600):
        raise RepositoryError('untrusted state path')


_SCHEMA = (
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    """CREATE TABLE tasks(
        task_id TEXT PRIMARY KEY,
        node_uid TEXT NOT NULL,
        operation TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK(attempt>0),
        execution_state TEXT NOT NULL CHECK(execution_state IN
          ('MAY_HAVE_EXECUTED','SUCCEEDED','REFUSED','FAILED','UNKNOWN')),
        delivery_state TEXT NOT NULL CHECK(delivery_state IN
          ('NONE','PENDING','ACKED','QUARANTINED')),
        result_body TEXT,
        result_digest TEXT,
        reason TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts>=0),
        CHECK(result_digest IS NULL OR (length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*')),
        CHECK(delivery_state!='NONE' OR
          (execution_state='MAY_HAVE_EXECUTED' AND result_body IS NULL AND result_digest IS NULL)),
        CHECK(delivery_state!='PENDING' OR
          (execution_state!='MAY_HAVE_EXECUTED' AND result_body IS NOT NULL AND result_digest IS NOT NULL)),
        CHECK(delivery_state!='ACKED' OR
          (execution_state!='MAY_HAVE_EXECUTED' AND result_body IS NULL AND result_digest IS NOT NULL))
    ) STRICT""",
    'CREATE INDEX pending_tasks ON tasks(delivery_state,created_at,task_id)',
    'CREATE TABLE imports(source_key TEXT PRIMARY KEY, manifest TEXT NOT NULL, imported_at REAL NOT NULL) STRICT',
)


class TaskRepository:
    """One task row, one result, one transaction. No mutable record cache.

    A BEGIN fence commits before execution. A result and PENDING commit together.
    ACK clears the body only after matching task/digest acceptance. No SQL is held
    across HTTP. No automatic deletion of unacknowledged/quarantined records.
    """

    def __init__(self, path: str | Path, node_uid: str, *, max_pending: int = 64,
                 max_bytes: int = 64*1024*1024, timeout: float = 1.0,
                 _fault: Callable[[str], None] | None = None) -> None:
        self.path = Path(path).absolute()
        self.node_uid = _text(node_uid, 'node_uid')
        if type(max_pending) is not int or max_pending < 1:
            raise ValueError('max_pending must be positive')
        if type(max_bytes) is not int or max_bytes < 65536:
            raise ValueError('max_bytes must be at least 64 KiB')
        self.max_pending = max_pending
        self._fault = _fault or (lambda point: None)
        self._db: sqlite3.Connection | None = None
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        _private(self.path.parent, directory=True)
        # Unknown legacy state must never silently become a new empty queue.
        if not self.path.exists() and any((self.path.parent / p).exists() for p in
                ('ledger.json', 'outbox.json', 'tombstones.json', 'tasks')):
            raise RepositoryError('LEGACY_STATE_REQUIRES_EXPLICIT_IMPORT')
        created = False
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            _private(self.path)
        else:
            os.close(fd)
            created = True
        for suffix in ('-journal', '-wal', '-shm'):
            sidecar = Path(str(self.path) + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                _private(sidecar)
        try:
            self._db = sqlite3.connect(self.path, isolation_level=None, timeout=timeout)
            self._db.row_factory = sqlite3.Row
            if self._db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                raise RepositoryError('unexpected journal mode; do not convert a live database')
            self._db.execute('PRAGMA synchronous=EXTRA')
            self._db.execute('PRAGMA foreign_keys=ON')
            self._db.execute('PRAGMA trusted_schema=OFF')
            if self._db.execute('PRAGMA synchronous').fetchone()[0] != 3:
                raise RepositoryError('EXTRA durability unavailable')
            if created:
                with self._transaction() as db:
                    for sql in _SCHEMA:
                        db.execute(sql)
                    db.execute('PRAGMA user_version=1')
                    db.execute(f'PRAGMA application_id={APPLICATION_ID}')
                    db.execute('INSERT INTO meta VALUES (?,?)', ('schema', 'ghostfleet-task-db/v1'))
            elif (self._db.execute('PRAGMA user_version').fetchone()[0] != SCHEMA_VERSION or
                  self._db.execute('PRAGMA application_id').fetchone()[0] != APPLICATION_ID):
                raise RepositoryError('database schema not recognized; no automatic reset')
            if self._db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RepositoryError('database integrity failure')
            page_size = self._db.execute('PRAGMA page_size').fetchone()[0]
            self._db.execute(f'PRAGMA max_page_count={max_bytes // page_size}')
            self.validate_all()
        except BaseException:
            self.close()
            raise

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            raise RepositoryError('repository closed/poisoned; reopen required')
        return self._db

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        db = self.db
        try:
            self._fault('before_begin')
            db.execute('BEGIN IMMEDIATE')
            self._fault('after_begin')
            yield db
            self._fault('before_commit')
            db.execute('COMMIT')
            self._fault('after_commit')
        except (Conflict, Capacity):
            try:
                if db.in_transaction:
                    db.execute('ROLLBACK')
            except sqlite3.Error as exc:
                self.close()
                raise RepositoryError('rollback failed; reopen required') from exc
            raise
        except BaseException as exc:
            try:
                if db.in_transaction:
                    db.execute('ROLLBACK')
            finally:
                self.close()
            if isinstance(exc, (sqlite3.Error, OSError)):
                raise RepositoryError('transaction failed; reopen and reconcile') from exc
            raise

    @staticmethod
    def _validate(row: dict) -> dict:
        _text(row['task_id'], 'task_id')
        _text(row['node_uid'], 'node_uid')
        _text(row['operation'], 'operation')
        body = row['result_body']
        if body is not None:
            try:
                parsed = json.loads(body)
            except (ValueError, TypeError, RecursionError) as exc:
                raise Conflict('invalid stored body') from exc
            result = parsed.get('result') if isinstance(parsed, dict) else None
            if not isinstance(result, dict):
                raise Conflict('result must be object')
            for key in ('task_id', 'operation'):
                if parsed.get(key) != row[key] or result.get(key) != row[key]:
                    raise Conflict('result identity mismatch')
            status = result.get('status')
            if not isinstance(status, str) or status not in TERMINAL or status != row['execution_state']:
                raise Conflict('result status mismatch')
            if result.get('schema') != 'ghostfleet-node-task/v0':
                raise Conflict('result schema mismatch')
            if result.get('node_uid') != row['node_uid']:
                raise Conflict('result node mismatch')
            if digest(result) != row['result_digest'] or parsed.get('result_digest') != row['result_digest']:
                raise Conflict('result digest mismatch')
            if canonical(parsed) != body or len(body.encode('utf-8')) > MAX_BODY_BYTES:
                raise Conflict('body encoding/size invalid')
            row['body'] = parsed
        else:
            row['body'] = None
        return row

    def validate_all(self) -> None:
        for row in self.db.execute('SELECT * FROM tasks'):
            self._validate(dict(row))

    def get(self, task_id: str) -> dict | None:
        row = self.db.execute('SELECT * FROM tasks WHERE task_id=?', (task_id,)).fetchone()
        return self._validate(dict(row)) if row else None

    def counts(self) -> dict[str, int]:
        return dict(self.db.execute('SELECT delivery_state,count(*) FROM tasks GROUP BY delivery_state'))

    def capacity_used(self) -> int:
        return self.db.execute("SELECT count(*) FROM tasks WHERE delivery_state IN ('NONE','PENDING')").fetchone()[0]

    def begin(self, task_id: str, operation: str, attempt: int = 1) -> str:
        _text(task_id, 'task_id'); _text(operation, 'operation')
        if type(attempt) is not int or attempt < 1:
            raise Conflict('invalid attempt')
        with self._transaction() as db:
            row = self.get(task_id)
            if row is not None:
                if row['node_uid'] != self.node_uid or row['operation'] != operation:
                    raise Conflict('task reused for different identity/operation')
                return 'ALREADY_FENCED' if row['delivery_state'] == 'NONE' else 'ALREADY_DONE'
            if self.capacity_used() >= self.max_pending:
                raise Capacity('pending/fenced task capacity reached')
            now = time.time()
            db.execute('''INSERT INTO tasks(task_id,node_uid,operation,attempt,execution_state,
                       delivery_state,created_at,updated_at) VALUES (?,?,?,?,?,'NONE',?,?)''',
                       (task_id,self.node_uid,operation,attempt,FENCED,now,now))
        return 'NEW'

    def complete(self, result: dict) -> str:
        if not isinstance(result, dict):
            raise Conflict('result must be object')
        task_id = _text(result.get('task_id'), 'task_id')
        operation = _text(result.get('operation'), 'operation')
        status = result.get('status')
        if (not isinstance(status, str) or status not in TERMINAL or result.get('node_uid') != self.node_uid
                or result.get('schema') != 'ghostfleet-node-task/v0'):
            raise Conflict('invalid status/node')
        sha = digest(result)
        body = canonical({'task_id':task_id,'operation':operation,'result':result,'result_digest':sha})
        if len(body.encode('utf-8')) > MAX_BODY_BYTES:
            raise Conflict('result body too large')
        with self._transaction() as db:
            row = self.get(task_id)
            if row is None:
                raise Conflict('durable fence required')
            if row['node_uid'] != self.node_uid or row['operation'] != operation:
                raise Conflict('fence identity mismatch')
            if row['delivery_state'] != 'NONE':
                if row['result_digest'] == sha:
                    return 'DUPLICATE'
                raise Conflict('one task cannot acquire a second terminal digest')
            db.execute("UPDATE tasks SET execution_state=?,delivery_state='PENDING',result_body=?,result_digest=?,updated_at=? WHERE task_id=?",
                       (status,body,sha,time.time(),task_id))
        return 'PENDING'

    def recover(self, make_unknown: Callable[[dict], dict]) -> int:
        """Recover only this identity's fenced tasks, no repeat execution."""
        ids = [r[0] for r in self.db.execute("SELECT task_id FROM tasks WHERE node_uid=? AND delivery_state='NONE' ORDER BY task_id",(self.node_uid,))]
        for task_id in ids:
            with self._transaction() as db:
                row = self.get(task_id)
                if row['delivery_state'] != 'NONE':
                    continue
                result = make_unknown(row)
                if not isinstance(result,dict) or result.get('status') != 'UNKNOWN':
                    raise Conflict('recovery must produce UNKNOWN')
                body = canonical({'task_id':task_id,'operation':row['operation'],'result':result,'result_digest':digest(result)})
                candidate = dict(row,execution_state='UNKNOWN',delivery_state='PENDING',result_body=body,result_digest=digest(result))
                self._validate(candidate)
                db.execute("UPDATE tasks SET execution_state='UNKNOWN',delivery_state='PENDING',result_body=?,result_digest=?,updated_at=? WHERE task_id=?",
                           (body,candidate['result_digest'],time.time(),task_id))
        return len(ids)

    def pending(self) -> list[dict]:
        rows = self.db.execute("SELECT * FROM tasks WHERE node_uid=? AND delivery_state='PENDING' ORDER BY created_at,task_id LIMIT ?",
                               (self.node_uid,self.max_pending))
        return [self._validate(dict(row)) for row in rows]

    def ack(self, task_id: str, sha: str) -> None:
        with self._transaction() as db:
            row = self.get(task_id)
            if row is None or row['node_uid'] != self.node_uid or row['result_digest'] != sha:
                raise Conflict('ACK identity/digest mismatch')
            if row['delivery_state'] == 'ACKED':
                return
            if row['delivery_state'] != 'PENDING':
                raise Conflict('ACK requires PENDING')
            db.execute("UPDATE tasks SET delivery_state='ACKED',result_body=NULL,updated_at=? WHERE task_id=?",(time.time(),task_id))

    def quarantine(self, task_id: str, reason: str) -> None:
        _text(reason,'reason')
        with self._transaction() as db:
            if self.get(task_id) is None:
                raise Conflict('missing task')
            db.execute("UPDATE tasks SET delivery_state='QUARANTINED',reason=?,updated_at=? WHERE task_id=? AND delivery_state!='ACKED'",(reason,time.time(),task_id))

    def quarantine_foreign(self) -> int:
        with self._transaction() as db:
            cur = db.execute("UPDATE tasks SET delivery_state='QUARANTINED',reason='node_uid_changed',updated_at=? WHERE node_uid!=? AND delivery_state IN ('NONE','PENDING')",(time.time(),self.node_uid))
            return cur.rowcount

    def record_attempt(self, task_id: str) -> None:
        with self._transaction() as db:
            db.execute("UPDATE tasks SET delivery_attempts=delivery_attempts+1,updated_at=? WHERE task_id=? AND delivery_state='PENDING'",(time.time(),task_id))

    def backup(self, destination: str | Path) -> None:
        target=Path(destination).absolute()
        _private(target.parent,directory=True)
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); os.close(fd)
        backup = sqlite3.connect(target)
        try:
            self.db.backup(backup)
            if backup.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
                raise RepositoryError('backup integrity failed')
        finally:
            backup.close()

    def import_legacy(self, directory: str | Path, source_node_uid: str) -> int:
        """Explicit offline import of a stopped v0 JSON store, preserving sources.

        Read three original files, verify matching hashes inside the transaction,
        import rows and a receipt together. Never rename/delete the originals.
        A terminal row with no body is NOT assumed ACKED. Invalid/mismatched or
        duplicate bodies reject the whole import; do not guess a replacement hash.
        Unknown per-task-record schemas require a separately reviewed importer.
        """
        root=Path(directory).absolute(); _private(root,directory=True)
        _text(source_node_uid,'source_node_uid')
        if (root/'tasks').exists():
            raise Conflict('per-task JSON import needs exact published schema')
        def unique(pairs):
            obj={}
            for key,value in pairs:
                if key in obj: raise Conflict('duplicate JSON key')
                obj[key]=value
            return obj
        schemas={'ledger.json':'ghostfleet-node-agent-ledger/v0',
                 'outbox.json':'ghostfleet-node-agent-outbox/v0',
                 'tombstones.json':'ghostfleet-node-agent-tombstones/v0'}
        sources={}; documents={}
        for name, schema in schemas.items():
            path=root/name
            if not path.exists(): continue
            _private(path)
            if path.stat().st_size>8*1024*1024: raise Conflict('legacy file too large')
            data=path.read_bytes(); sources[name]=hashlib.sha256(data).hexdigest()
            try: doc=json.loads(data,object_pairs_hook=unique)
            except (ValueError, UnicodeError) as exc: raise Conflict('invalid legacy JSON') from exc
            if not isinstance(doc,dict) or doc.get('schema')!=schema: raise Conflict('legacy schema mismatch')
            documents[name]=doc
        if 'ledger.json' not in sources: raise Conflict('missing legacy ledger')
        manifest=canonical({'source_node_uid':source_node_uid,'files':sources})
        source_key=hashlib.sha256(manifest.encode()).hexdigest()
        ledger=documents['ledger.json'].get('entries')
        tombs=documents.get('tombstones.json',{}).get('entries',{})
        items=documents.get('outbox.json',{}).get('items',[])
        dropped=documents.get('outbox.json',{}).get('dropped',[])
        if not isinstance(ledger,dict) or not isinstance(tombs,dict) or not isinstance(items,list) or not isinstance(dropped,list):
            raise Conflict('legacy shape invalid')
        entries=dict(ledger)
        for task_id,entry in tombs.items():
            if task_id in entries: raise Conflict('ledger/tombstone overlap requires reconciliation')
            entries[task_id]=entry
        bodies={}
        for item in items:
            if not isinstance(item,dict) or not isinstance(item.get('body'),dict): raise Conflict('invalid legacy item')
            task_id=_text(item.get('task_id'),'task_id')
            if task_id in bodies: raise Conflict('duplicate legacy task')
            if item.get('digest') != digest(item['body']): raise Conflict('legacy wrapper digest mismatch')
            bodies[task_id]=item['body']
        if set(bodies)-set(entries) or set(dropped)-set(entries):
            raise Conflict('legacy body/drop without authoritative execution record')
        records=[]
        for task_id,entry in entries.items():
            if not isinstance(entry,dict): raise Conflict('invalid legacy record')
            state=entry.get('state'); operation=entry.get('operation')
            if not isinstance(state,str) or state not in TERMINAL|{FENCED}: raise Conflict('invalid legacy state')
            _text(operation,'operation'); _text(task_id,'task_id')
            body=bodies.get(task_id); sha=entry.get('result_digest')
            delivery='NONE' if state==FENCED else 'QUARANTINED'
            reason=None if state==FENCED else 'legacy_delivery_unproven'
            if body is not None:
                if state==FENCED: raise Conflict('legacy fenced task with body is ambiguous')
                delivery='PENDING'; reason=None
            if task_id in dropped or entry.get('result_state')=='RESULT_DROPPED':
                delivery='QUARANTINED'; reason='legacy_result_dropped'
            if source_node_uid!=self.node_uid:
                delivery='QUARANTINED'; reason='node_uid_changed'
            row={'task_id':task_id,'node_uid':source_node_uid,'operation':operation,
                 'attempt':entry.get('attempt',1),'execution_state':state,'delivery_state':delivery,
                 'result_body':canonical(body) if body is not None else None,'result_digest':sha,'reason':reason}
            if type(row['attempt']) is not int or row['attempt']<1: raise Conflict('invalid legacy attempt')
            self._validate(row); records.append(row)
        with self._transaction() as db:
            for name,sha in sources.items():
                if hashlib.sha256((root/name).read_bytes()).hexdigest()!=sha:
                    raise Conflict('legacy source changed during import')
            if db.execute('SELECT 1 FROM imports WHERE source_key=?',(source_key,)).fetchone(): return 0
            if db.execute('SELECT 1 FROM tasks LIMIT 1').fetchone(): raise Conflict('import target not empty')
            now=time.time()
            for row in records:
                db.execute('''INSERT INTO tasks(task_id,node_uid,operation,attempt,execution_state,delivery_state,result_body,result_digest,reason,created_at,updated_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?)''',tuple(row[k] for k in ('task_id','node_uid','operation','attempt','execution_state','delivery_state','result_body','result_digest','reason'))+(now,now))
            db.execute('INSERT INTO imports VALUES(?,?,?)',(source_key,manifest,now))
        return len(records)
