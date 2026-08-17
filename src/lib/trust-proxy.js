const DEFAULT_TRUST_PROXY = Object.freeze(['loopback', 'linklocal', 'uniquelocal']);

export function resolveTrustProxy(raw) {
  if (raw === undefined || raw === '') return DEFAULT_TRUST_PROXY;
  const value = String(raw).trim();
  if (value === 'true') {
    throw new Error('ANJIAN_TRUST_PROXY 不得设为 true；请填写明确 hop 数或 CIDR');
  }
  if (value === 'false' || value === '0') return false;
  if (/^[1-9]\d*$/.test(value)) {
    const hops = Number(value);
    if (hops > 10) throw new Error('ANJIAN_TRUST_PROXY hop 数不得大于 10');
    return hops;
  }
  const entries = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!entries.length) throw new Error('ANJIAN_TRUST_PROXY 不能为空');
  return entries;
}
