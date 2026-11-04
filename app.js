'use strict';
/* Mis Finanzas — PWA multiusuario con Supabase.
   Seguridad: cuenta por persona (creada por el administrador), doble
   autenticación TOTP obligatoria y reglas RLS que exigen sesión con 2FA (aal2).
   Funciona sin internet: guarda una copia local y sincroniza al reconectar. */
(() => {
const CFG = window.FIN_CONFIG || {};
const SB = (CFG.supabaseUrl && CFG.supabaseKey && !/TU-PROYECTO|TU_CLAVE/.test(CFG.supabaseUrl + CFG.supabaseKey))
  ? { url: CFG.supabaseUrl.replace(/\/+$/, ''), key: CFG.supabaseKey } : null;

const CATEGORIAS = ['Comida', 'Supermercado', 'Bencina', 'Transporte', 'Hogar', 'Cuentas', 'Salud',
  'Entretención', 'Compras', 'Mascotas', 'Educación', 'Sueldo', 'Otros'];
const TIPOS = { gasto: 'Gasto', ingreso: 'Ingreso', transferencia: 'Transferencia', pago_tarjeta: 'Pago tarjeta' };
const MEDIOS = { debito: 'Débito', credito: 'Crédito', efectivo: 'Efectivo' };
const ICON = { gasto: '🧾', ingreso: '💰', transferencia: '↗️', pago_tarjeta: '💳' };
const CAT_ICON = { Bencina: '⛽', Comida: '🍔', Supermercado: '🛒', Transporte: '🚌', Hogar: '🏠', Cuentas: '📄',
  Salud: '💊', Entretención: '🎬', Compras: '🛍️', Mascotas: '🐾', Educación: '📚', Sueldo: '💰' };
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const TABS = { inicio: ['🏠', 'Inicio'], movimientos: ['📋', 'Movimientos'], atajos: ['⚡', 'Atajos'], ajustes: ['⚙️', 'Ajustes'] };

// ---------- utilidades
const $ = (s, el = document) => el.querySelector(s);
const uuid = () => crypto.randomUUID();
const fmtNum = n => Math.round(n || 0).toLocaleString('es-CL');
const clp = n => (n < 0 ? '-$' : '$') + fmtNum(Math.abs(n || 0));
const parseMonto = s => parseInt(String(s || '').replace(/\D/g, ''), 10) || 0;
const parseDec = s => parseFloat(String(s || '').replace(/\./g, '').replace(',', '.')) || 0;
function hoy() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function mesLabel(m) { const [y, mo] = m.split('-').map(Number); return `${MESES[mo - 1]} ${y}`; }
function shiftMes(m, d) { let [y, mo] = m.split('-').map(Number); mo += d; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return `${y}-${String(mo).padStart(2, '0')}`; }
function diaLabel(f) { const d = new Date(f + 'T12:00:00'); return d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' }); }
const isBencina = c => /bencina|combustible|nafta|gasolina/i.test(c || '');
const sum = arr => arr.reduce((a, x) => a + (+x.monto || 0), 0);
function group(arr, keyFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); const g = m.get(k) || [k, 0, 0]; g[1] += +x.monto || 0; g[2]++; m.set(k, g); }
  return [...m.values()].sort((a, b) => b[1] - a[1]);
}
function jwtPayload(t) { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } }

// ---------- IndexedDB (copia local para uso sin internet)
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mis-finanzas-v2', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('items', { keyPath: 'id' }); d.createObjectStore('meta'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  get(s, k) { return this.tx(s, 'readonly', st => st.get(k)); },
  all(s) { return this.tx(s, 'readonly', st => st.getAll()); },
  put(s, v, k) { return this.tx(s, 'readwrite', st => k === undefined ? st.put(v) : st.put(v, k)); },
  del(s, k) { return this.tx(s, 'readwrite', st => st.delete(k)); },
  clear(s) { return this.tx(s, 'readwrite', st => st.clear()); },
};

// ---------- Estado
const S = { items: new Map(), screen: 'loading', view: 'inicio', mes: hoy().slice(0, 7), session: null, syncMsg: '', mfa: null };

async function loadItems() {
  S.items = new Map();
  for (const r of await DB.all('items')) if (!r.deleted && r.data) S.items.set(r.id, r.data);
}
async function saveRaw(obj) {
  await DB.put('items', { id: obj.id, data: obj, deleted: false, dirty: true });
  S.items.set(obj.id, obj);
}
async function saveRec(obj) { obj.id = obj.id || uuid(); obj.mod = Date.now(); await saveRaw(obj); scheduleSync(); return obj; }
async function delRec(id) {
  await DB.put('items', { id, data: null, deleted: true, dirty: true, mod: Date.now() });
  S.items.delete(id); scheduleSync();
}
const movs = () => [...S.items.values()].filter(x => x.kind === 'mov');
const tpls = () => [...S.items.values()].filter(x => x.kind === 'tpl').sort((a, b) => (b.usos || 0) - (a.usos || 0) || a.nombre.localeCompare(b.nombre));
const delMes = m => movs().filter(x => (x.fecha || '').startsWith(m));

// ---------- Supabase Auth + REST (sin librerías externas)
class AuthError extends Error { constructor(m, status) { super(m); this.status = status; } }
const Cloud = {
  async auth(path, body, method = 'POST', token) {
    const h = { apikey: SB.key, 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(SB.url + '/auth/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new AuthError(traducir(j.msg || j.error_description || j.message || ('Error ' + r.status)), r.status);
    return j;
  },
  async store(j) {
    const p = jwtPayload(j.access_token);
    S.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      email: j.user?.email || S.session?.email || p.email, uid: p.sub, aal: p.aal };
    await DB.put('meta', S.session, 'session');
  },
  async signIn(email, password) { await this.store(await this.auth('token?grant_type=password', { email, password })); },
  async token() {
    if (!S.session) throw new AuthError('Sin sesión', 401);
    if (Date.now() > S.session.expires_at - 60000) await this.store(await this.auth('token?grant_type=refresh_token', { refresh_token: S.session.refresh_token }));
    return S.session.access_token;
  },
  async user() { return this.auth('user', null, 'GET', await this.token()); },
  async enroll() {
    return this.auth('factors', { factor_type: 'totp', friendly_name: 'Mis Finanzas ' + new Date().toISOString().slice(0, 16), issuer: 'Mis Finanzas' }, 'POST', await this.token());
  },
  async verify(factorId, code) {
    const t = await this.token();
    const ch = await this.auth(`factors/${factorId}/challenge`, {}, 'POST', t);
    await this.store(await this.auth(`factors/${factorId}/verify`, { challenge_id: ch.id, code }, 'POST', t));
  },
  async setPassword(password) { await this.auth('user', { password }, 'PUT', await this.token()); },
  async rest(path, opts = {}) {
    const t = await this.token();
    const r = await fetch(SB.url + '/rest/v1/' + path, { ...opts, headers: { apikey: SB.key, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new AuthError(j.message || ('Error ' + r.status), r.status); }
    const txt = await r.text(); return txt ? JSON.parse(txt) : null;
  },
  async signOut() { try { await fetch(SB.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB.key, Authorization: 'Bearer ' + S.session.access_token } }); } catch (e) { } },
};
function traducir(m) {
  if (/invalid login/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/email not confirmed/i.test(m)) return 'La cuenta no está confirmada. Pide al administrador que la confirme en Supabase.';
  if (/invalid totp|invalid code|code.*(invalid|expired)/i.test(m)) return 'Código incorrecto o vencido. Prueba con el código nuevo.';
  if (/password should be|weak password/i.test(m)) return 'La contraseña es muy débil (usa 10+ caracteres, con letras y números).';
  if (/same.*password|different from the old/i.test(m)) return 'La nueva contraseña debe ser distinta a la anterior.';
  if (/refresh token/i.test(m)) return 'Tu sesión expiró. Ingresa de nuevo.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Sin conexión con el servidor.';
  return m;
}

// ---------- Sincronización
let syncing = false, syncTimer = null;
function setSync(msg) { S.syncMsg = msg; const el = $('#sync'); if (el) el.textContent = msg; }
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 1200); }
async function sync() {
  if (!S.session || S.session.aal !== 'aal2' || syncing) return;
  if (!navigator.onLine) { setSync('Sin conexión · se sincronizará después'); return; }
  syncing = true; setSync('Sincronizando…');
  try {
    const dirty = (await DB.all('items')).filter(x => x.dirty);
    for (let i = 0; i < dirty.length; i += 200) {
      const chunk = dirty.slice(i, i + 200).map(x => ({ id: x.id, data: x.data || {}, deleted: !!x.deleted }));
      await Cloud.rest('items?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(chunk) });
    }
    for (const x of dirty) {
      const cur = await DB.get('items', x.id);
      if (cur && cur.deleted === x.deleted && (cur.data?.mod || cur.mod) === (x.data?.mod || x.mod)) { cur.dirty = false; await DB.put('items', cur); }
    }
    const since = (await DB.get('meta', 'lastSync')) || '1970-01-01T00:00:00Z';
    const sinceQ = new Date(new Date(since).getTime() - 120000).toISOString(); // margen de 2 min
    const rows = []; let off = 0;
    for (;;) {
      const r = await Cloud.rest(`items?select=id,data,deleted,updated_at&updated_at=gte.${encodeURIComponent(sinceQ)}&order=updated_at.asc&limit=1000&offset=${off}`);
      rows.push(...r); if (r.length < 1000) break; off += 1000;
    }
    let max = since, changed = false;
    for (const row of rows) {
      if (new Date(row.updated_at) > new Date(max)) max = row.updated_at;
      const cur = await DB.get('items', row.id);
      if (cur && cur.dirty) continue;
      const curMod = cur ? (cur.data?.mod || cur.mod || 0) : -1;
      if (cur && cur.deleted === row.deleted && curMod === (row.data?.mod || 0)) continue;
      await DB.put('items', { id: row.id, data: row.deleted ? null : row.data, deleted: row.deleted, dirty: false, mod: row.data?.mod });
      changed = true;
      if (row.deleted || !row.data?.kind) S.items.delete(row.id); else S.items.set(row.id, row.data);
    }
    await DB.put('meta', max, 'lastSync');
    setSync('Sincronizado · ' + new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }));
    if (changed && S.screen === 'main' && !$('#modal').innerHTML) renderMain();
  } catch (e) {
    console.warn(e);
    if (e.status === 400 || e.status === 401 || e.status === 403) {
      if (/expir|sesión|jwt|refresh/i.test(e.message) || e.status === 401) { setSync('Tu sesión expiró'); await expirarSesion(); return; }
    }
    setSync('No se pudo sincronizar: ' + e.message);
  } finally { syncing = false; }
}

// ---------- Flujo de ingreso: contraseña → 2FA
async function ingresar(email, password) {
  await Cloud.signIn(email, password);
  // Si en este dispositivo había datos de otra persona, se borran antes de continuar
  const owner = await DB.get('meta', 'owner');
  if (owner && owner !== S.session.uid) { await DB.clear('items'); await DB.del('meta', 'lastSync'); }
  await DB.put('meta', S.session.uid, 'owner');
  await pasoMFA();
}
async function pasoMFA() {
  const u = await Cloud.user();
  const f = (u.factors || []).find(x => x.factor_type === 'totp' && x.status === 'verified');
  if (f) { S.mfa = { factorId: f.id }; S.screen = 'mfa'; }
  else { const e = await Cloud.enroll(); S.mfa = { factorId: e.id, qr: e.totp.qr_code, secret: e.totp.secret, uri: e.totp.uri, nuevo: true }; S.screen = 'enroll'; }
  render();
}
async function verificarCodigo(code) {
  await Cloud.verify(S.mfa.factorId, code.replace(/\D/g, ''));
  if (S.session.aal !== 'aal2') throw new Error('No se pudo completar la verificación');
  const nuevo = S.mfa.nuevo; S.mfa = null;
  await entrar();
  if (nuevo) toast('Doble autenticación activada ✔', null, 4000);
}
async function entrar() {
  await loadItems();
  if (!tpls().length && !(await DB.get('meta', 'lastSync'))) {
    await sync(); // trae datos existentes antes de crear atajos de ejemplo
    if (!tpls().length) {
      await saveRec({ kind: 'tpl', nombre: 'Bencina', tipo: 'gasto', categoria: 'Bencina', medio: 'debito', monto: 0 });
      await saveRec({ kind: 'tpl', nombre: 'Supermercado', tipo: 'gasto', categoria: 'Supermercado', medio: 'debito', monto: 0 });
    }
  }
  S.screen = 'main'; render(); sync();
}
async function expirarSesion() {
  S.session = null; await DB.del('meta', 'session');
  closeSheet(); S.screen = 'login'; S.loginMsg = 'Tu sesión expiró. Ingresa de nuevo (tus cambios sin sincronizar se conservan).'; render();
}
async function cerrarSesion() {
  await sync();
  if ((await DB.all('items')).some(x => x.dirty)) { toast('No se pudo sincronizar todo. Conéctate a internet e inténtalo de nuevo.', null, 6000); return; }
  await Cloud.signOut();
  await DB.clear('items'); await DB.clear('meta');
  location.reload();
}

// ---------- Respaldo
async function exportar() {
  const items = [...S.items.values()];
  const payload = { app: 'mis-finanzas', v: 2, exported_at: new Date().toISOString(), items };
  const name = `finanzas-respaldo-${hoy()}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Respaldo Mis Finanzas' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Respaldo descargado');
}
async function importar(file) {
  let j; try { j = JSON.parse(await file.text()); } catch (e) { throw new Error('El archivo no es un respaldo válido'); }
  if (j.app !== 'mis-finanzas' || j.v !== 2 || !Array.isArray(j.items)) throw new Error('El archivo no es un respaldo válido');
  let n = 0;
  for (const o of j.items) {
    if (!o || !o.id || !['mov', 'tpl'].includes(o.kind)) continue;
    const cur = S.items.get(o.id);
    if (cur && (cur.mod || 0) >= (o.mod || 0)) continue;
    await saveRaw(o); n++;
  }
  toast(`${n} registro${n === 1 ? '' : 's'} importado${n === 1 ? '' : 's'}`); scheduleSync(); render();
}

// ---------- UI genérica
const app = $('#app');
function toast(msg, action, ms = 3500) {
  const t = document.createElement('div'); t.className = 't';
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { action.fn(); t.remove(); };
  $('#toast').replaceChildren(t); setTimeout(() => t.remove(), ms);
}
function openSheet(html) {
  $('#modal').innerHTML = `<div class="overlay" data-act="overlay"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const f = $('#modal input:not([type=radio]):not([type=checkbox]):not([type=file])');
  if (f && !('ontouchstart' in window)) f.focus();
}
function closeSheet() { $('#modal').innerHTML = ''; }
function confirmar(titulo, texto, si = 'Sí', peligro = false) {
  return new Promise(res => {
    openSheet(`<h2>${esc(titulo)}</h2><p class="mut">${esc(texto)}</p>
      <div class="acts"><button class="btn sec" data-act="cf-no">Cancelar</button><button class="btn ${peligro ? 'danger' : ''}" data-act="cf-si">${esc(si)}</button></div>`);
    S.cfRes = v => { S.cfRes = null; closeSheet(); res(v); };
  });
}

function qrSrc(qr) {
  // Supabase entrega el QR como SVG en un data: URI sin codificar (los "#" lo rompen en <img>).
  // Se convierte a un blob local, que el navegador muestra sin problemas.
  let svg = qr || '';
  if (svg.startsWith('data:')) {
    const i = svg.indexOf(','); const meta = svg.slice(0, i); svg = svg.slice(i + 1);
    if (/;base64/i.test(meta)) { try { svg = atob(svg); } catch (e) { } }
    else if (/%[0-9a-f]{2}/i.test(svg)) { try { svg = decodeURIComponent(svg); } catch (e) { } }
  }
  if (!svg.trim().startsWith('<')) return qr;
  if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}

// ---------- Pantallas
function render() { if (S.screen === 'main') renderMain(); else renderAuth(); }

function renderAuth() {
  const logo = `<div class="logo">$</div>`;
  let html = '';
  const codeInput = `<label>Código de 6 dígitos<input name="code" class="big" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required placeholder="000000"></label>`;
  if (S.screen === 'loading') html = `<div class="lock">${logo}<p class="mut">Cargando…</p></div>`;
  else if (S.screen === 'noconfig') html = `<div class="lock">${logo}<h1>Falta configurar</h1>
    <p class="mut">Completa <b>config.js</b> con la URL y la publishable key de tu proyecto Supabase (ver GUIA.md, paso 1).</p></div>`;
  else if (S.screen === 'login') html = `<form class="lock" id="f-login">${logo}<h1>Mis Finanzas</h1>
    ${S.loginMsg ? `<p class="note">${esc(S.loginMsg)}</p>` : `<p class="mut small">Ingresa con la cuenta que te creó el administrador.</p>`}
    <label>Correo<input type="email" name="email" required autocomplete="username"></label>
    <label>Contraseña<input type="password" name="pw" required autocomplete="current-password"></label>
    <div class="err" id="err"></div>
    <button class="btn">Ingresar</button></form>`;
  else if (S.screen === 'mfa') html = `<form class="lock" id="f-mfa">${logo}<h1>Verificación</h1>
    <p class="mut small">Abre tu app de autenticación (Google Authenticator, Microsoft Authenticator…) y escribe el código de <b>Mis Finanzas</b>.</p>
    ${codeInput}<div class="err" id="err"></div>
    <button class="btn">Verificar</button>
    <button type="button" class="link" data-act="salir-login">Usar otra cuenta</button></form>`;
  else if (S.screen === 'enroll') html = `<form class="lock" id="f-mfa">${logo}<h1>Activa la doble autenticación</h1>
    <p class="mut small">Es obligatoria y se hace una sola vez. Necesitas una app de autenticación en tu celular: <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> o similar.</p>
    <div class="card" style="text-align:center">
      <p class="small"><b>Si estás en un computador:</b> escanea este código con la app.</p>
      <img src="${esc(S.mfa.qrUrl || (S.mfa.qrUrl = qrSrc(S.mfa.qr)))}" alt="Código QR" width="190" height="190" style="background:#fff;border-radius:12px;padding:8px">
      <p class="small" style="margin-top:12px"><b>Si estás en el mismo celular:</b></p>
      <a class="btn sec" href="${esc(S.mfa.uri)}">Abrir en mi app de autenticación</a>
      <p class="mut small">o copia esta clave y agrégala a mano:</p>
      <p style="font-family:monospace;font-size:15px;word-break:break-all;user-select:all">${esc(S.mfa.secret)}</p>
      <button type="button" class="link" data-act="copiar-secreto">Copiar clave</button>
    </div>
    <p class="mut small">Luego escribe el código de 6 dígitos que aparece en la app:</p>
    ${codeInput}<div class="err" id="err"></div>
    <button class="btn">Activar y entrar</button>
    <button type="button" class="link" data-act="salir-login">Cancelar</button></form>`;
  app.innerHTML = html;
}

function renderMain() {
  const conMes = S.view === 'inicio' || S.view === 'movimientos';
  app.innerHTML = `
    ${conMes ? `<header class="top"><button class="icon" data-act="mes" data-d="-1" aria-label="Mes anterior">‹</button>
      <div class="mes">${mesLabel(S.mes)}</div><button class="icon" data-act="mes" data-d="1" aria-label="Mes siguiente">›</button></header>`
      : `<header class="top"><div class="mes">${TABS[S.view][1]}</div><span></span></header>`}
    <div class="sync" id="sync">${esc(S.syncMsg)}</div>
    <main>${VIEWS[S.view]()}</main>
    ${S.view !== 'ajustes' ? `<button class="fab" data-act="nuevo" aria-label="Nuevo movimiento">+</button>` : ''}
    <nav class="tabs">${Object.entries(TABS).map(([k, [i, t]]) => `<button data-act="tab" data-v="${k}" class="${S.view === k ? 'on' : ''}"><i>${i}</i>${t}</button>`).join('')}</nav>`;
}

function bars(rows, total) {
  return rows.map(([k, v, n]) => `<div class="bar"><div class="bar-l"><span>${esc(k)} <span class="mut small">· ${n}</span></span><span>${clp(v)}</span></div>
    <div class="bar-t"><div style="width:${total ? Math.max(2, v / total * 100).toFixed(1) : 0}%"></div></div></div>`).join('');
}
function rendimientos() {
  const f = movs().filter(x => isBencina(x.categoria) && x.km > 0 && x.litros > 0).sort((a, b) => a.km - b.km);
  const out = [];
  for (let i = 1; i < f.length; i++) { const d = f[i].km - f[i - 1].km; if (d > 0) out.push(d / f[i].litros); }
  return out;
}

const VIEWS = {
  inicio() {
    const ms = delMes(S.mes);
    const gastos = ms.filter(x => x.tipo === 'gasto'), ingresos = ms.filter(x => x.tipo === 'ingreso'),
      transf = ms.filter(x => x.tipo === 'transferencia'), pagos = ms.filter(x => x.tipo === 'pago_tarjeta');
    const G = sum(gastos), I = sum(ingresos), T = sum(transf), P = sum(pagos);
    const credMes = sum(gastos.filter(x => x.medio === 'credito'));
    const all = movs();
    const deuda = sum(all.filter(x => x.tipo === 'gasto' && x.medio === 'credito')) - sum(all.filter(x => x.tipo === 'pago_tarjeta'));
    const bal = I - G - T;
    const ben = gastos.filter(x => isBencina(x.categoria));
    const litros = ben.reduce((a, x) => a + (+x.litros || 0), 0);
    const rend = rendimientos();
    const ts = tpls();
    return `
      <div class="card"><div class="kpis">
        <div class="kpi wide"><div class="mut small">Balance del mes</div><div class="v big ${bal < 0 ? 'bad' : 'ok'}">${clp(bal)}</div></div>
        <div class="kpi"><div class="mut small">Gastos</div><div class="v">${clp(G)}</div></div>
        <div class="kpi"><div class="mut small">Ingresos</div><div class="v">${clp(I)}</div></div>
        <div class="kpi"><div class="mut small">Transferencias</div><div class="v">${clp(T)}</div></div>
        <div class="kpi"><div class="mut small">Movimientos</div><div class="v">${ms.length}</div></div>
      </div></div>
      <div class="card"><h3>Atajos</h3>
        ${ts.length ? `<div class="atajos">${ts.slice(0, 9).map(t => `<button class="atajo" data-act="usar" data-id="${t.id}"><b>${esc(t.nombre)}</b><span>${t.monto ? clp(t.monto) : 'ingresar monto'}</span></button>`).join('')}</div>`
          : `<p class="mut small">Crea atajos para lo que repites (bencina, una transferencia fija…) y regístralo con un toque.</p>`}
      </div>
      <div class="card"><h3>Tarjeta de crédito</h3><div class="kpis">
        <div class="kpi"><div class="mut small">Compras del mes</div><div class="v">${clp(credMes)}</div></div>
        <div class="kpi"><div class="mut small">Pagado este mes</div><div class="v">${clp(P)}</div></div>
        <div class="kpi wide"><div class="mut small">Por pagar (compras − pagos registrados)</div><div class="v ${deuda > 0 ? 'bad' : ''}">${clp(deuda)}</div></div>
      </div><p class="mut small">Las compras con crédito cuentan como gasto el día que compras. El pago de la tarjeta no se vuelve a contar como gasto.</p></div>
      ${gastos.length ? `<div class="card"><h3>Gastos por categoría</h3>${bars(group(gastos, x => x.categoria || 'Otros'), G)}</div>` : ''}
      ${transf.length ? `<div class="card"><h3>Transferencias por persona</h3>${bars(group(transf, x => x.persona || 'Sin nombre'), T)}</div>` : ''}
      ${ben.length || rend.length ? `<div class="card"><h3>⛽ Bencina</h3><div class="kpis">
        <div class="kpi"><div class="mut small">Gastado en el mes</div><div class="v">${clp(sum(ben))}</div></div>
        <div class="kpi"><div class="mut small">Litros del mes</div><div class="v">${litros ? litros.toLocaleString('es-CL', { maximumFractionDigits: 1 }) : '—'}</div></div>
        <div class="kpi"><div class="mut small">Último rendimiento</div><div class="v">${rend.length ? rend[rend.length - 1].toLocaleString('es-CL', { maximumFractionDigits: 1 }) + ' km/l' : '—'}</div></div>
        <div class="kpi"><div class="mut small">Promedio</div><div class="v">${rend.length ? (rend.reduce((a, b) => a + b, 0) / rend.length).toLocaleString('es-CL', { maximumFractionDigits: 1 }) + ' km/l' : '—'}</div></div>
      </div><p class="mut small">Para el rendimiento, anota litros y kilometraje llenando el estanque completo cada vez.</p></div>` : ''}`;
  },
  movimientos() {
    const ms = delMes(S.mes).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.mod || 0) - (a.mod || 0));
    if (!ms.length) return `<div class="empty">No hay movimientos en ${mesLabel(S.mes).toLowerCase()}.<br>Toca + para agregar uno.</div>`;
    let html = '', dia = '';
    for (const m of ms) {
      if (m.fecha !== dia) { dia = m.fecha; html += `<div class="day">${esc(diaLabel(dia))}</div>`; }
      html += rowHTML(m);
    }
    return html;
  },
  atajos() {
    const ts = tpls();
    return `<p class="mut small">Un atajo guarda un movimiento que repites. Si tiene monto, se registra con un solo toque desde Inicio; si no, te pide solo el monto.</p>
      <button class="btn" data-act="nuevo-atajo">+ Nuevo atajo</button>
      ${ts.map(t => `<button class="row" data-act="editar-atajo" data-id="${t.id}"><div class="ic">${t.tipo === 'gasto' ? (CAT_ICON[t.categoria] || ICON.gasto) : ICON[t.tipo]}</div>
        <div class="tx"><b>${esc(t.nombre)}</b><span>${esc(TIPOS[t.tipo])}${t.categoria ? ' · ' + esc(t.categoria) : ''}${t.persona ? ' · ' + esc(t.persona) : ''}${t.medio ? ' · ' + MEDIOS[t.medio] : ''}</span></div>
        <div class="am">${t.monto ? clp(t.monto) : '—'}</div></button>`).join('') || '<div class="empty">Aún no tienes atajos.</div>'}`;
  },
  ajustes() {
    return `
      <div class="card"><h3>Cuenta</h3>
        <p>Conectado como <b>${esc(S.session?.email || '')}</b></p>
        <p class="mut small">🔐 Doble autenticación activa · ${esc(S.syncMsg)}</p>
        <button class="btn sec" data-act="sync">Sincronizar ahora</button>
        <button class="btn sec" data-act="pw">Cambiar contraseña</button>
        <button class="btn danger" data-act="logout">Cerrar sesión</button>
        <p class="mut small">Al cerrar sesión se borran los datos de este dispositivo (siguen en tu cuenta). Úsalo si el dispositivo es compartido.</p></div>
      <div class="card"><h3>Respaldo</h3><p class="mut small">Descarga una copia de tus datos (archivo JSON sin cifrar: guárdalo en un lugar seguro).</p>
        <button class="btn sec" data-act="exportar">Exportar respaldo</button>
        <label class="btn sec" style="color:var(--tx)">Importar respaldo<input type="file" accept="application/json,.json" id="imp" hidden></label></div>
      <p class="mut small" style="text-align:center">${movs().length} movimientos · ${tpls().length} atajos</p>`;
  },
};
function rowHTML(m) {
  const titulo = m.tipo === 'transferencia' ? (m.persona || 'Transferencia') : m.tipo === 'pago_tarjeta' ? 'Pago tarjeta' : (m.categoria || TIPOS[m.tipo]);
  const sub = [m.tipo === 'gasto' && MEDIOS[m.medio], m.litros && `${String(m.litros).replace('.', ',')} L`, m.km && `${fmtNum(m.km)} km`, m.nota].filter(Boolean).join(' · ');
  const ic = m.tipo === 'gasto' ? (CAT_ICON[m.categoria] || ICON.gasto) : ICON[m.tipo];
  const signo = m.tipo === 'ingreso' ? '' : '-';
  return `<button class="row" data-act="editar" data-id="${m.id}"><div class="ic">${ic}</div>
    <div class="tx"><b>${esc(titulo)}</b><span>${esc(sub || TIPOS[m.tipo])}</span></div>
    <div class="am ${m.tipo === 'ingreso' ? 'ok' : ''}">${signo}${clp(m.monto)}</div></button>`;
}

// ---------- Formulario de movimiento / atajo
function formHTML(r, isTpl) {
  const tipo = r.tipo || 'gasto', medio = r.medio || 'debito';
  const cats = [...new Set([...CATEGORIAS, ...movs().map(x => x.categoria).filter(Boolean)])];
  const pers = [...new Set(movs().map(x => x.persona).filter(Boolean))];
  return `<form id="f-mov" data-tpl="${isTpl ? 1 : 0}" data-id="${esc(r.id || '')}" autocomplete="off">
    <h2>${isTpl ? (r.id ? 'Editar atajo' : 'Nuevo atajo') : (r.id ? 'Editar movimiento' : 'Nuevo movimiento')}</h2>
    ${isTpl ? `<label>Nombre del atajo<input name="nombre" required maxlength="40" value="${esc(r.nombre || '')}" placeholder="Ej: Bencina, Plata a Juan"></label>` : ''}
    <div class="seg">${Object.entries(TIPOS).map(([k, v]) => `<label><input type="radio" name="tipo" value="${k}" ${k === tipo ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>
    <label>Monto${isTpl ? ' (vacío si cambia cada vez)' : ''}<input name="monto" class="big" inputmode="numeric" value="${r.monto ? fmtNum(r.monto) : ''}" placeholder="$0" ${isTpl ? '' : 'required'}></label>
    <div data-show="gasto ingreso"><label>Categoría<input name="categoria" list="dl-cat" value="${esc(r.categoria || '')}" placeholder="Ej: Comida"></label></div>
    <div data-show="gasto"><div class="seg">${Object.entries(MEDIOS).map(([k, v]) => `<label><input type="radio" name="medio" value="${k}" ${k === medio ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></div>
    <div data-show="transferencia"><label>Persona<input name="persona" list="dl-per" value="${esc(r.persona || '')}" placeholder="¿A quién?"></label></div>
    ${isTpl ? '' : `<div data-bencina class="two"><label>Litros<input name="litros" inputmode="decimal" value="${r.litros ? String(r.litros).replace('.', ',') : ''}" placeholder="Opcional"></label>
      <label>Kilometraje<input name="km" inputmode="numeric" value="${r.km ? fmtNum(r.km) : ''}" placeholder="Opcional"></label></div>
      <label>Fecha<input type="date" name="fecha" required value="${esc(r.fecha || hoy())}"></label>`}
    <label>Nota<input name="nota" maxlength="120" value="${esc(r.nota || '')}" placeholder="Opcional"></label>
    ${!isTpl && !r.id ? `<label class="chk" style="margin-top:14px"><input type="checkbox" name="comoAtajo"> Guardar también como atajo</label>
      <div data-atajo hidden><label>Nombre del atajo<input name="nombreAtajo" maxlength="40" placeholder="Ej: Plata a Juan"></label></div>` : ''}
    <div class="err" id="err"></div>
    <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Guardar</button></div>
    ${r.id ? `<button type="button" class="btn danger" data-act="${isTpl ? 'borrar-atajo' : 'borrar-mov'}" data-id="${esc(r.id)}">Eliminar</button>` : ''}
    <datalist id="dl-cat">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl-per">${pers.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  </form>`;
}
function abrirForm(r = {}, isTpl = false) { openSheet(formHTML(r, isTpl)); actualizarForm($('#f-mov')); }
function actualizarForm(f) {
  if (!f) return;
  const tipo = f.querySelector('input[name=tipo]:checked')?.value || 'gasto';
  f.querySelectorAll('[data-show]').forEach(el => { el.hidden = !el.dataset.show.split(' ').includes(tipo); });
  const b = f.querySelector('[data-bencina]'); if (b) b.hidden = !(tipo === 'gasto' && isBencina(f.categoria.value));
  const a = f.querySelector('[data-atajo]'); if (a) a.hidden = !f.comoAtajo.checked;
}
async function guardarForm(f) {
  const g = k => (f.elements[k] ? (f.elements[k].value ?? '') : '').toString().trim();
  const isTpl = f.dataset.tpl === '1', id = f.dataset.id || undefined;
  const tipo = f.querySelector('input[name=tipo]:checked').value;
  const monto = parseMonto(g('monto'));
  if (!isTpl && monto <= 0) throw new Error('Ingresa un monto');
  const base = { tipo, monto };
  if (tipo === 'gasto' || tipo === 'ingreso') base.categoria = g('categoria') || (tipo === 'gasto' ? 'Otros' : 'Ingreso');
  if (tipo === 'gasto') base.medio = f.querySelector('input[name=medio]:checked')?.value || 'debito';
  if (tipo === 'transferencia') base.persona = g('persona');
  if (g('nota')) base.nota = g('nota');
  if (isTpl) {
    const prev = id ? S.items.get(id) : null;
    await saveRec({ id, kind: 'tpl', nombre: g('nombre') || 'Atajo', usos: prev?.usos || 0, ...base });
    closeSheet(); toast('Atajo guardado'); renderMain(); return;
  }
  const rec = { id, kind: 'mov', fecha: g('fecha') || hoy(), ...base };
  if (tipo === 'gasto' && isBencina(base.categoria)) { const l = parseDec(g('litros')), km = parseMonto(g('km')); if (l) rec.litros = l; if (km) rec.km = km; }
  await saveRec(rec);
  if (f.comoAtajo?.checked) {
    const t = { kind: 'tpl', nombre: g('nombreAtajo') || base.persona || base.categoria || TIPOS[tipo], ...base };
    if (isBencina(base.categoria)) t.monto = 0;
    await saveRec(t);
  }
  closeSheet(); S.mes = rec.fecha.slice(0, 7); renderMain(); toast(id ? 'Movimiento actualizado' : 'Movimiento guardado');
}
async function usarAtajo(id) {
  const t = S.items.get(id); if (!t) return;
  t.usos = (t.usos || 0) + 1; await saveRec(t);
  const base = { tipo: t.tipo, categoria: t.categoria, medio: t.medio, persona: t.persona, nota: t.nota };
  Object.keys(base).forEach(k => base[k] === undefined && delete base[k]);
  if (!t.monto) { abrirForm({ ...base, fecha: hoy() }); return; }
  const m = await saveRec({ kind: 'mov', fecha: hoy(), monto: t.monto, ...base });
  S.mes = hoy().slice(0, 7); renderMain();
  toast(`${t.nombre}: ${clp(t.monto)} registrado`, { label: 'Deshacer', fn: async () => { await delRec(m.id); renderMain(); } }, 6000);
}


// ---------- Eventos
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act;
  if (act === 'overlay' && e.target !== el) return;
  try {
    switch (act) {
      case 'overlay': if (S.cfRes) S.cfRes(false); else closeSheet(); break;
      case 'cerrar': closeSheet(); break;
      case 'cf-no': S.cfRes && S.cfRes(false); break;
      case 'cf-si': S.cfRes && S.cfRes(true); break;
      case 'tab': S.view = el.dataset.v; renderMain(); window.scrollTo(0, 0); break;
      case 'mes': S.mes = shiftMes(S.mes, +el.dataset.d); renderMain(); break;
      case 'nuevo': abrirForm(); break;
      case 'nuevo-atajo': abrirForm({}, true); break;
      case 'editar': abrirForm(S.items.get(el.dataset.id)); break;
      case 'editar-atajo': abrirForm(S.items.get(el.dataset.id), true); break;
      case 'usar': await usarAtajo(el.dataset.id); break;
      case 'borrar-mov': {
        const m = S.items.get(el.dataset.id); closeSheet(); await delRec(m.id); renderMain();
        toast('Movimiento eliminado', { label: 'Deshacer', fn: async () => { await saveRec(m); renderMain(); } }, 6000); break;
      }
      case 'borrar-atajo': if (await confirmar('¿Eliminar atajo?', 'Los movimientos ya registrados no se borran.', 'Eliminar', true)) { await delRec(el.dataset.id); renderMain(); } break;
      case 'sync': await sync(); renderMain(); break;
      case 'exportar': await exportar(); break;
      case 'pw': openSheet(`<form id="f-pw"><h2>Cambiar contraseña</h2>
          <label>Nueva contraseña<input type="password" name="p1" required minlength="10" autocomplete="new-password"></label>
          <label>Repítela<input type="password" name="p2" required minlength="10" autocomplete="new-password"></label>
          <div class="err" id="err"></div>
          <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Guardar</button></div></form>`); break;
      case 'logout':
        if (await confirmar('¿Cerrar sesión?', 'Se sincroniza todo y luego se borran los datos de este dispositivo. Siguen guardados en tu cuenta.', 'Cerrar sesión')) await cerrarSesion();
        break;
      case 'salir-login':
        S.session = null; S.mfa = null; await DB.del('meta', 'session'); S.screen = 'login'; render(); break;
      case 'copiar-secreto':
        try { await navigator.clipboard.writeText(S.mfa.secret); toast('Clave copiada'); } catch (_) { toast('Mantén presionada la clave para copiarla'); }
        break;
    }
  } catch (err) { console.error(err); toast(err.message || String(err)); }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, err = f.querySelector('#err'), btn = f.querySelector('button:not([type=button])');
  const label = btn?.textContent;
  const setErr = m => { if (err) err.textContent = m; else toast(m); };
  setErr('');
  if (btn) btn.disabled = true;
  try {
    if (f.id === 'f-mov') await guardarForm(f);
    else if (f.id === 'f-login') { if (btn) btn.textContent = 'Ingresando…'; S.loginMsg = ''; await ingresar(f.email.value.trim(), f.pw.value); }
    else if (f.id === 'f-mfa') { if (btn) btn.textContent = 'Verificando…'; await verificarCodigo(f.code.value); }
    else if (f.id === 'f-pw') {
      if (f.p1.value !== f.p2.value) throw new Error('Las contraseñas no coinciden');
      await Cloud.setPassword(f.p1.value); closeSheet(); toast('Contraseña actualizada');
    }
  } catch (ex) {
    console.error(ex); setErr(ex.message || String(ex));
    if (f.id === 'f-mfa' && f.code) { f.code.value = ''; f.code.focus(); }
  }
  if (btn && document.contains(btn)) { btn.disabled = false; btn.textContent = label; }
});

document.addEventListener('change', async e => {
  const f = e.target.closest('#f-mov'); if (f) actualizarForm(f);
  if (e.target.id === 'imp' && e.target.files[0]) { try { await importar(e.target.files[0]); } catch (ex) { toast(ex.message); } e.target.value = ''; }
});
document.addEventListener('input', e => {
  const f = e.target.closest('#f-mov'); if (!f) return;
  if (e.target.name === 'monto' || e.target.name === 'km') { const n = parseMonto(e.target.value); e.target.value = n ? fmtNum(n) : ''; }
  if (e.target.name === 'categoria') actualizarForm(f);
});

// ---------- Privacidad y sincronización periódica
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('oculto', document.hidden);
  if (!document.hidden && S.screen === 'main') sync();
});
setInterval(() => { if (S.screen === 'main' && !document.hidden) sync(); }, 60000);
addEventListener('online', () => { if (S.screen === 'main') sync(); });

// ---------- Inicio
(async function boot() {
  render();
  if (!SB) { S.screen = 'noconfig'; render(); return; }
  try {
    await DB.open();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
    S.session = (await DB.get('meta', 'session')) || null;
  } catch (e) {
    app.innerHTML = `<div class="lock"><h1>Error</h1><p class="mut">No se pudo abrir el almacenamiento del navegador. Si estás en modo incógnito, ábrela en una ventana normal.</p></div>`;
    return;
  }
  if (S.session && S.session.aal === 'aal2') await entrar();          // sesión completa: entra directo (funciona sin internet)
  else if (S.session) { try { await pasoMFA(); } catch (e) { await expirarSesion(); } } // faltó el código 2FA
  else { S.screen = 'login'; render(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
})();
})();
