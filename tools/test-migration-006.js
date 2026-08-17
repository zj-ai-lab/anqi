// 006 升级测试：先用真实 001–005 建 fixture，再由真实 runner 升到 006。
// 覆盖：严格入队边界、旧台账业务字段不变、完整性检查，以及 DDL + user_version 原子回滚。
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(rootDir, 'src', 'migrations');
const MIGRATIONS_001_005 = [
  '001_init.sql',
  '002_fees_sessions.sql',
  '003_attachments_legalrag.sql',
  '004_contacts.sql',
  '005_fee_shares.sql',
];
const MIGRATION_006 = '006_share_repairs.sql';
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-006-'));
let fixture;
let failing;
let bootstrap;
let runMigrations;

try {
  // 载入实际 runner；其模块启动用隔离库，避免碰调用者传入的 DB_PATH。
  process.env.DB_PATH = path.join(scratchDir, 'bootstrap.db');
  ({ db: bootstrap, runMigrations } = await import('../src/db.js'));
  bootstrap.close();

  // 真实 005 fixture：文件名白名单固定 001–005，未来 migration 不得改变起点。
  const legacyDir = path.join(scratchDir, 'migrations-005');
  fs.mkdirSync(legacyDir);
  for (const file of MIGRATIONS_001_005) {
    fs.copyFileSync(path.join(migrationsDir, file), path.join(legacyDir, file));
  }
  const upgradeDir = path.join(scratchDir, 'migrations-006');
  fs.mkdirSync(upgradeDir);
  for (const file of [...MIGRATIONS_001_005, MIGRATION_006]) {
    fs.copyFileSync(path.join(migrationsDir, file), path.join(upgradeDir, file));
  }

  fixture = new Database(path.join(scratchDir, 'from-005.db'));
  fixture.pragma('foreign_keys = ON');
  runMigrations(fixture, legacyDir);
  assert.equal(fixture.pragma('user_version', { simple: true }), 5, 'fixture 必须停在真实 005');

  const caseOne = fixture
    .prepare("INSERT INTO cases (name, procedure, stage) VALUES ('示例案（张三）', '一审', '待裁判')")
    .run().lastInsertRowid;
  const caseTwo = fixture
    .prepare("INSERT INTO cases (name, procedure, stage) VALUES ('示例案（李四）', '一审', '待裁判')")
    .run().lastInsertRowid;
  const paidFee = fixture
    .prepare("INSERT INTO fee_items (case_id, label, amount, status, paid_on) VALUES (?, '已收款', 1000, 'paid', '2026-07-15')")
    .run(caseOne).lastInsertRowid;
  const flatAgreement = fixture
    .prepare("INSERT INTO fee_share_agreements (case_id, direction, counterpart, flat_amount) VALUES (?, 'payable', '王五', 200)")
    .run(caseOne).lastInsertRowid;

  const insertShare = fixture.prepare(
    `INSERT INTO fee_shares
       (case_id, external_case, agreement_id, fee_item_id, direction, counterpart, base_amount, amount, due_month, status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const attachedId = insertShare.run(caseOne, '', null, paidFee, 'payable', '王五', null, 100, '2026-07', 'settled', '已挂来源').lastInsertRowid;
  const orphanId = insertShare.run(caseOne, '', null, null, 'payable', '赵六', null, 300, '2026-07', 'settled', '待人工判断').lastInsertRowid;
  const externalId = insertShare.run(null, '外部示例案', null, null, 'receivable', '孙七', null, 400, '2026-07', 'settled', '外部案').lastInsertRowid;
  const fixedId = insertShare.run(caseOne, '', flatAgreement, null, 'payable', '王五', null, 200, '2026-07', 'settled', '固定额约定').lastInsertRowid;
  const basedId = insertShare.run(caseOne, '', null, null, 'payable', '孙七', 1200, 360, '2026-07', 'settled', '已有基数').lastInsertRowid;
  const pendingId = insertShare.run(caseTwo, '', null, null, 'payable', '周八', null, 500, '2026-07', 'pending', '尚未结清').lastInsertRowid;
  const negativeId = insertShare.run(caseTwo, '', null, null, 'payable', '赵六', null, -30, '2026-07', 'settled', '退款冲抵待判断').lastInsertRowid;

  const legacySnapshot = fixture.prepare(
    `SELECT id, case_id, external_case, agreement_id, fee_item_id, direction, counterpart,
            base_amount, amount, due_month, status, settled_on, note
       FROM fee_shares ORDER BY id`
  ).all();

  // 从真实 005 升到真实 006；只应对两个满足严格谓词的案件内 settled 行入队。
  runMigrations(fixture, upgradeDir);
  assert.equal(fixture.pragma('user_version', { simple: true }), 6, '升级后 user_version 应为 6');
  assert.deepEqual(
    fixture.prepare(
      'SELECT fee_share_id, issue_code, status, proposed_fee_item_id, resolution_note, exception_reason, resolved_at, version FROM share_repair_queue ORDER BY fee_share_id'
    ).all(),
    [
      { fee_share_id: Number(orphanId), issue_code: 'legacy_settled_unlinked', status: 'open', proposed_fee_item_id: null, resolution_note: '', exception_reason: '', resolved_at: '', version: 1 },
      { fee_share_id: Number(negativeId), issue_code: 'legacy_settled_unlinked', status: 'open', proposed_fee_item_id: null, resolution_note: '', exception_reason: '', resolved_at: '', version: 1 },
    ],
    '只有案件内、已结清、无来源/约定/基数的正负历史行入队'
  );
  assert.deepEqual(
    fixture.prepare(
      `SELECT id, case_id, external_case, agreement_id, fee_item_id, direction, counterpart,
              base_amount, amount, due_month, status, settled_on, note
         FROM fee_shares ORDER BY id`
    ).all(),
    legacySnapshot,
    '006 不得改写任何既有分成的业务字段'
  );
  assert.deepEqual(
    fixture.prepare('SELECT id, is_void, voided_at, void_reason FROM fee_shares ORDER BY id').all(),
    [attachedId, orphanId, externalId, fixedId, basedId, pendingId, negativeId].map((id) => ({ id: Number(id), is_void: 0, voided_at: '', void_reason: '' })),
    '既有行只获得安全默认作废字段'
  );
  assert.deepEqual(fixture.pragma('foreign_key_check'), [], '006 升级后 foreign_key_check 必须为空');
  assert.equal(fixture.pragma('integrity_check', { simple: true }), 'ok', '006 升级后 integrity_check 必须为 ok');

  // runner 原子性：失败 migration 中先执行 DDL 再报错，DDL 与 user_version 都不可半提交。
  const failureDir = path.join(scratchDir, 'migrations-failure');
  fs.mkdirSync(failureDir);
  fs.writeFileSync(path.join(failureDir, '001_initial.sql'), 'CREATE TABLE atomic_probe (id INTEGER);\n');
  fs.writeFileSync(path.join(failureDir, '002_failure.sql'), 'CREATE TABLE partial_probe (id INTEGER);\nTHIS IS INVALID SQL;\n');
  failing = new Database(path.join(scratchDir, 'atomicity.db'));
  assert.throws(() => runMigrations(failing, failureDir), /near "THIS"|syntax error/i, '故意损坏 migration 必须失败');
  assert.equal(failing.pragma('user_version', { simple: true }), 1, '失败 migration 不得推进 user_version');
  assert.ok(failing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='atomic_probe'").get(), '已提交的前一 migration 保留');
  assert.equal(failing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='partial_probe'").get(), undefined, '失败 migration 的 DDL 必须回滚');

  console.log('migration 006 tests: 005 fixture + strict queue + integrity + atomic rollback all passed');
} finally {
  fixture?.close();
  failing?.close();
  if (bootstrap?.open) bootstrap.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
