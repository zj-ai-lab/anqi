const PARTY_ROLES = new Set(['当事人', '对方当事人']);
// 「法院 / 检察院 / 看守所」这类通称会命中所有同类案件，只制造假候选；必须带上具体名称才算线索。
// （2026-10-13 真模型验收：模型把「去法院阅卷」的「法院」当办案机关传入，命中了所有民事案。）
const GENERIC_AGENCY = new Set([
  '法院', '人民法院', '中院', '基层法院', '检察院', '人民检察院', '公安', '公安局', '派出所',
  '看守所', '监狱', '仲裁委', '仲裁委员会', '司法局',
]);
const CANDIDATE_FIELDS = [
  'id', 'name', 'case_no', 'client', 'opponent', 'court', 'handling_agency',
  'case_type', 'procedure', 'stage',
];

function norm(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, '');
}

function hintsArray(value) {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map(norm).filter((item) => item.length >= 2);
}

function containsEither(field, hint) {
  const f = norm(field);
  return f.length >= 2 && (f.includes(hint) || hint.includes(f));
}

function matchSets({ cases, contacts, hints, active }) {
  const rows = (Array.isArray(cases) ? cases : []).filter((row) => active ? row?.status === 'active' : row?.status !== 'active');
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const contactNames = new Map();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    if (!PARTY_ROLES.has(contact?.role)) continue;
    const id = Number(contact.case_id);
    if (!byId.has(id)) continue;
    const name = norm(contact.name);
    if (name.length < 2) continue;
    if (!contactNames.has(id)) contactNames.set(id, []);
    contactNames.get(id).push(name);
  }
  const partyHints = hintsArray([...(Array.isArray(hints?.parties) ? hints.parties : hints?.parties ? [hints.parties] : []), hints?.case_name]);
  // 同一条事里点名的当事人要「同时」满足：取命中线索最多的案件，而不是任一沾边就算。
  // 例：「张三诉孙七那个案子」→ 只认同时含张三与孙七的案件；只说「张三」才在张三名下各案间并列。
  // （2026-10-13 真模型验收：并集口径把「张三诉孙七」与「张三诉李四」并列成候选，白问一次。）
  const party = new Set();
  if (partyHints.length) {
    const coverage = new Map();
    for (const row of rows) {
      const fields = [row.name, row.client, row.opponent, ...(contactNames.get(Number(row.id)) || [])];
      const hits = partyHints.filter((hint) => fields.some((field) => containsEither(field, hint))).length;
      if (hits > 0) coverage.set(Number(row.id), hits);
    }
    const best = Math.max(0, ...coverage.values());
    for (const [id, hits] of coverage) if (hits === best) party.add(id);
  }
  const caseNoHint = norm(hints?.case_no);
  const caseNo = new Set();
  if (caseNoHint.length >= 2) {
    const exact = rows.filter((row) => norm(row.case_no).length >= 2 && norm(row.case_no) === caseNoHint);
    const source = exact.length ? exact : rows.filter((row) => containsEither(row.case_no, caseNoHint));
    for (const row of source) caseNo.add(Number(row.id));
  }
  const agencyHints = hintsArray(hints?.agency).filter((hint) => !GENERIC_AGENCY.has(hint));
  const agency = new Set();
  if (agencyHints.length) {
    for (const row of rows) {
      const fields = [row.court, row.handling_agency];
      if (agencyHints.some((hint) => fields.some((field) => containsEither(field, hint)))) agency.add(Number(row.id));
    }
  }
  const sets = [party, caseNo, agency].filter((set) => set.size > 0);
  const union = new Set(sets.flatMap((set) => [...set]));
  let intersection = new Set();
  if (sets.length) {
    intersection = new Set([...sets[0]].filter((id) => sets.every((set) => set.has(id))));
  }
  return { rows, party, caseNo, agency, sets, union, intersection };
}

export function matchCaseByHints({ cases = [], contacts = [], hints = {} } = {}) {
  const active = matchSets({ cases, contacts, hints, active: true });
  const inactive = matchSets({ cases, contacts, hints, active: false });
  const match = active.intersection.size === 1
    ? 'unique'
    : active.union.size === 0 ? 'none' : 'multiple';
  // A unique intersection is the only authoritative grant target. In that
  // case do not let an additional broad hint leave unrelated union rows ahead
  // of the actual intersection member in the returned candidate list.
  const candidateIds = match === 'unique' ? active.intersection : active.union;
  const candidates = active.rows
    .filter((row) => candidateIds.has(Number(row.id)))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || Number(b.id) - Number(a.id))
    .slice(0, 10)
    .map((row) => Object.fromEntries(CANDIDATE_FIELDS.map((field) => [field, row[field] ?? ''])));
  return {
    match,
    candidates,
    inactive_hits: inactive.union.size,
    conflict: active.union.size > 0 && active.intersection.size === 0,
  };
}

export { CANDIDATE_FIELDS };
