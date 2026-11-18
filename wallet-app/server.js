// تشغيل:  ADMIN_KEY=كلمة_سر_قوية node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = '770131581';
const ADMIN_KEY = process.env.ADMIN_KEY || 'بو شنب'; // يمكن تغييرها بمتغير البيئة ADMIN_KEY
const BIG = 99999999999999;
const DATA_DIR = process.env.DATA_DIR || __dirname; // على الاستضافة: مجلد القرص الدائم
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
const PK = [[100,'512 ميجا'],[200,'1 جيجا'],[300,'1.5 جيجا'],[500,'2.5 جيجا'],[1000,'5 جيجا'],[2000,'10 جيجا'],[3000,'15 جيجا'],[5000,'25 جيجا'],[10000,'50 جيجا']];
let db = { users: [], devices: {}, sessions: {}, cards: [], txs: [], recharges: [], loans: [], tickets: [], notifs: [], bans: {}, seq: 1 };
// التخزين: إذا وُجد DATABASE_URL (قاعدة PostgreSQL مجانية مثل Neon) تُحفظ البيانات فيها، وإلا في ملف data.json
const DATABASE_URL = process.env.DATABASE_URL;
const UPSERT = "INSERT INTO kv (k, v) VALUES ('db', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v";
let pool = null, pending = false, writing = false;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }, max: 3 });
}
async function flush() {
  if (writing) return;
  writing = true;
  try { while (pending) { pending = false; await pool.query(UPSERT, [JSON.stringify(db)]); } }
  catch (e) { console.error('DB save failed:', e.message); pending = true; setTimeout(flush, 3000); }
  writing = false;
}
const save = () => { if (!pool) return fs.writeFileSync(DB_FILE, JSON.stringify(db)); pending = true; flush(); };
async function init() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v text NOT NULL)');
    const r = await pool.query("SELECT v FROM kv WHERE k = 'db'");
    if (r.rows[0]) db = Object.assign(db, JSON.parse(r.rows[0].v));
    console.log('Storage: PostgreSQL');
  } else {
    try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
    console.log('Storage: file ' + DB_FILE);
  }
}
process.on('SIGTERM', async () => { try { if (pool) await pool.query(UPSERT, [JSON.stringify(db)]); } catch {} process.exit(0); });
const hash = (p, s) => crypto.createHash('sha256').update(s + p).digest('hex');
const now = () => new Date().toISOString();
const pub = u => ({ id: u.id, name: u.name, phone: u.phone, email: u.email, balance: u.balance, points: u.points, role: u.role,
  unread: db.notifs.filter(n => n.id > (u.seenId || 0) && (n.to === null || n.to === u.id)).length });
const tx = (u, type, amount, note) => { db.txs.push({ uid: u.id, type, amount, note, at: now(), bal: u.balance }); };
const err = (msg, code) => ({ ok: false, msg, code });
const BAN_MS = 5 * 60 * 1000, wf = {};
const banKey = b => 'dev:' + (b.deviceId || b._ip);
function addBan(b, reason) {
  db.bans[banKey(b)] = { until: Date.now() + BAN_MS, reason }; save();
  return { ok: false, code: 'BAN', msg: `تم حظرك لمدة 5 دقائق. السبب: ${reason}`, left: BAN_MS / 1000 };
}
function banCheck(b) {
  const x = db.bans[banKey(b)];
  if (x && x.until > Date.now()) return { ok: false, code: 'BAN', msg: `أنت محظور مؤقتاً. السبب: ${x.reason}`, left: Math.ceil((x.until - Date.now()) / 1000) };
  return null;
}
const banned = u => ({ ok: false, code: 'BANNED', msg: 'تم حظر حسابك من قبل الإدارة. السبب: ' + u.banned.reason });
function nameProblem(b, name) {
  if (/[0-9٠-٩]/.test(name)) return addBan(b, 'إدخال أرقام داخل الاسم الرباعي');
  if (/[^\u0600-\u06FFa-zA-Z\s.,،'\-]/.test(name)) return addBan(b, 'إدخال رموز غير مسموحة داخل الاسم الرباعي');
  if (/(.)\1{3,}/u.test(name)) return addBan(b, 'تكرار الأحرف بشكل مصطنع في الاسم الرباعي');
  const w = name.split(/\s+/);
  if (w.length >= 4 && new Set(w.map(x => x.toLowerCase())).size === 1) return addBan(b, 'تكرار الكلمة نفسها في الاسم الرباعي');
  if (name.length > 80) return addBan(b, 'اسم رباعي أطول من المعقول');
  if (w.length < 4) return err('أدخل الاسم الرباعي كاملاً');
  return null;
}
const fails = {};
function checkAdmin(b, what) {
  const f = fails[b._ip] || (fails[b._ip] = { n: 0, until: 0 }), g = fails['*'] || (fails['*'] = { n: 0, until: 0 });
  if (Date.now() < f.until || Date.now() < g.until) return err('محاولات خاطئة كثيرة. حاول بعد 15 دقيقة');
  if (!b.adminKey) return err(what === 'reg' ? 'هذا رقم الإدارة ولا يمكنك التسجيل به إلا بإدخال كلمة السر' : 'هذا حساب الإدارة ولا يمكنك الدخول إلا بإدخال كلمة السر', 'ADMIN');
  if (String(b.adminKey).trim() !== ADMIN_KEY) { if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 9e5; } if (++g.n >= 10) { g.n = 0; g.until = Date.now() + 9e5; } return err('كلمة السر غير صحيحة', 'ADMIN'); }
  f.n = 0; return null;
}

const R = {
  'POST /api/register'(b) {
    const bc = banCheck(b); if (bc) return bc;
    const email = (b.email || '').trim().toLowerCase(), phone = (b.phone || '').trim(), name = (b.name || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return err('البريد الإلكتروني غير صحيح');
    if (!/^7\d{8}$/.test(phone)) return err('رقم الهاتف يجب أن يكون 9 أرقام ويبدأ بـ 7');
    const np = nameProblem(b, name); if (np) return np;
    if ((b.password || '').length < 6) return err('كلمة المرور 6 أحرف على الأقل');
    if (b.password !== b.confirm) return err('تأكيد كلمة المرور غير مطابق');
    if (phone === ADMIN_PHONE) { const e = checkAdmin(b, 'reg'); if (e) return e; }
    if (db.users.some(u => u.email === email || u.phone === phone)) return err('هذا الرقم أو البريد مسجل لدينا مسبقاً، انتقل إلى صفحة تسجيل الدخول', 'EXISTS');
    const admin = phone === ADMIN_PHONE;
    if (!admin && db.devices[b.deviceId]) return err('هذا الجهاز مسجل بحساب مسبق', 'DEVICE');
    const salt = crypto.randomBytes(8).toString('hex');
    const u = { id: db.seq++, email, phone, name, salt, pass: hash(b.password, salt), role: admin ? 'admin' : 'user',
      balance: admin ? BIG : 0, points: admin ? BIG : 0, lastWheel: 0, seenId: db.seq - 1, createdAt: now() };
    db.users.push(u);
    if (!admin) db.devices[b.deviceId] = u.id;
    return login(u);
  },
  'POST /api/login'(b) {
    const bc = banCheck(b); if (bc) return bc;
    const email = (b.email || '').trim().toLowerCase();
    const u = db.users.find(x => x.email === email);
    if (!u) return err('هذا البريد غير مسجل، انتقل إلى صفحة إنشاء حساب', 'NOUSER');
    if (u.role === 'admin') { const e = checkAdmin(b, 'login'); if (e) return e; }
    const wk = email + '|' + (b.deviceId || b._ip);
    if (u.name !== (b.name || '').trim()) {
      const f = wf[wk] = (wf[wk] || 0) + 1;
      if (f >= 5) { wf[wk] = 0; return addBan(b, 'محاولات متكررة بإدخال اسم رباعي غير مطابق للحساب'); }
      return err(`الاسم غير مطابق لما سُجّل سابقاً. انتبه للفواصل والنقاط (متبقي ${5 - f} محاولات)`);
    }
    delete wf[wk];
    if (u.banned) return banned(u);
    if (u.role !== 'admin') {
      const owner = db.devices[b.deviceId];
      if (owner && owner !== u.id) return err('هذا الجهاز مسجل بحساب مسبق', 'DEVICE');
      if (!owner) db.devices[b.deviceId] = u.id;
    }
    return login(u);
  },
  'GET /api/me'(b, u) { return { ok: true, user: pub(u) }; },
  'GET /api/packages'() {
    return { ok: true, packages: PK.map(([p, label]) => ({ id: p, label, price: p * 0.9, old: p, stock: db.cards.filter(c => c.pkg === p && !c.owner).length })) };
  },
  'POST /api/buy'(b, u) {
    const pkg = PK.find(x => x[0] === +b.pkg), qty = parseInt(b.qty, 10);
    if (!pkg) return err('الباقة غير موجودة');
    if (!(qty >= 1 && qty <= 50)) return err('الكمية يجب أن تكون 1 أو أكثر (حتى 50)');
    const free = db.cards.filter(c => c.pkg === pkg[0] && !c.owner);
    if (free.length < qty) return err('الكمية المطلوبة غير متوفرة. المتوفر: ' + free.length);
    const total = pkg[0] * 0.9 * qty;
    if (u.balance < total) return err(`رصيدك غير كافٍ. المطلوب ${total} ريال ورصيدك ${u.balance} ريال`);
    u.balance -= total;
    const got = free.slice(0, qty);
    got.forEach(c => { c.owner = u.id; c.at = now(); });
    tx(u, 'buy', total, `شراء ${qty} × باقة ${pkg[0]}`);
    save();
    return { ok: true, msg: 'تمت العملية', codes: got.map(c => c.code), balance: u.balance };
  },
  'GET /api/mycards'(b, u) {
    return { ok: true, cards: db.cards.filter(c => c.owner === u.id).map(c => ({ pkg: c.pkg, code: c.code, at: c.at })).reverse() };
  },
  'POST /api/loan'(b, u) {
    const act = db.loans.find(l => l.uid === u.id && !l.settled);
    if (act) return err(`عليك سلفة سابقة غير مسددة (${act.amount} ريال). سدّدها بشحن رصيدك ليُخصم المبلغ تلقائياً، وبعدها يمكنك طلب سلفة جديدة.`, 'LOAN');
    const last = [...db.txs].reverse().find(t => t.uid === u.id && (t.type === 'buy' || t.type === 'recharge'));
    if (!last || last.amount < 5000) return err('خدمة السلفة (1000 ريال) متاحة فقط إذا كانت آخر معاملة لك 5000 ريال أو أكثر');
    u.balance += 1000;
    db.loans.push({ uid: u.id, amount: 1000, settled: false, at: now() });
    tx(u, 'loan', 1000, 'سلفة طارئة');
    save();
    return { ok: true, msg: 'تمت إضافة 1000 ريال، ستُخصم تلقائياً عند أول شحن', balance: u.balance };
  },
  'POST /api/transfer'(b, u) {
    const amt = +b.amount, to = db.users.find(x => x.phone === (b.phone || '').trim());
    if (!to) return err('رقم المستلم غير مسجل');
    if (to.id === u.id) return err('لا يمكنك التحويل لنفسك');
    if (!(amt > 0)) return err('أدخل مبلغاً صحيحاً');
    if (u.balance < amt) return err('رصيدك غير كافٍ');
    u.balance -= amt; to.balance += amt;
    tx(u, 'transfer_out', amt, 'تحويل إلى ' + to.phone);
    tx(to, 'transfer_in', amt, 'تحويل من ' + u.phone);
    save();
    return { ok: true, msg: 'تم التحويل', balance: u.balance };
  },
  'POST /api/recharge'(b, u) {
    const amt = +b.amount;
    if (!(amt > 0)) return err('أدخل المبلغ الذي حولته بالضبط');
    db.recharges.push({ id: db.seq++, uid: u.id, name: u.name, phone: u.phone, amount: amt, status: 'pending', at: now() });
    save();
    return { ok: true, msg: 'تم إرسال الطلب وسيُراجع قريباً' };
  },
  'POST /api/wheel'(b, u) {
    if (Date.now() - u.lastWheel < 864e5) return err('يمكنك الدوران مرة كل 24 ساعة');
    const prizes = [0, 5, 5, 10, 10, 20, 50];
    const p = prizes[crypto.randomInt(prizes.length)];
    u.lastWheel = Date.now(); u.balance += p;
    if (p) tx(u, 'prize', p, 'جائزة عجلة الحظ');
    save();
    return { ok: true, prize: p, balance: u.balance };
  },
  'GET /api/wheel'(b, u) { return { ok: true, left: Math.max(0, u.lastWheel + 864e5 - Date.now()) }; },
  'GET /api/loan'(b, u) {
    const mine = db.loans.filter(l => l.uid === u.id), act = mine.find(l => !l.settled);
    const last = [...db.txs].reverse().find(t => t.uid === u.id && (t.type === 'buy' || t.type === 'recharge'));
    return { ok: true, active: !!act, amount: act ? act.amount : 0, eligible: !!(last && last.amount >= 5000),
      history: mine.slice().reverse().map(l => ({ amount: l.amount, settled: l.settled, at: l.at })) };
  },
  'GET /api/statement'(b, u, q) {
    let list = db.txs.filter(t => t.uid === u.id);
    if (q.from) list = list.filter(t => t.at >= q.from);
    if (q.to) list = list.filter(t => t.at <= q.to + 'T23:59:59');
    return { ok: true, txs: list.reverse() };
  },
  'POST /api/ticket'(b, u) {
    const title = String(b.title || '').trim().slice(0, 100), body = String(b.body || '').trim().slice(0, 1000);
    if (!title || !body) return err('اكتب عنوان المشكلة وتفاصيلها');
    db.tickets.push({ id: db.seq++, uid: u.id, name: u.name, phone: u.phone, title, body, at: now(), replies: [] });
    save();
    return { ok: true, msg: 'تم إرسال التذكرة وسيتم الرد عليك هنا' };
  },
  'GET /api/tickets'(b, u) { return { ok: true, tickets: db.tickets.filter(t => t.uid === u.id).reverse() }; },
  'GET /api/admin/tickets'() { return { ok: true, list: db.tickets.slice().reverse().slice(0, 50) }; },
  'POST /api/admin/reply'(b) {
    const t = db.tickets.find(x => x.id === +b.id), text = String(b.text || '').trim().slice(0, 1000);
    if (!t) return err('التذكرة غير موجودة');
    if (!text) return err('اكتب الرد أولاً');
    t.replies.push({ text, at: now() });
    save();
    return { ok: true, msg: 'تم إرسال الرد' };
  },
  'POST /api/profile'(b, u) {
    const bc = banCheck(b); if (bc) return bc;
    if (hash(b.password || '', u.salt) !== u.pass) return err('كلمة المرور الحالية غير صحيحة');
    const name = String(b.name || '').trim();
    const np = nameProblem(b, name); if (np) return np;
    u.name = name; save();
    return { ok: true, msg: 'تم حفظ الاسم. استخدمه الآن في تسجيل الدخول.' };
  },
  'POST /api/password'(b, u) {
    if (hash(b.old || '', u.salt) !== u.pass) return err('كلمة المرور الحالية غير صحيحة');
    if (String(b.password || '').length < 6) return err('كلمة المرور الجديدة 6 أحرف على الأقل');
    if (b.password !== b.confirm) return err('تأكيد كلمة المرور غير مطابق');
    u.salt = crypto.randomBytes(8).toString('hex'); u.pass = hash(b.password, u.salt); save();
    return { ok: true, msg: 'تم تغيير كلمة المرور' };
  },
  'GET /api/notifs'(b, u) {
    const list = db.notifs.filter(n => n.to === null || n.to === u.id).reverse().slice(0, 50);
    u.seenId = db.seq - 1; save();
    return { ok: true, list };
  },
  'GET /api/admin/users'() {
    return { ok: true, list: db.users.slice(-300).reverse().map(x => ({ id: x.id, name: x.name, phone: x.phone, email: x.email, balance: x.balance, role: x.role, banned: x.banned || null })) };
  },
  'POST /api/admin/notify'(b) {
    const text = String(b.text || '').trim().slice(0, 500);
    if (!text) return err('اكتب نص الإشعار');
    let to = null;
    if (b.uid) { const t = db.users.find(x => x.id === +b.uid); if (!t) return err('المستخدم غير موجود'); to = t.id; }
    db.notifs.push({ id: db.seq++, to, text, at: now() }); save();
    return { ok: true, msg: to ? 'تم إرسال التنبيه للمستخدم' : 'تم إرسال الإشعار لجميع المستخدمين' };
  },
  'POST /api/admin/ban'(b) {
    const t = db.users.find(x => x.id === +b.uid);
    if (!t) return err('المستخدم غير موجود');
    if (t.role === 'admin') return err('لا يمكن حظر حساب الإدارة');
    if (b.unban) { delete t.banned; save(); return { ok: true, msg: 'تم رفع الحظر' }; }
    const reason = String(b.reason || '').trim().slice(0, 200);
    if (!reason) return err('اكتب سبب الحظر');
    t.banned = { reason, at: now() };
    for (const k in db.sessions) if (db.sessions[k] === t.id) delete db.sessions[k];
    save();
    return { ok: true, msg: 'تم حظر المستخدم' };
  },
  'GET /api/admin/pending'(b, u) { return { ok: true, list: db.recharges.filter(r => r.status === 'pending') }; },
  'POST /api/admin/approve'(b, u) {
    const r = db.recharges.find(x => x.id === +b.id && x.status === 'pending');
    if (!r) return err('الطلب غير موجود');
    const t = db.users.find(x => x.id === r.uid);
    let amt = r.amount;
    const loan = db.loans.find(l => l.uid === t.id && !l.settled);
    if (loan) { const d = Math.min(loan.amount, amt); amt -= d; loan.settled = true; tx(t, 'loan_repay', d, 'سداد السلفة'); }
    t.balance += amt; r.status = 'approved';
    tx(t, 'recharge', r.amount, 'شحن رصيد');
    save();
    return { ok: true, msg: 'تم الشحن' };
  },
  'POST /api/admin/cards'(b, u) {
    const pkg = +b.pkg; if (!PK.some(x => x[0] === pkg)) return err('باقة غير صحيحة');
    const codes = String(b.codes || '').split(/\s+/).filter(Boolean);
    codes.forEach(code => db.cards.push({ id: db.seq++, pkg, code, owner: null }));
    save();
    return { ok: true, msg: `أُضيف ${codes.length} كرت` };
  },
};
function login(u) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id; save();
  return { ok: true, token, user: pub(u) };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  let body = '';
  req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    const send = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
    try {
      const key = req.method + ' ' + url.pathname, h = R[key];
      if (!h) return send(err('غير موجود'));
      let u = null;
      if (!/\/(login|register|packages)$/.test(url.pathname)) {
        const t = (req.headers.authorization || '').replace('Bearer ', '');
        u = db.users.find(x => x.id === db.sessions[t]);
        if (!u) return send(err('انتهت الجلسة، سجّل الدخول مجدداً', 'AUTH'));
        if (u.banned) return send(banned(u));
        if (url.pathname.startsWith('/api/admin/') && u.role !== 'admin') return send(err('غير مصرح'));
      }
      const b = body ? JSON.parse(body) : {}; b._ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      send(h(b, u, Object.fromEntries(url.searchParams)));
    } catch (e) { console.error(e); send(err('خطأ في الخادم')); }
  });
});
init().then(() => server.listen(PORT, () => console.log('http://localhost:' + PORT))).catch(e => { console.error('Startup failed:', e); process.exit(1); });
