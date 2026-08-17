import { Router } from 'express';
import { audit } from '../db.js';
import {
  verifyLoginCredentials, createSession, destroySession,
  loginLimiter, recordLoginFail, clearLoginFail,
} from '../middleware/auth.js';

const r = Router();
let warnedLegacyHash = false;

r.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const passwordResult = verifyLoginCredentials(username, password);
  if (!passwordResult.ok) {
    recordLoginFail(req._loginKey);
    audit('anon', 'login-fail', 'session', null, req._loginIp);
    return res.status(401).json({ error: '用户名或密码不对' });
  }
  clearLoginFail(req._loginKey);
  if (passwordResult.legacy && !warnedLegacyHash) {
    warnedLegacyHash = true;
    console.warn(
      '⚠ ANJIAN_PASS_HASH 仍为 legacy salt:hash；请运行 `read -s -p "Password: " P; '
      + 'printf "\\n"; ANJIAN_PASSWORD="$P" node tools/hash-password.js; unset P`，更新 env 后重启。'
    );
  }
  createSession(res, req);
  audit(process.env.ANJIAN_USER || 'web', 'login', 'session', null, req._loginIp);
  res.json({ ok: true });
});

r.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

export default r;
