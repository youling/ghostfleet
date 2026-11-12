#!/usr/bin/env python3
"""Rootless SQLite feasibility probe; all writes stay in a new private temp dir.

SIGKILL tests process recovery, NOT power-loss durability. SQLITE_FULL is injected
with max_page_count, not by filling a host disk. No services/accounts are changed.
Run: python3 tools/probe_sqlite.py --parent /local/private/scratch --iterations 1000
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

_CHILD = '''import os,signal,sqlite3,sys
c=sqlite3.connect(sys.argv[1],isolation_level=None)
c.execute('PRAGMA synchronous='+sys.argv[2])
c.execute('BEGIN IMMEDIATE')
c.execute('INSERT INTO events VALUES (?,?)',(sys.argv[3],'durable'))
if sys.argv[4]=='after': c.execute('COMMIT')
os.kill(os.getpid(),signal.SIGKILL)
'''


def probe(root: Path, iterations: int) -> dict:
    with sqlite3.connect(':memory:') as info:
        source_id=info.execute('SELECT sqlite_source_id()').fetchone()[0]
    try:
        filesystem=subprocess.check_output(['findmnt','-no','FSTYPE','-T',str(root)],text=True).strip()
    except (OSError,subprocess.CalledProcessError):
        filesystem='UNKNOWN'
    if filesystem in ('nfs','nfs4','cifs','smb3','9p') or filesystem.startswith('fuse'):
        raise RuntimeError('use a verified local filesystem; not a shared mount')
    report={'schema':'ghostfleet.sqlite-spike/v1','python':sys.version.split()[0],
            'sqlite':sqlite3.sqlite_version,'source_id':source_id,'filesystem':filesystem,
            'modes':[],'limits':['SIGKILL is process-crash evidence, not a physical power cut',
              'SQLITE_FULL uses max_page_count, not real disk exhaustion',
              'WAL test is single-writer and makes no claim about concurrent checkpoint races']}
    for mode,sync in [('DELETE','EXTRA'),('WAL','FULL')]:
        path=root/(mode.lower()+'.db')
        c=sqlite3.connect(path,isolation_level=None,timeout=.1)
        journal=c.execute('PRAGMA journal_mode='+mode).fetchone()[0]
        c.execute('PRAGMA synchronous='+sync); c.execute('PRAGMA foreign_keys=ON')
        c.execute('CREATE TABLE events(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        start=time.monotonic()
        for i in range(iterations):
            c.execute('BEGIN IMMEDIATE'); c.execute('INSERT INTO events VALUES (?,?)',(str(i),'payload')); c.execute('COMMIT')
        elapsed=time.monotonic()-start
        crash=[]
        for boundary in ('before','after'):
            key='kill-'+boundary
            run=subprocess.run([sys.executable,'-c',_CHILD,str(path),sync,key,boundary],capture_output=True,timeout=15)
            assert run.returncode == -signal.SIGKILL
            seen=c.execute('SELECT count(*) FROM events WHERE id=?',(key,)).fetchone()[0]
            assert seen==int(boundary=='after')
            crash.append({'boundary':boundary,'row_present':bool(seen)})
        c.execute('BEGIN IMMEDIATE'); other=sqlite3.connect(path,isolation_level=None,timeout=.05)
        try:
            other.execute('BEGIN IMMEDIATE'); raise AssertionError('second writer not blocked')
        except sqlite3.OperationalError as error:
            assert error.sqlite_errorcode==sqlite3.SQLITE_BUSY
        finally:
            other.close();c.execute('ROLLBACK')
        b=sqlite3.connect(root/(mode.lower()+'.backup.db'))
        try:
            c.backup(b)
            assert b.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
            assert b.execute('SELECT * FROM events ORDER BY id').fetchall()==c.execute('SELECT * FROM events ORDER BY id').fetchall()
        finally:
            b.close()
        pragmas={'journal_mode':journal,'synchronous':c.execute('PRAGMA synchronous').fetchone()[0],
                 'foreign_keys':c.execute('PRAGMA foreign_keys').fetchone()[0]}
        c.close(); c=sqlite3.connect(path)
        assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert c.execute('SELECT count(*) FROM events').fetchone()[0]==iterations+1
        c.close()
        ro=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)
        try:
            ro.execute("INSERT INTO events VALUES('forbidden','x')")
            raise AssertionError('read-only write succeeded')
        except sqlite3.OperationalError as error:
            assert error.sqlite_errorcode==sqlite3.SQLITE_READONLY
        finally:
            ro.close()
        full=sqlite3.connect(root/(mode.lower()+'.full.db'),isolation_level=None)
        full.execute('PRAGMA journal_mode='+mode);full.execute('PRAGMA synchronous='+sync)
        full.execute('CREATE TABLE t(value BLOB)')
        pages=full.execute('PRAGMA page_count').fetchone()[0]
        full.execute('PRAGMA max_page_count='+str(pages+2))
        try:
            full.execute('BEGIN IMMEDIATE');full.execute('INSERT INTO t VALUES(zeroblob(1048576))');full.execute('COMMIT')
            raise AssertionError('size limit was not enforced')
        except sqlite3.OperationalError as error:
            assert error.sqlite_errorcode==sqlite3.SQLITE_FULL
            if full.in_transaction:full.execute('ROLLBACK')
        assert full.execute('SELECT count(*) FROM t').fetchone()[0]==0
        assert full.execute('PRAGMA integrity_check').fetchone()[0]=='ok';full.close()
        assert path.stat().st_mode&0o777==0o600
        report['modes'].append({'mode':mode,'sync':sync,'pragmas':pragmas,'transactions':iterations,
          'elapsed_seconds':round(elapsed,4),'crash_tests':crash,'second_writer_busy':True,
          'read_only_write_rejected':True,'capacity_failure_atomic':True,'backup_rows_equal':True,
          'integrity_check':'ok','database_mode':'0600'})
    report['overall']='PASS'
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parent',type=Path,required=True)
    parser.add_argument('--iterations',type=int,default=1000)
    args=parser.parse_args()
    if os.name!='posix' or not 1<=args.iterations<=10000:
        parser.error('requires POSIX and 1..10000 iterations')
    os.umask(0o077)
    root=Path(tempfile.mkdtemp(prefix='ghostfleet-sqlite-probe-',dir=args.parent))
    report=probe(root,args.iterations)
    report['probe_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (root/'results.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'results_dir':str(root),'report':report}))

if __name__=='__main__':main()
