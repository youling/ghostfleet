import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from ghostfleet_agent.repository import TaskRepository, Conflict, Capacity, RepositoryError, canonical, digest

NODE='node-synthetic'

def result(task='task-1',node=NODE,status='SUCCEEDED',operation='node.observe'):
    return {'schema':'ghostfleet-node-task/v0','task_id':task,'node_uid':node,
            'operation':operation,'status':status,'data':{'uptime':17},'observed_at':'2026-01-01T00:00:00Z'}

class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name); self.path=self.root/'tasks.db'
        self.repo=TaskRepository(self.path,NODE)
    def tearDown(self):
        self.repo.close(); self.tmp.cleanup()
    def make_pending(self, task='task-1'):
        self.assertEqual(self.repo.begin(task,'node.observe'),'NEW'); self.repo.complete(result(task))
    def reopen(self):
        self.repo.close(); self.repo=TaskRepository(self.path,NODE)
    def test_pragmas_and_permissions(self):
        self.assertEqual(self.repo.db.execute('pragma journal_mode').fetchone()[0],'delete')
        self.assertEqual(self.repo.db.execute('pragma synchronous').fetchone()[0],3)
        self.assertEqual(self.path.stat().st_mode&0o777,0o600)
    def test_result_and_delivery_commit_together(self):
        self.make_pending(); self.reopen(); row=self.repo.get('task-1')
        self.assertEqual(row['execution_state'],'SUCCEEDED'); self.assertEqual(row['delivery_state'],'PENDING')
        self.assertEqual(row['result_digest'],digest(row['body']['result']))
    def test_lost_http_ack_keeps_same_body_then_ack(self):
        self.make_pending(); original=self.repo.pending()[0]['result_body']
        self.reopen(); resent=self.repo.pending()[0]
        self.assertEqual(original,resent['result_body'])
        self.repo.ack('task-1',resent['result_digest']); self.reopen()
        self.assertEqual(self.repo.get('task-1')['delivery_state'],'ACKED')
        self.assertIsNone(self.repo.get('task-1')['body'])
        self.repo.ack('task-1',resent['result_digest'])
        self.assertEqual(self.repo.begin('task-1','node.observe'),'ALREADY_DONE')
    def test_ack_wrong_digest_cannot_remove_body(self):
        self.make_pending()
        with self.assertRaises(Conflict): self.repo.ack('task-1','0'*64)
        self.assertEqual(len(self.repo.pending()),1)
    def test_terminal_digest_is_immutable(self):
        self.make_pending(); before=self.repo.get('task-1')
        with self.assertRaises(Conflict): self.repo.complete(result(status='UNKNOWN'))
        self.assertEqual(self.repo.get('task-1'),before)
        self.assertEqual(self.repo.complete(result()),'DUPLICATE')
    def test_unknown_recovery_is_atomic_and_not_reexecution(self):
        self.repo.begin('task-1','node.observe'); self.reopen()
        self.assertEqual(self.repo.recover(lambda row:result(status='UNKNOWN')),1)
        body=self.repo.get('task-1')['result_body']; self.reopen()
        self.assertEqual(self.repo.recover(lambda row: self.fail('recovered twice')),0)
        self.assertEqual(body,self.repo.get('task-1')['result_body'])
    def test_bad_status_types_never_typeerror(self):
        self.repo.begin('task-1','node.observe')
        for bad in ([],{},None,1,'bad'):
            with self.subTest(bad=bad), self.assertRaises(Conflict): self.repo.complete(result(status=bad))
        self.assertEqual(self.repo.get('task-1')['delivery_state'],'NONE')
    def test_wrong_node_schema_and_operation(self):
        self.repo.begin('task-1','node.observe')
        for r in [result(node='node-other'),result(operation='agent.self.test'),dict(result(),schema='foreign')]:
            with self.assertRaises(Conflict): self.repo.complete(r)
    def test_capacity_includes_execution_fences_and_never_evicts(self):
        self.repo.max_pending=2; self.make_pending('task-1'); self.repo.begin('task-2','node.observe')
        with self.assertRaises(Capacity): self.repo.begin('task-3','node.observe')
        self.assertIsNone(self.repo.get('task-3')); self.assertIsNotNone(self.repo.get('task-1')['body'])
        self.repo.ack('task-1',digest(result())); self.assertEqual(self.repo.begin('task-3','node.observe'),'NEW')
    def test_more_than_4096_tombstones_does_not_stop_node(self):
        # One transaction for fixture population; this is not a throughput benchmark.
        with self.repo._transaction() as db:
            db.executemany("INSERT INTO tasks(task_id,node_uid,operation,attempt,execution_state,delivery_state,result_digest,created_at,updated_at) VALUES(?,?,?,1,'SUCCEEDED','ACKED',?,0,0)",
                           [(f'task-old-{i}',NODE,'node.observe','a'*64) for i in range(5000)])
        self.assertEqual(self.repo.begin('task-new','node.observe'),'NEW')
        self.assertEqual(self.repo.begin('task-old-1','node.observe'),'ALREADY_DONE')
    def test_foreign_identity_quarantines_without_rehash_or_delete(self):
        self.make_pending(); old=self.repo.get('task-1'); self.repo.close()
        self.repo=TaskRepository(self.path,'node-new'); self.assertEqual(self.repo.quarantine_foreign(),1)
        row=self.repo.get('task-1'); self.assertEqual(row['result_body'],old['result_body']); self.assertEqual(row['result_digest'],old['result_digest'])
        self.assertEqual(row['node_uid'],NODE); self.assertEqual(row['delivery_state'],'QUARANTINED'); self.assertEqual(self.repo.pending(),[])
        with self.assertRaises(Conflict):self.repo.begin('task-1','node.observe')
    def test_no_auto_delete_quarantine(self):
        self.make_pending(); self.repo.quarantine('task-1','server_conflict'); self.reopen()
        self.assertIsNotNone(self.repo.get('task-1')['body']); self.assertEqual(self.repo.pending(),[])
    def test_busy_closes_connection_and_preserves_fence(self):
        self.repo.begin('task-1','node.observe'); other=sqlite3.connect(self.path,isolation_level=None)
        other.execute('BEGIN IMMEDIATE'); self.repo.db.execute('pragma busy_timeout=5')
        with self.assertRaises(RepositoryError): self.repo.complete(result())
        other.execute('ROLLBACK'); other.close()
        with self.assertRaises(RepositoryError): self.repo.pending()
        self.reopen(); self.assertEqual(self.repo.get('task-1')['delivery_state'],'NONE')
    def test_capacity_full_sql_failure_is_atomic(self):
        self.repo.begin('task-1','node.observe')
        pages=self.repo.db.execute('pragma page_count').fetchone()[0]; self.repo.db.execute(f'pragma max_page_count={pages}')
        r=result(); r['data']={'blob':'x'*60000}
        with self.assertRaises(RepositoryError): self.repo.complete(r)
        self.reopen(); self.assertEqual(self.repo.get('task-1')['delivery_state'],'NONE')
    def test_write_exception_before_commit_is_not_published(self):
        self.repo.begin('task-1','node.observe')
        def fault(point):
            if point=='before_commit':raise OSError('synthetic I/O failure')
        self.repo._fault=fault
        with self.assertRaises(RepositoryError):self.repo.complete(result())
        with self.assertRaises(RepositoryError):self.repo.get('task-1')
        self.reopen();self.assertEqual(self.repo.get('task-1')['delivery_state'],'NONE')
    def test_commit_then_error_requires_reload_not_rollback_assumption(self):
        self.repo.begin('task-1','node.observe')
        def fault(point):
            if point=='after_commit':raise OSError('synthetic postcommit failure')
        self.repo._fault=fault
        with self.assertRaises(RepositoryError):self.repo.complete(result())
        self.reopen();self.assertEqual(self.repo.get('task-1')['delivery_state'],'PENDING')
    def test_sigkill_before_and_after_result_commit(self):
        self.repo.close()
        child="""import os,signal,sys
from ghostfleet_agent.repository import TaskRepository
r=TaskRepository(sys.argv[1],sys.argv[2])
r.begin(sys.argv[3],'node.observe')
def fault(p):
 if p==sys.argv[4]:os.kill(os.getpid(),signal.SIGKILL)
r._fault=fault
r.complete({'schema':'ghostfleet-node-task/v0','task_id':sys.argv[3],'node_uid':sys.argv[2],'operation':'node.observe','status':'SUCCEEDED'})
"""
        for index,boundary in enumerate(['before_commit','after_commit']):
            task=f'task-kill-{index}'
            p=subprocess.run([sys.executable,'-c',child,str(self.path),NODE,task,boundary], timeout=10, env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'src')})
            self.assertEqual(p.returncode,-signal.SIGKILL)
            r=TaskRepository(self.path,NODE); self.assertEqual(r.get(task)['delivery_state'],'NONE' if boundary=='before_commit' else 'PENDING'); r.close()
        self.repo=TaskRepository(self.path,NODE)
    def test_corrupt_body_is_rejected_not_repaired(self):
        self.make_pending(); self.repo.db.execute("UPDATE tasks SET result_body='{}' WHERE task_id='task-1'"); self.repo.close()
        before=self.path.read_bytes()
        with self.assertRaises(Conflict):TaskRepository(self.path,NODE)
        self.assertEqual(before,self.path.read_bytes())
    def test_backup_roundtrip(self):
        self.make_pending();target=self.root/'copy.db';self.repo.backup(target)
        b=TaskRepository(target,NODE);self.assertEqual(b.get('task-1'),self.repo.get('task-1'));b.close()
    def test_symlink_and_open_directory_rejected(self):
        self.repo.close(); link=self.root/'link.db';link.symlink_to(self.path)
        with self.assertRaises(RepositoryError):TaskRepository(link,NODE)
        self.root.chmod(0o755)
        with self.assertRaises(RepositoryError):TaskRepository(self.path,NODE)
        self.root.chmod(0o700)
    def test_does_not_silently_reset_unknown_database(self):
        self.repo.close(); c=sqlite3.connect(self.root/'other.db');c.execute('create table foreign_data(x)');c.commit();c.close();(self.root/'other.db').chmod(0o600)
        with self.assertRaises(RepositoryError):TaskRepository(self.root/'other.db',NODE)
    def legacy(self):
        p=self.root/'legacy';p.mkdir(mode=0o700);r=result();body={'task_id':'task-1','operation':'node.observe','result':r,'result_digest':digest(r)}
        docs={'ledger.json':{'schema':'ghostfleet-node-agent-ledger/v0','entries':{'task-1':{'operation':'node.observe','state':'SUCCEEDED','attempt':1,'result_digest':digest(r)}}},
              'outbox.json':{'schema':'ghostfleet-node-agent-outbox/v0','items':[{'task_id':'task-1','digest':digest(body),'body':body}]}}
        for name,doc in docs.items():(p/name).write_text(canonical(doc));(p/name).chmod(0o600)
        return p
    def test_legacy_import_transaction_and_idempotence(self):
        p=self.legacy();before={f.name:f.read_bytes() for f in p.iterdir()}
        self.assertEqual(self.repo.import_legacy(p,NODE),1); self.assertEqual(self.repo.import_legacy(p,NODE),0)
        self.assertEqual(self.repo.get('task-1')['delivery_state'],'PENDING')
        self.assertEqual(before,{f.name:f.read_bytes() for f in p.iterdir()})
    def test_legacy_duplicate_aborts_without_writes(self):
        p=self.legacy(); doc=json.loads((p/'outbox.json').read_text());doc['items']*=2;(p/'outbox.json').write_text(canonical(doc))
        with self.assertRaises(Conflict):self.repo.import_legacy(p,NODE)
        self.assertEqual(self.repo.counts(),{})
    def test_legacy_mismatched_digest_aborts(self):
        p=self.legacy();doc=json.loads((p/'ledger.json').read_text());doc['entries']['task-1']['result_digest']='0'*64;(p/'ledger.json').write_text(canonical(doc))
        with self.assertRaises(Conflict):self.repo.import_legacy(p,NODE)
        self.assertEqual(self.repo.counts(),{})
    def test_legacy_receipt_and_rows_rollback_together(self):
        p=self.legacy()
        def fault(point):
            if point=='before_commit':raise OSError('synthetic interrupted migration')
        self.repo._fault=fault
        with self.assertRaises(RepositoryError):self.repo.import_legacy(p,NODE)
        self.reopen();self.assertEqual(self.repo.counts(),{});self.assertEqual(self.repo.db.execute('SELECT count(*) FROM imports').fetchone()[0],0)
        self.assertEqual(self.repo.import_legacy(p,NODE),1)
    def test_legacy_files_prevent_implicit_empty_database(self):
        p=self.legacy()
        with self.assertRaises(RepositoryError):TaskRepository(p/'tasks.db',NODE)

if __name__=='__main__': unittest.main(verbosity=2)
