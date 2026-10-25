const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signToken(payload, secret, ttlMs = 7 * 24 * 3600 * 1000) {
  const body = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + ttlMs
  };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(data).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || payload.exp < Date.now()) return null;
  return payload;
}

function authMiddleware(store) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token, store.secret);
    if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
    const user = store.findById(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: '账号不可用' });
    req.user = user;
    req.token = token;
    next();
  };
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

module.exports = { signToken, verifyToken, authMiddleware, adminMiddleware };
