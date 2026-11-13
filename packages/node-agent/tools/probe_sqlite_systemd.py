#!/usr/bin/env python3
"""Exercise candidate SQLite loop in an owned transient systemd user unit.

Runs only synthetic localhost work as the current user. No Linger changes,
accounts, production credentials, host reboot or persistent unit installation.
Requires a running systemd user manager; NOT a substitute for target acceptance.
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
import threading
import time
import uuid

PACKAGE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(PACKAGE/'src'))
sys.path.insert(0,str(PACKAGE/'tests'))
os.environ['GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP']='1'
from ghostfleet_agent.config import load_config
from ghostfleet_agent.cli import install_signal_handlers,verify_token_trust,verify_config_trust
from ghostfleet_agent.sqlite_loop import build_loop
from ghostfleet_agent.logging import get_logger
from agent_test_support import AgentSandbox,FakeControlPlane,TEST_TOKEN,make_task


def run(args):
    p=subprocess.run(args,capture_output=True,text=True,timeout=35)
    if p.returncode:
        raise RuntimeError(str(args)+': '+p.stderr)
    return p.stdout


def child(config_path):
    config=load_config(config_path)
    node=json.loads(Path(config.node_meta_path).read_text())['node_uid']
    verify_token_trust(config.token_path);verify_config_trust(config_path)
    loop=build_loop(config,TEST_TOKEN,node)
    stop=threading.Event();install_signal_handlers(stop,get_logger());loop.bind_stop_event(stop)
    loop.reconcile()
    return loop.run_forever(stop_event=stop)


def probe(parent):
    root=Path(tempfile.mkdtemp(prefix='ghostfleet-sqlite-systemd-',dir=parent))
    unit='ghostfleet-sqlite-probe-'+uuid.uuid4().hex[:12]
    sandbox=AgentSandbox(root/'agent');plane=FakeControlPlane();plane.start()
    sandbox.write_config(plane.url)
    plane.poll_tasks=[make_task(node_uid=sandbox.node_uid,task_id='task-systemd-useful',operation='agent.self.test')]
    runtime=Path('/run/user')/str(os.geteuid())
    if not runtime.is_dir() or runtime.stat().st_uid!=os.geteuid() or not (runtime/'bus').is_socket():
        raise RuntimeError('current user manager bus is unavailable; no manager will be started')
    os.environ['XDG_RUNTIME_DIR']=str(runtime)
    os.environ['DBUS_SESSION_BUS_ADDRESS']='unix:path='+str(runtime/'bus')
    started=False
    evidence={'schema':'ghostfleet.sqlite-systemd/v1','scope':'rootless transient user service; synthetic localhost control plane','unit':unit}
    def status():
        out=run(['systemctl','--user','show',unit,'--property=ActiveState,SubState,MainPID,NRestarts,Result,ExecMainStatus,InvocationID,WatchdogTimestampMonotonic'])
        return dict(line.split('=',1) for line in out.splitlines() if '=' in line)
    def wait(condition,seconds=20):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if condition():return
            time.sleep(.2)
        raise RuntimeError('probe condition deadline')
    try:
        started=True  # cleanup even if the run command times out after unit creation
        run(['systemd-run','--user','--unit='+unit,'--property=Type=notify','--property=NotifyAccess=main',
             '--property=Restart=on-failure','--property=RestartSec=1','--property=WatchdogSec=60',
             '--property=TimeoutStopSec=30','--property=RuntimeMaxSec=90','--property=NoNewPrivileges=true',
             '--property=MemoryMax=256M','--property=TasksMax=32','--setenv=GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP=1',sys.executable,'-I',str(PACKAGE/'dist/node-agent.pyz'),'--config',str(sandbox.config_path),'run'])
        started=True
        wait(lambda:status().get('ActiveState')=='active')
        wait(lambda:len(plane.requests_to('/result'))==1)
        initial=status();first=plane.requests_to('/result')[0]['body']['result_digest']
        # Observe notification advancement, not merely a configured WatchdogSec.
        wait(lambda:int(status()['WatchdogTimestampMonotonic'])>int(initial['WatchdogTimestampMonotonic']),30)
        evidence['before_crash']=status();old_pid=evidence['before_crash']['MainPID']
        run(['systemctl','--user','kill','--kill-whom=main','--signal=SIGKILL',unit])
        wait(lambda:status().get('ActiveState')=='active' and status().get('MainPID') not in ('0',old_pid),25)
        wait(lambda:len(plane.requests_to('/tasks/poll'))>=2)
        evidence['after_crash']=status()
        assert len(plane.requests_to('/result'))==1,'ACKED task repeated after restart'
        c=sqlite3.connect((sandbox.state_dir/'tasks.db').as_uri()+'?mode=ro',uri=True)
        try:
            row=c.execute('SELECT execution_state,delivery_state,result_body,result_digest FROM tasks WHERE task_id=?',('task-systemd-useful',)).fetchone()
        finally:c.close()
        assert row==('SUCCEEDED','ACKED',None,first)
        count=len(plane.records);start=time.monotonic();run(['systemctl','--user','stop',unit])
        evidence['stop_seconds']=round(time.monotonic()-start,3)
        evidence['after_stop']=status();evidence['requests_after_stop_command']=len(plane.records)-count
        assert evidence['after_stop']['ActiveState']=='inactive' and evidence['after_stop']['ExecMainStatus']=='0'
        assert evidence['requests_after_stop_command']==0
        evidence['result_post_count']=len(plane.requests_to('/result'))
        evidence['database_terminal_state']=row[1]
        evidence['systemd_version']=run(['systemctl','--version']).splitlines()[0]
        evidence['pyz_sha256']=hashlib.sha256((PACKAGE/'dist/node-agent.pyz').read_bytes()).hexdigest()
        evidence['entrypoint']='python3 -I <pinned pyz> --config <synthetic config> run'
        evidence['overall']='PASS'
        evidence['not_proven']=['distinct managed account','Linger enablement','host reboot','production Cloudflare','OMV8 hardware','full shipped sandbox policy']
        (root/'journal.log').write_text(run(['journalctl','--user','-u',unit,'--no-pager','-n','200','-o','cat']))
        (root/'results.json').write_text(json.dumps(evidence,indent=2)+'\n')
        return {'results_dir':str(root),'report':evidence}
    finally:
        if started:
            subprocess.run(['systemctl','--user','stop',unit],capture_output=True,timeout=35)
            subprocess.run(['systemctl','--user','reset-failed',unit],capture_output=True,timeout=5)
        plane.stop()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parent',type=Path)
    parser.add_argument('--child')
    args=parser.parse_args()
    if args.child:return child(args.child)
    if not args.parent:parser.error('--parent is required')
    if os.geteuid()==0:parser.error('this probe intentionally runs as a normal user')
    print(json.dumps(probe(args.parent)))
    return 0

if __name__=='__main__':raise SystemExit(main())
