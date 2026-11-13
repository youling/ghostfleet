# Node Agent SQLite persistence / 节点代理 SQLite 持久化

Status: INTEGRATED_CANDIDATE; child PR #84 exact-head independent review PASS; parent PR #83 integrated-head CI 6/6 SUCCESS; fresh parent exact-head review and Human release gate remain required.
状态：已集成到父 PR 候选；子 PR #84 精确版本独立审查通过，父 PR #83 集成 HEAD CI 六项全绿；父 PR 新精确版本独立审查与人类发布门仍未完成。
Base: PR #83 source `8975b7259c20b03e280755af32b0c5dad17653b4`.

## Decision / 决策

Use Python sqlite3 and one local task database instead of JSON ledger, outbox,
tombstones, per-task records, and append/unlink archive segments. This supersedes
the earlier per-task JSON design, not its task-integrity requirements. systemd
continues to own service lifecycle, restart and stop deadlines; journald owns
stdout/stderr retention. The HTTP client, task allowlist, authentication and
non-root privilege split are retained, not replaced by another framework.

任务事实只存 `tasks.db`，不再自研跨文件事务、JSONL 归档或第二套任务数据库。
任务正文只有一份。Python `state.json` 仅保留启动序号、健康与观测统计，不承担
任务是否执行/结果是否送达的权威判断，不能用它重建丢失的任务历史。

## Storage contract / 存储契约

- Python >=3.10, SQLite >=3.37 (STRICT tables), POSIX flock; state on local disk.
- `journal_mode=DELETE`, `synchronous=EXTRA`, `foreign_keys=ON`, explicit
  `BEGIN IMMEDIATE` and COMMIT; no HTTP while a transaction is open.
- Database directory 0700; DB and lock file 0600, same effective UID, no symlink.
- A lifetime OS lock prevents a second daemon from treating the first one's live
  execution fence as a crashed task. SQLite write locking alone cannot do that.
- `MAY_HAVE_EXECUTED` is committed before the executor. Terminal state, canonical
  body, result digest and PENDING are committed together.
- Restart turns an unfinished fence into one UNKNOWN result; never rerun it.
- ACK removes the body only after explicit server acceptance. Lost HTTP response
  leaves the same body/digest pending; the server must absorb the duplicate.
- Permanent protocol rejection and foreign identity quarantine the original body,
  digest, operation and node identity. No silent DROP or automatic rehash.
- 64 pending/fenced tasks triggers backpressure, not eviction. ACKED rows remain
  compact replay tombstones without a 4096-record cliff. DB size is bounded at
  64 MiB by default; disk/page exhaustion is a real fail-closed capacity gate,
  not a claim of unlimited retention. Automated retention is not implemented.
- SQL write/commit ambiguity closes the connection. The loop emits STOPPING and
  exits nonzero; systemd restarts and reloads durable truth, never a stale cache.

DELETE+EXTRA is selected for this single-writer low-volume process, not because
WAL is unsafe in general. Both modes passed the disposable comparison. EXTRA
adds directory synchronization after rollback-journal deletion. WAL introduces
sidecars/checkpointing and is unnecessary for this workload; no runtime mode
conversion is allowed. SIGKILL and max_page_count tests are not physical power
loss or an actual full host disk.

## Migration and backup / 迁移与备份

A new DB beside legacy ledger/outbox/tombstones/tasks refuses startup. Offline
`TaskRepository.import_legacy(source, source_node_uid)` imports into an explicitly
created empty destination. Original files are hashed, read again before commit,
and never renamed/deleted. All imported rows and the hash/count identity receipt
commit together. Retry of the same manifest is idempotent. Ambiguous duplicate,
corrupt schema or mismatched digest rejects the entire import; a terminal record
without proven delivery is quarantined, never guessed ACKED. Per-task JSON has
not been published in the reviewed base; its importer is not invented.

现有试验数据原地保留；停服务、备份、离线导入、读回验证、再明确切换目录。
不静默清空，不自动寻找别处的旧数据。备份使用 SQLite Connection.backup；
不对运行中的数据库直接 cp。旧 binary 不得拿新 DB 当空 ledger 启动。

## Code boundary / 代码边界

`repository.py`: SQL schema, transitions, body validation, explicit migration,
backup, read-only status. `sqlite_loop.py`: existing loop integration and SQL
pending delivery. `delivery.py`: report data only. `loop.py`: networking,
observation and systemd lifecycle orchestration. CLI defaults to SQLite only.
`ledger.py` and `outbox.py` are removed, with no JSON fallback.

## Test mapping / 测试迁移

Backend-specific JSON tests are replaced, not skipped:

| Previous concern | New evidence |
| --- | --- |
| ledger/outbox commit order and retract/drop windows | `test_repository.py`: result+delivery atomic commit; commit error reload; SIGKILL before/after commit |
| replay tombstones / overflow | >4096 ACKED rows; pending+fence capacity; no eviction; heartbeat continues without polling |
| legacy unknown body repair | explicit importer validates canonical digest; mismatches reject whole import, no invented replacement result |
| malformed status / duplicate task identity | bad []/{} status rejection; operation/schema/node mismatch; duplicate import rejection |
| ACK response loss | `test_sqlite_loop.py`: resend exact body/digest; ACK commit failure retains pending result |
| permanent rejection / old node identity | QUARANTINED preserves original body/digest; quarantine commit failure preserves pending |
| process ownership and read-only status | `test_repository_runtime_gate.py`: lifetime flock, SIGKILL lock release, status leaves DB bytes unchanged |
| signal / Retry-After / flush budget | existing lifecycle tests retained and reconnected to SQL; no weakened deadline assertions |

The root disposable harness now injects an explicit SQLite fence with schema
and application-id assertions and reads back UNKNOWN/ACKED plus original time.
This edited root harness is NOT claimed locally executed by the rootless probe.

## Reproduce / 复现

```sh
cd packages/node-agent
python3 tools/build_pyz.py --out dist/node-agent.pyz
python3 -m pytest -q
python3 tools/probe_sqlite.py --parent /path/to/private-local-scratch --iterations 1000
python3 tools/probe_sqlite_systemd.py --parent /path/to/private-local-scratch
```

The last probe requires the current user's existing systemd manager and creates
only an owned transient unit. It runs the built pyz via `python3 -I`, not a fake
Agent implementation. It stops its unit in finally. No accounts, Linger policy,
host restart, production token, Cloudflare or NAS are touched.

## Observed candidate evidence / 候选实测

Debian 13, Python 3.13.5, SQLite 3.46.1, systemd 257.13, local ext4:
534 Python tests passed, zero skips (milestone-1 rerun). DELETE+EXTRA and WAL+FULL each passed
1000 commits, before/after-commit SIGKILL, second-writer busy, read-only refusal,
injected SQLITE_FULL rollback, backup equality and integrity_check.
Built pyz: `3ee59187c94c20072e59335017fd8df0ce0cb610c1502af69915fca5be9ca036`.
Rootless transient user service: real useful self-test, advancing watchdog,
SIGKILL -> one restart, original ACKED task not repeated, clean stop 0.029s,
zero new requests after stop. These numbers are one environment's measurements,
not service-level guarantees. Sanitized machine-readable evidence is adjacent.

NOT_PROVEN: physical host reboot, full production Cloudflare/DO, OMV8 hardware,
independent useful-work consumer outside the disposable harness, fresh parent PR #83
exact-head review, protected release merge and production authorization. The child
PR #84 independent review is PASS; it does not approve the whole parent PR.

## Primary references / 一手依据

- SQLite PRAGMA synchronous and journal mode: https://sqlite.org/pragma.html
- SQLite atomic commit assumptions: https://sqlite.org/atomiccommit.html
- SQLite WAL tradeoffs: https://sqlite.org/wal.html
- Python sqlite3 explicit transactions and backup: https://docs.python.org/3.13/library/sqlite3.html

## Test migration milestone / 测试迁移检查点

`NODE_AGENT_SQLITE_TEST_MIGRATION.json` maps all 58 retired test functions to concrete SQLite tests.
The mapping distinguishes preserved invariants from intentionally retired automatic
drop/eviction/rebuild behavior. The independent exact-head review of child PR #84 verified
58/58 mappings, zero dangling targets, and the 40 equivalent-invariant / 18 deliberate
preserve-or-quarantine policy split. The review is scoped to PR #84; parent PR #83 still
requires a fresh exact-head integration review.
已补齐鉴权失败保留正文、顺序 ACK、预算包含本地提交、停止后不发送、
执行栅栏失败零执行、超大正文保留栅栏、缺失任务身份零写入。
本轮全量结果为 534 passed / 0 failed / 0 skipped。旧测试数量不冒充新覆盖，
外部硬件与完整 disposable 验收仍按 NOT_PROVEN 清单执行。
