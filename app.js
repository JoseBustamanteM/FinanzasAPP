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
const TABS = { inicio: ['🏠', 'Inicio'], movimientos: ['📋', 'Movimientos'], pagos: ['📅', 'Pagos'], atajos: ['⚡', 'Atajos'], ajustes: ['⚙️', 'Ajustes'] };

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
const difMes = (a, b) => { const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + mb - ma; };
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

// ---------- Tarjetas de crédito de cada persona
const tarjetas = () => [...S.items.values()].filter(x => x.kind === 'tar').sort((a, b) => a.nombre.localeCompare(b.nombre));
const nombreTarjeta = id => { const t = id && S.items.get(id); return t && t.kind === 'tar' ? t.nombre : ''; };
// Sin tarjeta, o con una que ya se eliminó, cuenta como "sin asignar" (clave '')
const claveTarjeta = x => (nombreTarjeta(x.tarjetaId) ? x.tarjetaId : '');
const esCredito = x => x.tipo === 'gasto' && x.medio === 'credito';
// Sin argumento: deuda total. Con una clave: deuda de esa tarjeta.
function deudaTarjeta(clave) {
  const de = x => clave === undefined || claveTarjeta(x) === clave, all = movs().filter(de);
  return sum(all.filter(esCredito)) - sum(all.filter(x => x.tipo === 'pago_tarjeta'));
}
function detalleTarjetas(m) {
  const ms = delMes(m);
  const fila = (clave, nombre) => {
    const de = ms.filter(x => claveTarjeta(x) === clave);
    return { nombre, compras: sum(gastosDelMes(m).filter(x => esCredito(x) && claveTarjeta(x) === clave)), pagado: sum(de.filter(x => x.tipo === 'pago_tarjeta')), deuda: clave ? faltaTarjeta(clave, m) : deudaTarjeta(clave) };
  };
  const out = tarjetas().map(t => fila(t.id, t.nombre));
  const sin = fila('', 'Sin tarjeta asignada');
  if (sin.compras || sin.pagado || sin.deuda) out.push(sin);
  return out;
}
async function resolverTarjeta(f, tipo) {
  const medio = f.querySelector('input[name=medio]:checked')?.value;
  if (tipo !== 'pago_tarjeta' && !(tipo === 'gasto' && medio === 'credito')) return undefined;
  const v = f.elements.tarjetaId?.value;
  if (v !== '__nueva') return v || undefined;
  const nombre = (f.elements.tarjetaNueva?.value || '').trim();
  if (!nombre) throw new Error('Escribe el nombre de la tarjeta');
  const igual = tarjetas().find(t => t.nombre.toLowerCase() === nombre.toLowerCase());
  return igual ? igual.id : (await saveRec({ kind: 'tar', nombre })).id;
}

// ---------- Pagos mensuales: cada pago se marca por mes y genera un movimiento normal
const pagos = () => [...S.items.values()].filter(x => x.kind === 'pag').sort((a, b) => a.dia - b.dia || a.nombre.localeCompare(b.nombre));
const pagoMov = (p, m) => movs().find(x => x.pagoId === p.id && x.pagoMes === m);
function vencimiento(p, m) {
  // Las cuotas vencen con su tarjeta, y el mes de vencimiento sigue el último estado de cuenta importado
  const q = p.tipo === 'pago_tarjeta' ? p : esCargoTarjeta(p) ? pagoDeTarjeta(p.tarjetaId) : null;
  if (q?.estados?.[m]?.vence) return q.estados[m].vence;
  const ultimo = Object.keys(q?.estados || {}).sort().pop();
  const mv = ultimo ? shiftMes(m, difMes(ultimo, q.estados[ultimo].vence.slice(0, 7))) : m;
  const [y, mo] = mv.split('-').map(Number);
  return `${mv}-${String(Math.min(p.dia, new Date(y, mo, 0).getDate())).padStart(2, '0')}`;
}
// La cuota avanza con el mes, como en la facturación del banco, aunque un mes anterior siga sin marcar
const cuotaDelMes = (p, m) => Math.min(p.cuotasTotal, (p.cuotasPrevias || 0) + 1 + Math.max(0, difMes(p.desde, m)));
const ultimoMesCuota = p => shiftMes(p.desde, p.cuotasTotal - (p.cuotasPrevias || 0) - 1);
function textoCuota(p, m, pagada) {
  const n = cuotaDelMes(p, m), quedan = p.cuotasTotal - n + (pagada ? 0 : 1);
  return n === p.cuotasTotal ? `Última cuota · ${n} de ${n}` : `Cuota ${n} de ${p.cuotasTotal} · quedan ${quedan}`;
}
const pagoVisible = (p, m) => (p.desde || '') <= m && (!p.cuotasTotal || m <= ultimoMesCuota(p));
// Sin estado de cuenta ni monto fijo, la tarjeta estima su pago con las cuotas pendientes del mes
const montoPago = (p, m) => p.estados?.[m]?.total || p.monto || (p.tipo === 'pago_tarjeta' && nombreTarjeta(p.tarjetaId) ? sum(cargosPendientes(p.tarjetaId, m)) + sum(comprasTarjeta(p.tarjetaId, m)) : 0);
// Una compra se paga en el mes de su facturación, que puede no ser el de su fecha
const mesDePagoCompra = x => x.factMes || (x.fecha || '').slice(0, 7);
const comprasTarjeta = (clave, m) => movs().filter(x => esCredito(x) && !x.pagoId && claveTarjeta(x) === clave && mesDePagoCompra(x) === m).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
const esPagoTC = p => p.tipo === 'pago_tarjeta' || (p.tipo === 'gasto' && p.medio === 'credito');
const mismoNombre = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const fijoIgual = (desc, tarjetaId) => pagos().find(p => esCargoTarjeta(p) && !p.cuotasTotal && mismoNombre(p.nombre, desc) && (!tarjetaId || p.tarjetaId === tarjetaId));
// Personas y división de gastos. Lo que te deben no toca el balance hasta que llega el dinero.
const personas = () => [...S.items.values()].filter(x => x.kind === 'per').sort((a, b) => a.nombre.localeCompare(b.nombre));
const nombrePersona = id => { const t = id && S.items.get(id); return t && t.kind === 'per' ? t.nombre : ''; };
const parteMonto = (parte, total) => (parte.pct ? Math.round(total * parte.pct / 100) : parte.monto || 0);
function partesDe(p, m) {
  if (p.divMes && m in p.divMes) return p.divMes[m];
  const vigente = (p.divs || []).filter(d => d.desde <= m).sort((a, b) => a.desde.localeCompare(b.desde)).pop();
  return vigente ? vigente.partes : [];
}
const totalDivPago = (p, m) => pagoMov(p, m)?.monto || montoPago(p, m);
const textoDiv = (partes, total) => partes.filter(x => nombrePersona(x.personaId)).map(x => `${nombrePersona(x.personaId)} te debe ${clp(parteMonto(x, total))}`).join(' · ');
function cargosDivididos(hasta) {
  const out = [];
  for (const x of movs()) {
    const mes = mesDePagoCompra(x);
    if (x.div && mes <= hasta) for (const d of x.div) out.push({ personaId: d.personaId, mes, nombre: x.nota || x.categoria || 'Compra', monto: parteMonto(d, x.monto), pct: d.pct, id: x.id });
  }
  for (const p of pagos()) {
    const inicios = [...(p.divs || []).map(d => d.desde), ...Object.keys(p.divMes || {})].sort();
    if (!inicios.length) continue;
    const fin = p.cuotasTotal && ultimoMesCuota(p) < hasta ? ultimoMesCuota(p) : hasta;
    for (let mes = inicios[0] > p.desde ? inicios[0] : p.desde; mes <= fin; mes = shiftMes(mes, 1)) {
      const total = totalDivPago(p, mes), nombre = p.cuotasTotal ? `${p.nombre} · Cuota ${cuotaDelMes(p, mes)} de ${p.cuotasTotal}` : p.nombre;
      for (const d of partesDe(p, mes)) out.push({ personaId: d.personaId, mes, nombre, monto: parteMonto(d, total), pct: d.pct, id: p.id });
    }
  }
  return out;
}
function cuentaPersonas(m) {
  const cargos = cargosDivididos(m), abonos = movs().filter(x => x.reembolso && x.personaId && (x.fecha || '').slice(0, 7) <= m);
  return personas().map(t => {
    const suyos = cargos.filter(c => c.personaId === t.id), pagos = abonos.filter(a => a.personaId === t.id);
    const delMes = suyos.filter(c => c.mes === m), abonosMes = pagos.filter(a => a.fecha.slice(0, 7) === m);
    const previo = sum(suyos.filter(c => c.mes < m)) - sum(pagos.filter(a => a.fecha.slice(0, 7) < m));
    return { t, delMes, abonosMes, previo, total: previo + sum(delMes) - sum(abonosMes) };
  });
}
const pagoDeTarjeta = t => pagos().find(q => q.tipo === 'pago_tarjeta' && q.tarjetaId === t);
const esCargoTarjeta = p => p.tipo === 'gasto' && p.medio === 'credito' && !!nombreTarjeta(p.tarjetaId);
// Cuotas y cargos que se pagan junto con la tarjeta: no se suman aparte para no contarlos dos veces
const enTarjeta = p => esCargoTarjeta(p) && !!pagoDeTarjeta(p.tarjetaId);
const cargosPendientes = (t, m) => pagos().filter(p => esCargoTarjeta(p) && p.tarjetaId === t && pagoVisible(p, m) && !pagoMov(p, m));
const pagadoEnMes = (p, m) => sum(movs().filter(x => x.pagoId === p.id && x.pagoMes === m));
// Lo que falta de la tarjeta tras un pago parcial de ese mes
function saldoTarjeta(p, m) {
  if (p.tipo !== 'pago_tarjeta' || !nombreTarjeta(p.tarjetaId)) return 0;
  const total = p.estados?.[m]?.total;
  if (total) return Math.max(0, total - pagadoEnMes(p, m));
  return porPagarMes(p, m);
}
// Lo que falta pagar de una tarjeta en ese mes: es la misma cifra en Inicio, Pagos y Ajustes
const porPagarMes = (q, m) => Math.max(0, montoPago(q, m) - pagadoEnMes(q, m));
function faltaTarjeta(t, m) {
  const q = pagoDeTarjeta(t);
  return q && pagoVisible(q, m) ? porPagarMes(q, m) : sum(cargosPendientes(t, m)) + sum(comprasTarjeta(t, m));
}
// Pagos de meses anteriores que siguen pendientes. No se suman al mes abierto.
function atrasados(m) {
  const out = [];
  for (const p of pagos()) {
    if (enTarjeta(p)) continue;
    const inicio = shiftMes(m, -12);
    for (let k = p.desde > inicio ? p.desde : inicio; k < m; k = shiftMes(k, 1)) {
      if (!pagoVisible(p, k)) continue;
      const falta = pagoMov(p, k) ? saldoTarjeta(p, k) : montoPago(p, k);
      if (falta > 0) out.push({ p, mes: k, falta });
    }
  }
  return out;
}
const textoAtrasados = lista => lista.slice(0, 4).map(a => `${a.p.nombre} (${mesLabel(a.mes)})`).join(', ') + (lista.length > 4 ? ` y ${lista.length - 4} más` : '');
// Las cuotas y pagos fijos de una tarjeta son gasto del mes en que se cobran, aunque aún no se marquen
function gastosDelMes(m) {
  const propios = delMes(m).filter(x => x.tipo === 'gasto' && !(x.pagoId && esCargoTarjeta(S.items.get(x.pagoId) || {})));
  const cargos = pagos().filter(p => esCargoTarjeta(p) && pagoVisible(p, m)).map(p => ({ tipo: 'gasto', medio: 'credito', categoria: p.categoria, tarjetaId: p.tarjetaId, monto: pagoMov(p, m)?.monto || p.monto }));
  return [...propios, ...cargos];
}
function resumenPagos(m) {
  const lista = pagos().map(p => ({ p, mov: pagoMov(p, m) })).filter(x => x.mov || pagoVisible(x.p, m));
  const propios = lista.filter(x => !enTarjeta(x.p)), falta = x => (x.mov ? saldoTarjeta(x.p, m) : montoPago(x.p, m));
  const pend = propios.filter(x => !x.mov || saldoTarjeta(x.p, m) > 0);
  return { lista, pend, porPagar: pend.reduce((a, x) => a + falta(x), 0), variables: pend.filter(x => !falta(x)).length, pagado: propios.reduce((a, x) => a + pagadoEnMes(x.p, m), 0) };
}
// Registra el pago de una tarjeta. Si cubre el total, deja pagadas todas sus cuotas de ese mes.
async function registrarPagoTarjeta(rec) {
  const t = rec.tarjetaId;
  let m = rec.pagoMes || rec.fecha.slice(0, 7);
  if (!rec.pagoMes && !cargosPendientes(t, m).length && cargosPendientes(t, shiftMes(m, 1)).length) m = shiftMes(m, 1);
  const q = pagoDeTarjeta(t);
  if (q && !rec.pagoId) { rec.pagoId = q.id; rec.pagoMes = m; }
  const pend = cargosPendientes(t, m);
  const total = q?.estados?.[m]?.total;
  const requerido = q ? porPagarMes(q, m) : deudaTarjeta(t) + sum(pend);
  const completo = rec.monto >= requerido;
  const mov = await saveRec(rec);
  if (completo) for (const p of pend) {
    await saveRec({ kind: 'mov', fecha: rec.fecha, tipo: 'gasto', categoria: p.categoria || 'Compras', medio: 'credito', tarjetaId: t, monto: p.monto, nota: p.nota || p.nombre, pagoId: p.id, pagoMes: m, porPago: mov.id });
  }
  return { mov, marcadas: completo ? pend.length : 0, pendientes: completo ? 0 : pend.length };
}
const mensajePagoTarjeta = r => r.marcadas ? `Tarjeta pagada: ${r.marcadas} cuota${r.marcadas === 1 ? '' : 's'} marcada${r.marcadas === 1 ? '' : 's'}`
  : r.pendientes ? `Pago parcial: ${r.pendientes} cuota${r.pendientes === 1 ? ' sigue pendiente' : 's siguen pendientes'}` : 'Pago de tarjeta registrado';
async function eliminarConCuotas(mov) {
  const hijas = movs().filter(x => x.porPago === mov.id);
  await delRec(mov.id); for (const h of hijas) await delRec(h.id);
  return [mov, ...hijas];
}
function estadoPago(p, m, mov) {
  const saldo = mov ? saldoTarjeta(p, m) : 0;
  if (saldo) return ['warn', `Pago parcial · faltan ${clp(saldo)}`];
  if (mov) return ['ok', `Pagado el ${+mov.fecha.slice(8, 10)}/${+mov.fecha.slice(5, 7)}`];
  const v = vencimiento(p, m), h = hoy(), dia = +v.slice(8, 10);
  if (v < h) return ['bad', `Atrasado · venció el ${dia}/${+v.slice(5, 7)}`];
  if (v === h) return ['warn', 'Vence hoy'];
  const n = Math.round((new Date(v + 'T12:00:00') - new Date(h + 'T12:00:00')) / 864e5);
  return n <= 3 ? ['warn', `Vence en ${n} día${n === 1 ? '' : 's'}`] : ['mut', `Vence el ${dia}/${+v.slice(5, 7)}`];
}

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
    if (changed && S.screen === 'main' && !$('#modal').innerHTML && S.view !== 'revision') renderMain();
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
    if (!o || !o.id || !['mov', 'tpl', 'pag', 'tar', 'per'].includes(o.kind)) continue;
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
  const conMes = S.view === 'inicio' || S.view === 'movimientos' || S.view === 'pagos';
  app.innerHTML = `
    ${conMes ? `<header class="top"><button class="icon" data-act="mes" data-d="-1" aria-label="Mes anterior">‹</button>
      <div class="mes">${mesLabel(S.mes)}</div><button class="icon" data-act="mes" data-d="1" aria-label="Mes siguiente">›</button></header>`
      : `<header class="top"><div class="mes">${TABS[S.view]?.[1] || 'Revisar estado de cuenta'}</div><span></span></header>`}
    <div class="sync" id="sync">${esc(S.syncMsg)}</div>
    <main>${VIEWS[S.view]()}</main>
    ${S.view !== 'ajustes' && S.view !== 'revision' ? `<button class="fab" data-act="nuevo" aria-label="Nuevo movimiento">+</button>` : ''}
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
    const gastos = gastosDelMes(S.mes), ingresos = ms.filter(x => x.tipo === 'ingreso' && !x.reembolso), reembolsos = ms.filter(x => x.reembolso),
      transf = ms.filter(x => x.tipo === 'transferencia'), pagos = ms.filter(x => x.tipo === 'pago_tarjeta');
    const G = sum(gastos), I = sum(ingresos), T = sum(transf), P = sum(pagos);
    const credMes = sum(gastos.filter(x => x.medio === 'credito'));
    const detalle = detalleTarjetas(S.mes), deuda = detalle.reduce((a, t) => a + Math.max(0, t.deuda), 0);
    const atraso = atrasados(S.mes).filter(a => a.p.tipo === 'pago_tarjeta' || esCargoTarjeta(a.p));
    const rp = resumenPagos(S.mes);
    const R = sum(reembolsos), bal = I + R - G - T;
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
        ${R ? `<div class="kpi wide"><div class="mut small">Reembolsos recibidos</div><div class="v">${clp(R)}</div></div>` : ''}
      </div></div>
      ${rp.lista.length ? `<div class="card"><h3>Pagos del mes</h3>
        <p class="small">${rp.pend.length ? `<b>${rp.pend.length} pendiente${rp.pend.length === 1 ? '' : 's'}</b>${rp.porPagar ? ` · ${clp(rp.porPagar)}` : ''}${rp.variables ? ` · ${rp.variables} sin monto fijo` : ''}` : '<span class="ok">✓ Todos pagados</span>'}</p>
        ${rp.pend.slice(0, 3).map(({ p }) => { const [c, t] = estadoPago(p, S.mes); return `<div class="bar-l small"><span>${esc(p.nombre)}</span><span class="${c}">${esc(t)}</span></div>`; }).join('')}
        <button class="link" data-act="tab" data-v="pagos">Ver pagos</button></div>` : ''}
      <div class="card"><h3>Atajos</h3>
        ${ts.length ? `<div class="atajos">${ts.slice(0, 9).map(t => `<button class="atajo" data-act="usar" data-id="${t.id}"><b>${esc(t.nombre)}</b><span>${t.monto ? clp(t.monto) : 'ingresar monto'}</span></button>`).join('')}</div>`
          : `<p class="mut small">Crea atajos para lo que repites (bencina, una transferencia fija…) y regístralo con un toque.</p>`}
      </div>
      <div class="card"><h3>Tarjeta de crédito</h3><div class="kpis">
        <div class="kpi"><div class="mut small">Compras y cuotas del mes</div><div class="v">${clp(credMes)}</div></div>
        <div class="kpi"><div class="mut small">Pagado este mes</div><div class="v">${clp(P)}</div></div>
        <div class="kpi wide"><div class="mut small">Por pagar este mes</div><div class="v ${deuda > 0 ? 'bad' : ''}">${clp(deuda)}</div></div>
        ${atraso.length ? `<div class="kpi wide"><div class="mut small">Atrasado de meses anteriores</div><div class="v bad">${clp(atraso.reduce((a, x) => a + x.falta, 0))}</div><div class="mut small">${esc(textoAtrasados(atraso))}</div></div>` : ''}
      </div>${detalle.map(t => `<div class="tarj"><div class="bar-l"><b>${esc(t.nombre)}</b><span class="${t.deuda > 0 ? 'bad' : ''}">${clp(t.deuda)}</span></div>
        <div class="mut small">Compras y cuotas ${clp(t.compras)} · Pagado ${clp(t.pagado)}</div></div>`).join('')}
      <p class="mut small">Las compras con crédito cuentan como gasto el día que compras; las cuotas y pagos fijos, en el mes que se cobran. El pago de la tarjeta no se vuelve a contar como gasto.</p></div>
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
    const filtro = S.filtroMedio || '';
    const delMesOrden = delMes(S.mes).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.mod || 0) - (a.mod || 0));
    if (!delMesOrden.length) return `<div class="empty">No hay movimientos en ${mesLabel(S.mes).toLowerCase()}.<br>Toca + para agregar uno.</div>`;
    const ms = filtro ? delMesOrden.filter(x => x.tipo === 'gasto' && (x.medio || 'debito') === filtro) : delMesOrden;
    let html = `<div class="vistas">${Object.entries({ '': 'Todos', ...MEDIOS }).map(([k, v]) => `<button class="vista ${k === filtro ? 'on' : ''}" data-act="filtro-medio" data-v="${k}">${v}</button>`).join('')}</div>`, dia = '';
    if (!ms.length) return `${html}<div class="empty">No hay gastos con ${MEDIOS[filtro].toLowerCase()} en ${mesLabel(S.mes).toLowerCase()}.</div>`;
    for (const m of ms) {
      if (m.fecha !== dia) { dia = m.fecha; html += `<div class="day">${esc(diaLabel(dia))}</div>`; }
      html += rowHTML(m);
    }
    return html;
  },
  pagos() {
    const r = resumenPagos(S.mes), atraso = atrasados(S.mes), vista = S.pagosVista || 'tarjetas', recurrentes = r.lista.filter(x => !esPagoTC(x.p));
    return `<div class="card"><div class="kpis">
        <div class="kpi"><div class="mut small">Por pagar${r.variables ? ` (+${r.variables} sin monto fijo)` : ''}</div><div class="v ${r.porPagar ? 'bad' : ''}">${clp(r.porPagar)}</div></div>
        <div class="kpi"><div class="mut small">Pagado</div><div class="v">${clp(r.pagado)}</div></div>
        ${atraso.length ? `<div class="kpi wide"><div class="mut small">Atrasado de meses anteriores</div><div class="v bad">${clp(atraso.reduce((a, x) => a + x.falta, 0))}</div><div class="mut small">${esc(textoAtrasados(atraso))}</div></div>` : ''}
      </div></div>
      <div class="vistas">${Object.entries({ tarjetas: 'Tarjetas', recurrentes: 'Recurrentes', medeben: 'Me deben' }).map(([k, v]) => `<button class="vista ${k === vista ? 'on' : ''}" data-act="vista-pagos" data-v="${k}">${v}</button>`).join('')}</div>
      ${vista === 'tarjetas' ? `<button class="btn" data-act="nueva-compra">+ Agregar compra con tarjeta</button>
        <label class="btn sec" style="color:var(--tx)">📄 Importar estado de cuenta<input type="file" accept="application/pdf,.pdf" id="imp-eecc" hidden></label>
        ${vistaTarjetas(r.lista, S.mes)}`
      : vista === 'medeben' ? vistaMeDeben(S.mes) : `<button class="btn" data-act="nuevo-pago">+ Nuevo pago recurrente</button>
        ${recurrentes.map(x => filaPago(x, S.mes)).join('') || '<div class="empty">Agrega lo que pagas todos los meses sin tarjeta de crédito: arriendo, luz, internet…</div>'}`}`;
  },
  revision() {
    const r = S.imp;
    return `<form id="f-import" autocomplete="off">
      <div class="card"><h3>${esc(r.nombre)}</h3><div class="kpis">
        <div class="kpi"><div class="mut small">Total a pagar</div><div class="v">${clp(r.total)}</div></div>
        <div class="kpi"><div class="mut small">Pagar hasta</div><div class="v">${esc(r.vence.split('-').reverse().join('/'))}</div></div>
      </div>${tarjetaCampo({ id: 'x' })}
      <label>Registrar en el mes<select name="mesPago">
        ${[...new Set([...[-2, -1, 0, 1].map(d => shiftMes(r.mes, d)), S.mes])].sort().map(m => `<option value="${m}" ${m === S.mes ? 'selected' : ''}>${mesLabel(m)}</option>`).join('')}
      </select></label>
      <p class="small warn" id="imp-mes" hidden></p>
      <div class="note" id="imp-res"></div></div>
      <p class="mut small">Revisa cada línea y corrige lo que haga falta. Nada se guarda hasta que confirmes.</p>
      <div class="imp-cab" aria-hidden="true"><span>Descripción</span><span>Fecha</span><span>Valor</span><span>Qué hacer</span><span>Cuota</span><span>De</span></div>
      ${r.lineas.map((l, i) => `<div class="imp" data-i="${i}" data-accion="${esc(l.accion)}">
        <input name="desc" maxlength="60" value="${esc(l.desc)}" aria-label="Descripción">
        <div class="two"><label><span class="lb">Fecha</span><input type="date" name="fecha" value="${esc(l.fecha)}"></label>
          <label><span class="lb">Valor</span><input name="monto" inputmode="numeric" value="${l.monto > 0 ? fmtNum(l.monto) : ''}"></label></div>
        <label><span class="lb">Qué hacer</span><select name="accion">
          ${Object.entries({ cuotas: 'Compra en cuotas', compra: 'Compra de una sola vez', fijo: 'Pago fijo mensual', cargo: 'Cargo o interés', ignorar: 'No registrar' }).map(([k, v]) => `<option value="${k}" ${k === l.accion ? 'selected' : ''}>${v}</option>`).join('')}
        </select></label>
        <div class="two" data-cuotas><label><span class="lb">Cuota actual</span><input name="n" inputmode="numeric" value="${l.n}"></label><label><span class="lb">De un total de</span><input name="de" inputmode="numeric" value="${l.de}"></label></div>
        ${l.aviso ? `<p class="small warn">⚠️ ${esc(l.aviso)}</p>` : ''}
        <p class="small warn" data-desfase hidden></p>
      </div>`).join('')}
      <div class="err" id="err"></div>
      <div class="acts"><button type="button" class="btn sec" data-act="cancelar-import">Cancelar</button><button class="btn">Confirmar y guardar</button></div>
    </form>`;
  },
  atajos() {
    const ts = tpls();
    return `<p class="mut small">Un atajo guarda un movimiento que repites. Si tiene monto, se registra con un solo toque desde Inicio; si no, te pide solo el monto.</p>
      <button class="btn" data-act="nuevo-atajo">+ Nuevo atajo</button>
      ${ts.map(t => `<button class="row" data-act="editar-atajo" data-id="${t.id}"><div class="ic">${t.tipo === 'gasto' ? (CAT_ICON[t.categoria] || ICON.gasto) : ICON[t.tipo]}</div>
        <div class="tx"><b>${esc(t.nombre)}</b><span>${esc(TIPOS[t.tipo])}${t.categoria ? ' · ' + esc(t.categoria) : ''}${t.persona ? ' · ' + esc(t.persona) : ''}${t.medio ? ' · ' + MEDIOS[t.medio] : ''}${nombreTarjeta(t.tarjetaId) ? ' · ' + esc(nombreTarjeta(t.tarjetaId)) : ''}</span></div>
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
      <div class="card"><h3>Mis tarjetas</h3>
        ${tarjetas().map(t => `<button class="row" data-act="editar-tarjeta" data-id="${esc(t.id)}"><div class="ic">💳</div><div class="tx"><b>${esc(t.nombre)}</b><span>Por pagar ${clp(faltaTarjeta(t.id, S.mes))}</span></div></button>`).join('') || '<p class="mut small">Agrega tus tarjetas de crédito para ver cuánto debes en cada una.</p>'}
        <button class="btn sec" data-act="nueva-tarjeta">+ Agregar tarjeta</button></div>
      <div class="card"><h3>Personas</h3>
        ${personas().map(t => `<button class="row" data-act="editar-persona" data-id="${esc(t.id)}"><div class="ic">👤</div><div class="tx"><b>${esc(t.nombre)}</b></div></button>`).join('') || '<p class="mut small">Agrega a quienes comparten gastos contigo. Solo se guarda el nombre.</p>'}
        <button class="btn sec" data-act="nueva-persona">+ Agregar persona</button></div>
      <div class="card"><h3>Respaldo</h3><p class="mut small">Descarga una copia de tus datos (archivo JSON sin cifrar: guárdalo en un lugar seguro).</p>
        <button class="btn sec" data-act="exportar">Exportar respaldo</button>
        <label class="btn sec" style="color:var(--tx)">Importar respaldo<input type="file" accept="application/json,.json" id="imp" hidden></label></div>
      <p class="mut small" style="text-align:center">${movs().length} movimientos · ${tpls().length} atajos · ${pagos().length} pagos recurrentes</p>`;
  },
};
function filaCompra(x) {
  const div = x.div ? textoDiv(x.div, x.monto) : '';
  return `<div class="row pago"><button class="pago-info" data-act="editar" data-id="${esc(x.id)}"><div class="ic">${x.cargo ? '📄' : (CAT_ICON[x.categoria] || ICON.gasto)}</div>
    <div class="tx"><b>${esc(x.nota || x.categoria || 'Compra')}</b><span>${esc((x.fecha || '').split('-').reverse().join('/'))}</span>${div ? `<span class="ok">${esc(div)}</span>` : ''}</div></button>
    <div class="pago-der"><div class="am">${clp(x.monto)}</div><button class="pago-btn sec" data-act="dividir-mov" data-id="${esc(x.id)}" aria-label="Dividir" title="Dividir">÷</button></div></div>`;
}
function vistaMeDeben(m) {
  const cuentas = cuentaPersonas(m), total = cuentas.reduce((a, c) => a + Math.max(0, c.total), 0);
  const conMovimiento = cuentas.filter(c => c.total || c.delMes.length || c.abonosMes.length);
  return `<div class="card"><div class="kpi"><div class="mut small">Me deben en total</div><div class="v ${total ? 'ok' : ''}">${clp(total)}</div></div>
      <p class="mut small">No cuenta en tu balance hasta que registres que te pagaron. Para dividir algo, toca ÷ en una compra o una cuota.</p></div>
    <button class="btn sec" data-act="nueva-persona">+ Agregar persona</button>
    ${conMovimiento.map(c => `<section class="bloque persona"><div class="bar-l"><b>${esc(c.t.nombre)}</b><b class="${c.total > 0 ? 'ok' : ''}">${c.total < 0 ? `A favor ${clp(-c.total)}` : clp(c.total)}</b></div>
      ${c.previo ? `<div class="bar-l small"><span>${c.previo > 0 ? 'Pendiente de meses anteriores' : 'A favor de meses anteriores'}</span><span>${clp(Math.abs(c.previo))}</span></div>` : ''}
      ${c.delMes.map(d => `<div class="bar-l small"><span>${esc(d.nombre)}${d.pct ? ` (${String(d.pct).replace('.', ',')}%)` : ''}</span><span>${clp(d.monto)}</span></div>`).join('')}
      ${c.abonosMes.map(a => `<button class="row" data-act="editar" data-id="${esc(a.id)}"><div class="ic">💰</div><div class="tx"><b>Pago recibido</b><span>${esc(a.fecha.split('-').reverse().join('/'))}</span></div><div class="am ok">-${clp(a.monto)}</div></button>`).join('')}
      ${c.total > 0 ? `<button class="btn" data-act="registrar-reembolso" data-id="${esc(c.t.id)}" data-monto="${c.total}">Registrar pago recibido</button>` : ''}</section>`).join('') || '<div class="empty">Nadie te debe en este mes.</div>'}`;
}
// ---------- Dividir un gasto
function filaDividir(parte, modo) {
  const ps = personas(), sel = parte?.personaId || (ps.length ? ps[0].id : '__nueva');
  const valor = !parte ? '' : modo === 'pct' ? String(parte.pct || '').replace('.', ',') : fmtNum(parte.monto);
  return `<div class="div-fila"><div class="two"><label>Persona<select name="persona">
      ${ps.map(t => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}
      <option value="__nueva" ${sel === '__nueva' ? 'selected' : ''}>+ Nueva persona…</option></select></label>
    <label>Le corresponde<input name="valor" inputmode="decimal" value="${esc(valor)}"></label></div>
    <div data-nueva><label>Nombre<input name="nombre" maxlength="40" placeholder="Ej: Ana"></label></div></div>`;
}
function abrirDividir(kind, id) {
  const r = S.items.get(id); if (!r) return;
  const m = S.mes, total = kind === 'mov' ? r.monto : totalDivPago(r, m), partes = kind === 'mov' ? r.div || [] : partesDe(r, m);
  const modo = partes.length && !partes[0].pct ? 'monto' : 'pct';
  const alcance = kind === 'mov' || !partes.length ? '' : (r.divMes && m in r.divMes ? 'mes' : 'todos');
  openSheet(`<form id="f-dividir" data-kind="${kind}" data-id="${esc(id)}" data-mes="${m}" data-total="${total}" autocomplete="off">
    <h2>Dividir ${esc(r.nota || r.nombre || r.categoria || 'gasto')}</h2>
    <p class="mut small">Total: <b>${total ? clp(total) : 'monto variable'}</b>. A tu tarjeta le sigues debiendo el total; aquí solo anotas lo que te deben.</p>
    ${kind === 'pag' ? `<p class="small" style="margin-top:12px"><b>¿Qué quieres dividir?</b></p>
      <div class="seg"><label><input type="radio" name="alcance" value="todos" ${alcance === 'todos' ? 'checked' : ''}><span>Mes a mes, desde ${esc(mesLabel(m))}</span></label>
        <label><input type="radio" name="alcance" value="mes" ${alcance === 'mes' ? 'checked' : ''}><span>Solo ${esc(mesLabel(m))}</span></label></div>` : ''}
    <div class="seg"><label><input type="radio" name="modo" value="pct" ${modo === 'pct' ? 'checked' : ''}><span>Porcentaje</span></label>
      <label><input type="radio" name="modo" value="monto" ${modo === 'monto' ? 'checked' : ''}><span>Monto</span></label></div>
    <div id="div-filas">${(partes.length ? partes : [null]).map(x => filaDividir(x, modo)).join('')}</div>
    <button type="button" class="link" data-act="div-fila">+ Otra persona</button>
    <div class="note" id="div-res"></div>
    <div class="err" id="err"></div>
    <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Guardar</button></div>
    ${partes.length ? '<button type="button" class="btn danger" data-act="div-quitar">Quitar división</button>' : ''}</form>`);
  actualizarDividir($('#f-dividir'));
}
function leerDividir(f) {
  const modo = f.querySelector('input[name=modo]:checked').value;
  return { modo, filas: [...f.querySelectorAll('.div-fila')].map(el => {
    const texto = el.querySelector('[name=valor]').value.trim();
    return { el, persona: el.querySelector('[name=persona]').value, nombre: el.querySelector('[name=nombre]').value.trim(), valor: modo === 'pct' ? parseDec(texto) || 0 : parseMonto(texto) };
  }) };
}
function actualizarDividir(f) {
  const { modo, filas } = leerDividir(f), total = +f.dataset.total;
  filas.forEach(x => {
    x.el.querySelector('[data-nueva]').hidden = x.persona !== '__nueva';
    x.el.querySelector('[name=valor]').placeholder = modo === 'pct' ? 'Ej: 50' : 'Ej: $20.000';
  });
  const deben = filas.reduce((a, x) => a + (modo === 'pct' ? Math.round(total * x.valor / 100) : x.valor), 0);
  $('#div-res').innerHTML = !total && modo === 'pct' ? 'Se calculará con el monto de cada mes.' : `Te deben <b>${clp(deben)}</b> · Tu parte <b>${clp(total - deben)}</b>`;
}
async function guardarDividir(f, quitar) {
  const kind = f.dataset.kind, r = S.items.get(f.dataset.id), m = f.dataset.mes, total = +f.dataset.total;
  const alcance = f.querySelector('input[name=alcance]:checked')?.value;
  if (kind === 'pag' && !alcance) throw new Error('Elige si quieres dividir mes a mes o solo este mes');
  const partes = [];
  if (!quitar) {
    const { modo, filas } = leerDividir(f), llenas = filas.filter(x => x.valor > 0);
    if (!llenas.length) throw new Error('Indica cuánto le corresponde a cada persona');
    if (modo === 'pct' && llenas.reduce((a, x) => a + x.valor, 0) > 100) throw new Error('Los porcentajes no pueden sumar más de 100');
    if (modo === 'monto' && total && llenas.reduce((a, x) => a + x.valor, 0) > total) throw new Error('Los montos no pueden sumar más que el total');
    if (llenas.some(x => x.persona === '__nueva' && !x.nombre)) throw new Error('Escribe el nombre de la persona');
    for (const x of llenas) {
      let personaId = x.persona;
      if (personaId === '__nueva') personaId = (personas().find(t => mismoNombre(t.nombre, x.nombre)) || await saveRec({ kind: 'per', nombre: x.nombre })).id;
      if (partes.some(c => c.personaId === personaId)) throw new Error(`${nombrePersona(personaId)} aparece dos veces`);
      partes.push(modo === 'pct' ? { personaId, pct: x.valor } : { personaId, monto: x.valor });
    }
  }
  if (kind === 'mov') {
    const rec = { ...r }; if (partes.length) rec.div = partes; else delete rec.div;
    await saveRec(rec);
  } else {
    const divMes = { ...(r.divMes || {}) };
    let divs = r.divs || [];
    if (alcance === 'mes') divMes[m] = partes;
    else { delete divMes[m]; divs = [...divs.filter(d => d.desde < m), { desde: m, partes }]; }
    await saveRec({ ...r, divs, divMes });
  }
  closeSheet(); renderMain(); toast(partes.length ? 'División guardada' : 'División quitada');
}
function abrirPersonaForm(r = {}) {
  openSheet(`<form id="f-persona" data-id="${esc(r.id || '')}" autocomplete="off"><h2>${r.id ? 'Editar persona' : 'Nueva persona'}</h2>
    <label>Nombre<input name="nombre" required maxlength="40" value="${esc(r.nombre || '')}" placeholder="Ej: Ana"></label>
    <div class="err" id="err"></div>
    <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Guardar</button></div>
    ${r.id ? `<button type="button" class="btn danger" data-act="borrar-persona" data-id="${esc(r.id)}">Eliminar</button>` : ''}</form>`);
}
async function guardarPersona(f) {
  const nombre = f.elements.nombre.value.trim(), id = f.dataset.id || undefined;
  if (!nombre) throw new Error('Escribe el nombre');
  if (personas().some(t => t.id !== id && mismoNombre(t.nombre, nombre))) throw new Error('Ya tienes una persona con ese nombre');
  await saveRec({ id, kind: 'per', nombre }); closeSheet(); renderMain(); toast('Persona guardada');
}
// ---------- Pagos fijos de una tarjeta
const mesPagadoTarjeta = (t, m) => { const q = pagoDeTarjeta(t); return q && pagoMov(q, m) && !saldoTarjeta(q, m) ? pagoMov(q, m) : null; };
// Si ese mes ya se pagó entero, el pago fijo nuevo queda pagado con él
async function marcarFijoPagado(p, m, pagoTarjeta) {
  if (pagoTarjeta) await saveRec({ kind: 'mov', fecha: pagoTarjeta.fecha, tipo: 'gasto', categoria: p.categoria, medio: 'credito', tarjetaId: p.tarjetaId, monto: p.monto, nota: p.nombre, pagoId: p.id, pagoMes: m, porPago: pagoTarjeta.id });
}
async function convertirEnFijo(id) {
  const x = S.items.get(id); if (!x) return;
  if (!nombreTarjeta(x.tarjetaId)) throw new Error('Primero elige la tarjeta de esta compra');
  const m = mesDePagoCompra(x), nombre = x.nota || x.categoria || 'Pago fijo', pagado = mesPagadoTarjeta(x.tarjetaId, m);
  if (fijoIgual(nombre, x.tarjetaId)) throw new Error('Ya tienes un pago fijo con ese nombre en esta tarjeta');
  const dia = pagoDeTarjeta(x.tarjetaId)?.dia || +x.fecha.slice(8, 10);
  const p = await saveRec({ kind: 'pag', nombre, dia, tipo: 'gasto', categoria: x.categoria || 'Cuentas', medio: 'credito', tarjetaId: x.tarjetaId, monto: x.monto, desde: m, ...(x.div ? { divs: [{ desde: m, partes: x.div }] } : {}) });
  await delRec(id); await marcarFijoPagado(p, m, pagado);
  closeSheet(); S.view = 'pagos'; S.pagosVista = 'tarjetas'; S.mes = m; renderMain(); toast('Convertido en pago fijo mensual');
}
// Cada tarjeta conserva siempre el mismo color
const colorTarjeta = id => (id ? `tc-${[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 6}` : 'tc-g');
function bloqueTarjeta(titulo, clave, cabecera, sinPago, cargos, m) {
  const cuotas = cargos.filter(x => x.p.cuotasTotal), fijos = cargos.filter(x => !x.p.cuotasTotal);
  const cm = comprasTarjeta(clave, m), compras = cm.filter(x => !x.cargo), cobros = cm.filter(x => x.cargo);
  if (!cabecera.length && !cargos.length && !cm.length) return '';
  const seccion = (t, html) => (html ? `<div class="day">${t}</div>${html}` : '');
  const total = sum(cm) + cargos.filter(x => !x.mov).reduce((a, x) => a + montoPago(x.p, m), 0);
  return `<section class="bloque ${colorTarjeta(clave)}">${cabecera.length ? cabecera.map(x => filaPago(x, m)).join('') : `<div class="bar-l cab-simple"><b>${esc(titulo)}</b><b>${clp(total)}</b></div>${sinPago}`}
    ${seccion('Cuotas', cuotas.map(x => filaPago(x, m)).join(''))}
    ${seccion('Pagos fijos', fijos.map(x => filaPago(x, m)).join(''))}
    ${seccion('Compras de una sola vez', compras.map(filaCompra).join(''))}
    ${seccion('Cargos e intereses', cobros.map(filaCompra).join(''))}</section>`;
}
function vistaTarjetas(lista, m) {
  const tc = lista.filter(x => esPagoTC(x.p));
  const principales = new Set(tarjetas().map(t => pagoDeTarjeta(t.id)).filter(Boolean));
  const html = tarjetas().map(t => {
    const q = pagoDeTarjeta(t.id), cabecera = tc.filter(x => x.p === q);
    const sinPago = q ? '' : `<button class="link" data-act="pago-de-tarjeta" data-id="${esc(t.id)}">+ Agregar el pago mensual de esta tarjeta</button>`;
    return bloqueTarjeta(t.nombre, t.id, cabecera, sinPago, tc.filter(x => esCargoTarjeta(x.p) && x.p.tarjetaId === t.id), m);
  }).join('');
  const resto = tc.filter(x => !principales.has(x.p) && !esCargoTarjeta(x.p));
  const sinTarjeta = bloqueTarjeta('Sin tarjeta asignada', '', [], '', resto, m);
  return html || sinTarjeta ? `<p class="mut small">Las cuotas se marcan solas al pagar el total de la tarjeta. Si pagas una parte, siguen pendientes.</p>${html}${sinTarjeta}`
    : '<div class="empty">Importa tu estado de cuenta o agrega una compra para ver en qué usaste cada tarjeta.</div>';
}
function filaPago({ p, mov }, m) {
  const [c, t] = estadoPago(p, m, mov), tar = nombreTarjeta(p.tarjetaId), saldo = mov ? saldoTarjeta(p, m) : 0, monto = saldo || (mov ? pagadoEnMes(p, m) : montoPago(p, m));
  return `<div class="row pago ${p.tipo === 'pago_tarjeta' ? 'cab-tarjeta' : ''}">
    <button class="pago-info" data-act="editar-pago" data-id="${esc(p.id)}"><div class="ic">${p.tipo === 'gasto' ? (CAT_ICON[p.categoria] || ICON.gasto) : ICON[p.tipo]}</div>
      <div class="tx"><b>${esc(p.nombre)}</b><span class="${c}">${esc(t)}${tar && !enTarjeta(p) ? ' · ' + esc(tar) : ''}</span>
      ${p.cuotasTotal ? `<span>${textoCuota(p, m, !!mov)}</span>` : ''}
      ${partesDe(p, m).length ? `<span class="ok">${esc(textoDiv(partesDe(p, m), totalDivPago(p, m)))}</span>` : ''}</div></button>
    <div class="pago-der"><div class="am">${monto ? clp(monto) : 'Variable'}</div>
      <div class="pago-acc">${p.tipo === 'pago_tarjeta' ? '' : `<button class="pago-btn sec" data-act="dividir-pago" data-id="${esc(p.id)}" aria-label="Dividir" title="Dividir">÷</button>`}
      ${mov && !saldo ? `<button class="pago-btn hecho" data-act="editar" data-id="${esc(mov.id)}">✓ Pagado</button>` : `<button class="pago-btn ${enTarjeta(p) ? 'sec' : ''}" data-act="pagar" data-id="${esc(p.id)}">${enTarjeta(p) ? 'Marcar' : 'Pagar'}</button>`}</div></div>
  </div>`;
}
function rowHTML(m) {
  const titulo = m.tipo === 'transferencia' ? (m.persona || 'Transferencia') : m.tipo === 'pago_tarjeta' ? 'Pago tarjeta' : (m.categoria || TIPOS[m.tipo]);
  const sub = [m.tipo === 'gasto' && MEDIOS[m.medio], nombreTarjeta(m.tarjetaId), nombrePersona(m.personaId), m.litros && `${String(m.litros).replace('.', ',')} L`, m.km && `${fmtNum(m.km)} km`, m.nota].filter(Boolean).join(' · ');
  const ic = m.tipo === 'gasto' ? (CAT_ICON[m.categoria] || ICON.gasto) : ICON[m.tipo];
  const signo = m.tipo === 'ingreso' ? '' : '-';
  return `<button class="row" data-act="editar" data-id="${m.id}"><div class="ic">${ic}</div>
    <div class="tx"><b>${esc(titulo)}</b><span>${esc(sub || TIPOS[m.tipo])}</span></div>
    <div class="am ${m.tipo === 'ingreso' ? 'ok' : ''}">${signo}${clp(m.monto)}</div></button>`;
}

// ---------- Formulario de movimiento / atajo
function tarjetaCampo(r) {
  const ts = tarjetas();
  const sel = nombreTarjeta(r.tarjetaId) ? r.tarjetaId : (!r.id && ts.length === 1 ? ts[0].id : '');
  return `<div data-tarjeta><label>Tarjeta<select name="tarjetaId">
      <option value="">Sin especificar</option>
      ${ts.map(t => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}
      <option value="__nueva">+ Agregar tarjeta…</option>
    </select></label>
    <div data-tarjeta-nueva><label>Nombre de la tarjeta<input name="tarjetaNueva" maxlength="40" placeholder="Ej: CMR Falabella, BCI"></label></div></div>`;
}
function formHTML(r, isTpl) {
  const tipo = r.tipo || 'gasto', medio = r.medio || 'debito';
  const cats = [...new Set([...CATEGORIAS, ...movs().map(x => x.categoria).filter(Boolean)])];
  const pers = [...new Set(movs().map(x => x.persona).filter(Boolean))];
  const mesFact = r.factMes || (r.id && r.fecha ? r.fecha.slice(0, 7) : S.mes);
  return `<form id="f-mov" data-tpl="${isTpl ? 1 : 0}" data-id="${esc(r.id || '')}" data-pago-id="${esc(r.pagoId || '')}" data-pago-mes="${esc(r.pagoMes || '')}" data-persona="${esc(r.personaId || '')}" autocomplete="off">
    <h2>${isTpl ? (r.id ? 'Editar atajo' : 'Nuevo atajo') : (r.id ? 'Editar movimiento' : r.pagoId ? 'Registrar pago' : 'Nuevo movimiento')}</h2>
    ${isTpl ? `<label>Nombre del atajo<input name="nombre" required maxlength="40" value="${esc(r.nombre || '')}" placeholder="Ej: Bencina, Plata a Juan"></label>` : ''}
    <div class="seg">${Object.entries(TIPOS).map(([k, v]) => `<label><input type="radio" name="tipo" value="${k}" ${k === tipo ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>
    <label>Monto${isTpl ? ' (vacío si cambia cada vez)' : ''}<input name="monto" class="big" inputmode="numeric" value="${r.monto ? fmtNum(r.monto) : ''}" placeholder="$0" ${isTpl ? '' : 'required'}></label>
    <div data-show="gasto ingreso"><label>Categoría<input name="categoria" list="dl-cat" value="${esc(r.categoria || '')}" placeholder="Ej: Comida"></label></div>
    <div data-show="gasto"><div class="seg">${Object.entries(MEDIOS).map(([k, v]) => `<label><input type="radio" name="medio" value="${k}" ${k === medio ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></div>
    ${tarjetaCampo(r)}
    ${isTpl || r.pagoId ? '' : `<div data-fact><label>Se paga en el mes<select name="factMes">${[-2, -1, 0, 1, 2].map(d => shiftMes(mesFact, d)).map(v => `<option value="${v}" ${v === mesFact ? 'selected' : ''}>${mesLabel(v)}</option>`).join('')}</select></label></div>`}
    <div data-show="transferencia"><label>Persona<input name="persona" list="dl-per" value="${esc(r.persona || '')}" placeholder="¿A quién?"></label></div>
    ${isTpl ? '' : `<div data-bencina class="two"><label>Litros<input name="litros" inputmode="decimal" value="${r.litros ? String(r.litros).replace('.', ',') : ''}" placeholder="Opcional"></label>
      <label>Kilometraje<input name="km" inputmode="numeric" value="${r.km ? fmtNum(r.km) : ''}" placeholder="Opcional"></label></div>
      <label>Fecha<input type="date" name="fecha" required value="${esc(r.fecha || hoy())}"></label>`}
    <label>Nota<input name="nota" maxlength="120" value="${esc(r.nota || '')}" placeholder="Opcional"></label>
    ${!isTpl && !r.id && !r.pagoId ? `<label class="chk" style="margin-top:14px"><input type="checkbox" name="comoAtajo"> Guardar también como atajo</label>
      <div data-atajo hidden><label>Nombre del atajo<input name="nombreAtajo" maxlength="40" placeholder="Ej: Plata a Juan"></label></div>` : ''}
    <div class="err" id="err"></div>
    <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Guardar</button></div>
    ${!isTpl && r.id && r.tipo === 'gasto' && !r.pagoId ? `<button type="button" class="btn sec" data-act="dividir-mov" data-id="${esc(r.id)}">÷ Dividir con otra persona</button>` : ''}
    ${!isTpl && r.id && esCredito(r) && !r.pagoId ? `<button type="button" class="btn sec" data-act="convertir-fijo" data-id="${esc(r.id)}">Convertir en pago fijo mensual</button>` : ''}
    ${r.id ? `<button type="button" class="btn danger" data-act="${isTpl ? 'borrar-atajo' : 'borrar-mov'}" data-id="${esc(r.id)}">Eliminar</button>` : ''}
    <datalist id="dl-cat">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl-per">${pers.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  </form>`;
}
function abrirTarjetaForm(r = {}) {
  openSheet(`<form id="f-tarjeta" data-id="${esc(r.id || '')}" autocomplete="off"><h2>${r.id ? 'Editar tarjeta' : 'Nueva tarjeta'}</h2>
    <label>Nombre<input name="nombre" required maxlength="40" value="${esc(r.nombre || '')}" placeholder="Ej: CMR Falabella, BCI"></label>
    <div class="err" id="err"></div>
    <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Guardar</button></div>
    ${r.id ? `<button type="button" class="btn danger" data-act="borrar-tarjeta" data-id="${esc(r.id)}">Eliminar</button>` : ''}</form>`);
}
async function guardarTarjeta(f) {
  const nombre = f.elements.nombre.value.trim(), id = f.dataset.id || undefined;
  if (!nombre) throw new Error('Escribe el nombre de la tarjeta');
  if (tarjetas().some(t => t.id !== id && t.nombre.toLowerCase() === nombre.toLowerCase())) throw new Error('Ya tienes una tarjeta con ese nombre');
  await saveRec({ id, kind: 'tar', nombre }); closeSheet(); renderMain(); toast('Tarjeta guardada');
}
function pagoFormHTML(r) {
  const tipo = r.tipo || 'gasto', medio = r.medio || 'debito';
  const tipos = { gasto: TIPOS.gasto, pago_tarjeta: TIPOS.pago_tarjeta, transferencia: TIPOS.transferencia };
  const cats = [...new Set([...CATEGORIAS, ...movs().map(x => x.categoria).filter(Boolean)])];
  return `<form id="f-pago" data-id="${esc(r.id || '')}" autocomplete="off">
    <h2>${r.id ? 'Editar pago recurrente' : 'Nuevo pago recurrente'}</h2>
    <label>Nombre<input name="nombre" required maxlength="40" value="${esc(r.nombre || '')}" placeholder="Ej: Tarjeta de crédito, Arriendo"></label>
    <label>Día de vencimiento (1 a 31)<input name="dia" type="number" min="1" max="31" step="1" inputmode="numeric" required value="${esc(r.dia || '')}" placeholder="Ej: 5"></label>
    <div class="seg">${Object.entries(tipos).map(([k, v]) => `<label><input type="radio" name="tipo" value="${k}" ${k === tipo ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>
    <label>Monto (vacío si cambia cada mes)<input name="monto" class="big" inputmode="numeric" value="${r.monto ? fmtNum(r.monto) : ''}" placeholder="$0"></label>
    <div class="two"><label>Cuota de este mes<input name="cuotaProx" inputmode="numeric" value="${r.cuotasTotal ? cuotaDelMes(r, S.mes) : ''}" placeholder="Opcional"></label>
      <label>Total de cuotas<input name="cuotaTotal" inputmode="numeric" value="${r.cuotasTotal || ''}" placeholder="Opcional"></label></div>
    <p class="mut small">Usa las cuotas si este pago tiene fin, como una compra en 12 cuotas. La cuota avanza sola cada mes.</p>
    <div data-show="gasto"><label>Categoría<input name="categoria" list="dl-cat" value="${esc(r.categoria || '')}" placeholder="Ej: Cuentas"></label>
      <div class="seg">${Object.entries(MEDIOS).map(([k, v]) => `<label><input type="radio" name="medio" value="${k}" ${k === medio ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></div>
    ${tarjetaCampo(r)}
    <div data-show="transferencia"><label>Persona<input name="persona" value="${esc(r.persona || '')}" placeholder="¿A quién?"></label></div>
    <label>Nota<input name="nota" maxlength="120" value="${esc(r.nota || '')}" placeholder="Opcional"></label>
    <div class="err" id="err"></div>
    <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Guardar</button></div>
    ${r.id && r.tipo !== 'pago_tarjeta' ? `<button type="button" class="btn sec" data-act="dividir-pago" data-id="${esc(r.id)}">÷ Dividir con otra persona</button>` : ''}
    ${r.id ? `<button type="button" class="btn danger" data-act="borrar-pago" data-id="${esc(r.id)}">Eliminar</button>` : ''}
    <datalist id="dl-cat">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  </form>`;
}
function abrirPagoForm(r = {}) { openSheet(pagoFormHTML(r)); actualizarForm($('#f-pago')); }
async function guardarPago(f) {
  const g = k => (f.elements[k]?.value ?? '').toString().trim();
  const id = f.dataset.id || undefined, prev = id ? S.items.get(id) : null;
  const dia = parseInt(g('dia'), 10);
  if (!(dia >= 1 && dia <= 31)) throw new Error('El día debe estar entre 1 y 31');
  const tipo = f.querySelector('input[name=tipo]:checked').value;
  const mesActual = hoy().slice(0, 7);
  const rec = { id, kind: 'pag', nombre: g('nombre') || 'Pago', dia, tipo, monto: parseMonto(g('monto')), desde: prev?.desde || (S.mes < mesActual ? S.mes : mesActual) };
  if (prev?.estados) rec.estados = prev.estados;
  if (prev?.divs) rec.divs = prev.divs;
  if (prev?.divMes) rec.divMes = prev.divMes;
  const cTotal = parseMonto(g('cuotaTotal')), cProx = parseMonto(g('cuotaProx')) || 1;
  if (cTotal) {
    if (cProx > cTotal) throw new Error('La cuota de este mes no puede ser mayor que el total');
    const previas = cProx - 1 - difMes(rec.desde, S.mes);
    if (previas < 0) rec.desde = S.mes;
    rec.cuotasTotal = cTotal; rec.cuotasPrevias = previas < 0 ? cProx - 1 : previas;
  }
  if (tipo === 'gasto') { rec.categoria = g('categoria') || 'Cuentas'; rec.medio = f.querySelector('input[name=medio]:checked')?.value || 'debito'; }
  if (tipo === 'transferencia') rec.persona = g('persona');
  if (g('nota')) rec.nota = g('nota');
  const tarjetaId = await resolverTarjeta(f, tipo);
  if (tarjetaId) rec.tarjetaId = tarjetaId;
  await saveRec(rec); S.pagosVista = esPagoTC(rec) ? 'tarjetas' : 'recurrentes'; closeSheet(); renderMain(); toast('Pago recurrente guardado');
}
async function pagarPago(id) {
  const p = S.items.get(id); if (!p) return;
  const m = S.mes;
  const saldo = pagoMov(p, m) ? saldoTarjeta(p, m) : 0;
  if (pagoMov(p, m) && !saldo) { renderMain(); return; }
  if (p.tipo === 'pago_tarjeta' && p.monto && !saldo && !p.estados?.[m]?.total && nombreTarjeta(p.tarjetaId)) {
    const rec = { kind: 'mov', tipo: p.tipo, tarjetaId: p.tarjetaId, monto: p.monto, nota: p.nota || p.nombre, pagoId: p.id, pagoMes: m, fecha: m < hoy().slice(0, 7) ? vencimiento(p, m) : hoy() };
    const r = await registrarPagoTarjeta(rec); renderMain();
    toast(mensajePagoTarjeta(r), { label: 'Deshacer', fn: async () => { await eliminarConCuotas(r.mov); renderMain(); } }, 6000); return;
  }
  const base = { tipo: p.tipo, categoria: p.categoria, medio: p.medio, persona: p.persona, tarjetaId: p.tarjetaId, nota: p.nota || p.nombre, pagoId: p.id, pagoMes: m };
  Object.keys(base).forEach(k => base[k] === undefined && delete base[k]);
  // Un mes pasado queda con su vencimiento o, si este cae en otro mes, con su último día
  const venceEn = vencimiento(p, m);
  const fecha = m >= hoy().slice(0, 7) ? hoy() : venceEn.startsWith(m) ? venceEn : `${m}-${String(new Date(+m.slice(0, 4), +m.slice(5), 0).getDate())}`;
  if (!p.monto || p.estados?.[m]?.total || saldo) {
    const conTarjeta = !!nombreTarjeta(p.tarjetaId);
    const deuda = p.tipo !== 'pago_tarjeta' ? 0 : saldo || p.estados?.[m]?.total || (conTarjeta ? porPagarMes(p, m) : deudaTarjeta());
    abrirForm({ ...base, fecha, monto: deuda > 0 ? deuda : 0 }); return;
  }
  const mov = await saveRec({ kind: 'mov', fecha, monto: p.monto, ...base });
  renderMain();
  toast(`${p.nombre}: ${clp(p.monto)} registrado`, { label: 'Deshacer', fn: async () => { await delRec(mov.id); renderMain(); } }, 6000);
}
// ---------- Importar estado de cuenta
async function cargarEstado(file, password) {
  let filas;
  toast('Leyendo el estado de cuenta…');
  try {
    if (file) S.impDatos = await file.arrayBuffer(); // Se lee una vez: en Android, releer el archivo elegido puede fallar
    const limite = new Promise((_, no) => setTimeout(() => no(new Error('el navegador tardó demasiado en leerlo')), 60000));
    filas = await Promise.race([FinImport.leerFilas(S.impDatos, password), limite]);
  } catch (ex) {
    if (ex?.name !== 'PasswordException') { console.error(ex); throw new Error(`No se pudo leer el PDF. Revisa que sea el archivo original del banco. Detalle: ${ex?.message || ex}`); }
    openSheet(`<form id="f-clave"><h2>PDF con contraseña</h2><p class="mut small">La clave se usa solo para abrir el archivo en este dispositivo y no se guarda.</p>
      <label>Contraseña del PDF<input type="password" name="clave" required autocomplete="off"></label>
      <div class="err" id="err">${password ? 'Contraseña incorrecta.' : ''}</div>
      <div class="acts"><button type="button" class="btn sec" data-act="cerrar">Cancelar</button><button class="btn">Abrir</button></div></form>`);
    return;
  }
  const r = FinImport.analizar(filas);
  if (!r) throw new Error('No reconozco este formato. Por ahora se leen CMR Falabella y BCI; agrega tus pagos a mano.');
  // Reimportar: lo que ya existe queda sin registrar. Solo es igual si coincide en tarjeta y compra, y cada registro se usa una vez.
  const tjProbable = tarjetas().find(t => r.clave.test(t.nombre))?.id, usados = new Set();
  for (const l of r.lineas) {
    if (l.accion === 'cuotas') {
      const c = pagos().find(p => !usados.has(p.id) && p.cuotasTotal === l.de && Math.abs(p.monto - l.monto) <= 50 && mismoNombre(p.nombre, l.desc) && (!tjProbable || p.tarjetaId === tjProbable) && ultimoMesCuota(p) >= shiftMes(r.mes, -2));
      if (c) { usados.add(c.id); l.cuotaId = c.id; l.accion = 'ignorar'; l.existe = true; l.aviso = 'Ya tienes esta compra en cuotas. Se dejó sin registrar para no duplicarla.'; }
    } else if (['compra', 'cargo', 'fijo'].includes(l.accion)) {
      const fijo = l.accion !== 'cargo' && fijoIgual(l.desc, tjProbable);
      const previo = movs().find(x => esCredito(x) && !x.pagoId && !usados.has(x.id) && x.fecha === l.fecha && x.monto === l.monto && (tjProbable ? !claveTarjeta(x) || claveTarjeta(x) === tjProbable : mismoNombre(x.nota, l.desc)));
      if (previo) { usados.add(previo.id); l.era = l.accion === 'cargo' ? 'cargo' : 'compra'; l.movPrevioId = previo.id; }
      if (fijo) { l.accion = 'ignorar'; l.existe = true; l.fijoId = fijo.id; l.aviso = fijo.monto === l.monto ? 'Ya está como pago fijo de la tarjeta.' : `Ya está como pago fijo. Su valor cambiará de ${clp(fijo.monto)} a ${clp(l.monto)}.`; }
      else if (previo && l.accion === 'fijo') l.aviso = 'Se convertirá en pago fijo y reemplazará la compra ya registrada.';
      else if (previo) { l.accion = 'ignorar'; l.existe = true; l.aviso = 'Ya tienes un movimiento igual. Se dejó sin registrar para no duplicarlo.'; }
    }
  }
  S.impDatos = null; closeSheet(); S.imp = r; S.view = 'revision'; renderMain(); window.scrollTo(0, 0);
  const f = $('#f-import'), igual = tarjetas().find(t => r.clave.test(t.nombre));
  f.elements.tarjetaId.value = igual ? igual.id : '__nueva';
  if (!igual) f.elements.tarjetaNueva.value = r.nombre;
  actualizarImport(f);
}
// El mismo estado de cuenta ya importado en otro mes
function estadoEnOtroMes(tarjetaId, m) {
  const q = pagoDeTarjeta(tarjetaId), r = S.imp;
  return q && Object.keys(q.estados || {}).find(k => k !== m && q.estados[k].vence === r.vence && q.estados[k].total === r.total);
}
function leerLinea(el) {
  const v = k => el.querySelector(`[name=${k}]`).value.trim();
  return { desc: v('desc'), fecha: v('fecha'), monto: parseMonto(v('monto')), accion: v('accion'), n: parseMonto(v('n')), de: parseMonto(v('de')) };
}
// La cuota que la app espera en ese mes, para compararla con la que indica el banco
const cuotaEsperada = (p, m) => (p.cuotasPrevias || 0) + 1 + difMes(p.desde, m);
function actualizarImport(f) {
  const tj = f.querySelector('[data-tarjeta-nueva]'); if (tj) tj.hidden = f.elements.tarjetaId.value !== '__nueva';
  let suma = 0, cuantas = 0, yaEstan = 0, abonos = 0, desfases = 0;
  const mesImp = f.elements.mesPago.value, moverDesde = estadoEnOtroMes(f.elements.tarjetaId.value, mesImp);
  f.querySelectorAll('.imp').forEach(el => {
    const l = leerLinea(el);
    el.classList.toggle('off', l.accion === 'ignorar');
    el.dataset.accion = l.accion;
    el.querySelector('[data-cuotas]').hidden = l.accion !== 'cuotas';
    if (l.accion !== 'ignorar') { cuantas++; if (!(l.accion === 'cuotas' && l.n === 0)) suma += l.monto; }
    else if (S.imp.lineas[+el.dataset.i].existe) { yaEstan++; if (l.n !== 0) suma += l.monto; } // ya registradas: también cuentan para cuadrar con el banco
    else if (S.imp.lineas[+el.dataset.i].pago) abonos += l.monto;
    const orig = S.imp.lineas[+el.dataset.i], p = orig.cuotaId && S.items.get(orig.cuotaId), desf = el.querySelector('[data-desfase]');
    const esperada = p && !moverDesde && l.accion === 'ignorar' && l.n > 0 && cuotaEsperada(p, mesImp) !== l.n ? cuotaEsperada(p, mesImp) : 0;
    desf.hidden = !esperada;
    if (esperada) { desfases++; desf.textContent = `⚠️ La app tenía la cuota ${esperada} en ${mesLabel(mesImp)} y el banco indica la ${l.n}. Al confirmar quedará la ${l.n}.`; }
  });
  const dif = suma - S.imp.total, m = f.elements.mesPago.value, otro = estadoEnOtroMes(f.elements.tarjetaId.value, m), aviso = $('#imp-mes');
  aviso.textContent = otro ? `Este estado de cuenta ya está en ${mesLabel(otro)}. Al confirmar se moverá a ${mesLabel(m)}.`
    : m !== S.imp.mes ? `El banco indica que vence el ${S.imp.vence.split('-').reverse().join('/')}. Lo verás en ${mesLabel(m)} porque lo elegiste aquí.` : '';
  if (desfases) aviso.textContent += `${aviso.textContent ? ' ' : ''}${desfases} cuota${desfases === 1 ? ' no coincide' : 's no coinciden'} con este mes: revisa que el mes elegido sea el correcto.`;
  aviso.hidden = !aviso.textContent;
  $('#imp-res').innerHTML = `${cuantas} línea${cuantas === 1 ? '' : 's'} por registrar${yaEstan ? ` · ${yaEstan} ya registrada${yaEstan === 1 ? '' : 's'}` : ''} · suma <b>${clp(suma)}</b><br>${abonos ? `Pagos a la tarjeta leídos: ${clp(abonos)} (no se suman)<br>` : ''}${dif === 0 ? '<span class="ok">✓ Coincide con el total del banco</span>' : `<span class="warn">⚠️ Diferencia con el total del banco: ${clp(dif)}</span>`}`;
}
async function guardarImport(f) {
  const r = S.imp, lineas = [...f.querySelectorAll('.imp')].map(leerLinea);
  for (const l of lineas) {
    if (l.accion === 'ignorar') continue;
    if (l.monto <= 0) throw new Error(`Falta el valor de "${l.desc}"`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.fecha)) throw new Error(`Falta la fecha de "${l.desc}"`);
    if (l.accion === 'cuotas' && !(l.de >= 1 && l.n <= l.de)) throw new Error(`Revisa las cuotas de "${l.desc}"`);
  }
  const tarjetaId = await resolverTarjeta(f, 'pago_tarjeta');
  if (!tarjetaId) throw new Error('Elige a qué tarjeta corresponde este estado de cuenta');
  const dia = +r.vence.slice(8, 10), mes = f.elements.mesPago.value, salto = difMes(r.mes, mes);
  const q = pagoDeTarjeta(tarjetaId) || { kind: 'pag', nombre: 'Pago ' + nombreTarjeta(tarjetaId), dia, tipo: 'pago_tarjeta', tarjetaId, monto: 0, desde: mes };
  const estados = { ...(q.estados || {}) }, otro = estadoEnOtroMes(tarjetaId, mes);
  if (otro) {
    if (pagadoEnMes(q, otro)) throw new Error(`Este estado de cuenta ya tiene un pago en ${mesLabel(otro)}. Elimina ese pago antes de moverlo.`);
    delete estados[otro];
    // Lo ya importado se mueve con el estado de cuenta, para que no quede en el mes anterior
    for (const l of r.lineas.filter(x => x.cuotaId || x.fijoId)) {
      const p = S.items.get(l.cuotaId || l.fijoId);
      if (!p || p.tarjetaId !== tarjetaId || movs().some(x => x.pagoId === p.id) || (l.fijoId && p.desde !== otro)) continue;
      await saveRec({ ...p, desde: shiftMes(p.desde, difMes(otro, mes)) });
    }
  }
  const desde = otro && q.desde === otro ? mes : q.desde < mes ? q.desde : mes;
  await saveRec({ ...q, desde, estados: { ...estados, [mes]: { total: r.total, vence: r.vence } } });
  let n = 0;
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i], orig = r.lineas[i];
    // Lo ya registrado queda asociado al mes de este estado de cuenta, sin duplicarse
    if (l.accion === 'ignorar' && orig.movPrevioId && S.items.get(orig.movPrevioId)) {
      const x = S.items.get(orig.movPrevioId);
      await saveRec({ ...x, factMes: mes, tarjetaId: claveTarjeta(x) || tarjetaId, ...(orig.era === 'cargo' ? { cargo: true } : {}) });
    }
    // Si la cuota no coincide con el banco, manda el banco
    if (l.accion === 'ignorar' && orig.cuotaId && !otro && l.n > 0 && S.items.get(orig.cuotaId)) {
      const p = S.items.get(orig.cuotaId), previas = l.n - 1 - difMes(p.desde, mes);
      if (cuotaEsperada(p, mes) !== l.n) await saveRec(previas >= 0 ? { ...p, cuotasPrevias: previas } : { ...p, desde: mes, cuotasPrevias: l.n - 1 });
    }
    if (l.accion === 'ignorar' && orig.fijoId) {
      const p = S.items.get(orig.fijoId);
      if (p && l.monto > 0 && p.monto !== l.monto) await saveRec({ ...p, monto: l.monto });
    }
    if (l.accion === 'ignorar') continue;
    if (l.accion === 'fijo') {
      const igual = fijoIgual(l.desc, tarjetaId), pagado = mesPagadoTarjeta(tarjetaId, mes);
      const p = await saveRec(igual ? { ...igual, monto: l.monto } : { kind: 'pag', nombre: l.desc, dia, tipo: 'gasto', categoria: 'Cuentas', medio: 'credito', tarjetaId, monto: l.monto, desde: mes });
      if (orig.movPrevioId) await delRec(orig.movPrevioId);
      if (!igual) await marcarFijoPagado(p, mes, pagado);
      n++; continue;
    }
    if (l.accion === 'cuotas') {
      await saveRec({ kind: 'pag', nombre: l.desc, dia, tipo: 'gasto', categoria: 'Compras', medio: 'credito', tarjetaId, monto: l.monto, cuotasTotal: l.de, cuotasPrevias: Math.max(0, l.n - 1), desde: l.n === 0 ? shiftMes(r.lineas[i].primerMes || shiftMes(r.mes, 1), salto) : mes });
    } else {
      await saveRec({ kind: 'mov', tipo: 'gasto', categoria: l.accion === 'cargo' ? 'Cuentas' : 'Compras', medio: 'credito', tarjetaId, monto: l.monto, fecha: l.fecha, nota: l.desc, factMes: mes, ...(l.accion === 'cargo' ? { cargo: true } : {}) });
    }
    n++;
  }
  S.mes = mes; S.imp = null; S.view = 'pagos'; renderMain(); window.scrollTo(0, 0);
  toast(`${n} línea${n === 1 ? '' : 's'} guardada${n === 1 ? '' : 's'}`);
}
function abrirForm(r = {}, isTpl = false) { openSheet(formHTML(r, isTpl)); actualizarForm($('#f-mov')); }
function actualizarForm(f) {
  if (!f) return;
  const tipo = f.querySelector('input[name=tipo]:checked')?.value || 'gasto';
  f.querySelectorAll('[data-show]').forEach(el => { el.hidden = !el.dataset.show.split(' ').includes(tipo); });
  const b = f.querySelector('[data-bencina]'); if (b) b.hidden = !(tipo === 'gasto' && isBencina(f.categoria.value));
  const a = f.querySelector('[data-atajo]'); if (a) a.hidden = !f.comoAtajo.checked;
  const fc = f.querySelector('[data-fact]'); if (fc) fc.hidden = !(tipo === 'gasto' && f.querySelector('input[name=medio]:checked')?.value === 'credito');
  const tj = f.querySelector('[data-tarjeta]');
  if (tj) {
    tj.hidden = !(tipo === 'pago_tarjeta' || (tipo === 'gasto' && f.querySelector('input[name=medio]:checked')?.value === 'credito'));
    tj.querySelector('[data-tarjeta-nueva]').hidden = f.elements.tarjetaId.value !== '__nueva';
  }
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
  const tarjetaId = await resolverTarjeta(f, tipo);
  if (tarjetaId) base.tarjetaId = tarjetaId;
  if (isTpl) {
    const prev = id ? S.items.get(id) : null;
    await saveRec({ id, kind: 'tpl', nombre: g('nombre') || 'Atajo', usos: prev?.usos || 0, ...base });
    closeSheet(); toast('Atajo guardado'); renderMain(); return;
  }
  const rec = { id, kind: 'mov', fecha: g('fecha') || hoy(), ...base };
  if (id && S.items.get(id)?.porPago) rec.porPago = S.items.get(id).porPago;
  let pagoMes = f.dataset.pagoMes;
  if (f.dataset.pagoId && pagoMes) { rec.pagoId = f.dataset.pagoId; rec.pagoMes = pagoMes; }
  if (tipo === 'gasto' && base.medio === 'credito' && f.elements.factMes) rec.factMes = g('factMes');
  if (id && S.items.get(id)?.cargo) rec.cargo = true;
  if (id && tipo === 'gasto' && S.items.get(id)?.div) rec.div = S.items.get(id).div;
  if (f.dataset.persona && tipo === 'ingreso') { rec.personaId = f.dataset.persona; rec.reembolso = true; }
  if (tipo === 'gasto' && isBencina(base.categoria)) { const l = parseDec(g('litros')), km = parseMonto(g('km')); if (l) rec.litros = l; if (km) rec.km = km; }
  const pagoT = !id && tipo === 'pago_tarjeta' && rec.tarjetaId ? await registrarPagoTarjeta(rec) : null;
  if (pagoT) pagoMes = pagoT.mov.pagoMes || pagoMes; else await saveRec(rec);
  if (f.comoAtajo?.checked) {
    const t = { kind: 'tpl', nombre: g('nombreAtajo') || base.persona || base.categoria || TIPOS[tipo], ...base };
    if (isBencina(base.categoria)) t.monto = 0;
    await saveRec(t);
  }
  closeSheet(); S.mes = pagoMes || (S.view === 'pagos' && rec.factMes) || rec.fecha.slice(0, 7); renderMain();
  if (pagoT) toast(mensajePagoTarjeta(pagoT), { label: 'Deshacer', fn: async () => { await eliminarConCuotas(pagoT.mov); renderMain(); } }, 6000);
  else toast(id ? 'Movimiento actualizado' : 'Movimiento guardado');
}
async function usarAtajo(id) {
  const t = S.items.get(id); if (!t) return;
  t.usos = (t.usos || 0) + 1; await saveRec(t);
  const base = { tipo: t.tipo, categoria: t.categoria, medio: t.medio, persona: t.persona, tarjetaId: t.tarjetaId, nota: t.nota };
  Object.keys(base).forEach(k => base[k] === undefined && delete base[k]);
  if (!t.monto) { abrirForm({ ...base, fecha: hoy() }); return; }
  const rec = { kind: 'mov', fecha: hoy(), monto: t.monto, ...base };
  const pagoT = t.tipo === 'pago_tarjeta' && t.tarjetaId ? await registrarPagoTarjeta(rec) : null;
  if (pagoT) { S.mes = pagoT.mov.pagoMes || hoy().slice(0, 7); renderMain(); toast(mensajePagoTarjeta(pagoT), { label: 'Deshacer', fn: async () => { await eliminarConCuotas(pagoT.mov); renderMain(); } }, 6000); return; }
  const m = await saveRec(rec);
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
      case 'dividir-mov': abrirDividir('mov', el.dataset.id); break;
      case 'dividir-pago': abrirDividir('pag', el.dataset.id); break;
      case 'div-fila': { const f = $('#f-dividir'); $('#div-filas').insertAdjacentHTML('beforeend', filaDividir(null, leerDividir(f).modo)); actualizarDividir(f); break; }
      case 'div-quitar': { const f = $('#f-dividir'); try { await guardarDividir(f, true); } catch (ex) { f.querySelector('#err').textContent = ex.message; } break; }
      case 'nueva-persona': abrirPersonaForm(); break;
      case 'editar-persona': abrirPersonaForm(S.items.get(el.dataset.id)); break;
      case 'borrar-persona': {
        const saldo = cuentaPersonas(hoy().slice(0, 7)).find(c => c.t.id === el.dataset.id)?.total || 0;
        if (saldo) { $('#err').textContent = `Aún tiene un saldo de ${clp(saldo)}. Regístralo o quita sus divisiones antes de eliminarla.`; break; }
        if (await confirmar('¿Eliminar persona?', 'Sus pagos recibidos se conservan como movimientos.', 'Eliminar', true)) { await delRec(el.dataset.id); closeSheet(); renderMain(); }
        break;
      }
      case 'registrar-reembolso': abrirForm({ tipo: 'ingreso', categoria: 'Reembolso', monto: +el.dataset.monto, personaId: el.dataset.id, nota: 'Pago de ' + nombrePersona(el.dataset.id), fecha: hoy() }); break;
      case 'convertir-fijo': if (await confirmar('¿Convertir en pago fijo?', 'Dejará de ser una compra de una vez y aparecerá todos los meses en esta tarjeta.', 'Convertir')) await convertirEnFijo(el.dataset.id); break;
      case 'nueva-compra': abrirForm({ tipo: 'gasto', medio: 'credito' }); break;
      case 'vista-pagos': S.pagosVista = el.dataset.v; renderMain(); break;
      case 'filtro-medio': S.filtroMedio = el.dataset.v; renderMain(); break;
      case 'pago-de-tarjeta': abrirPagoForm({ tipo: 'pago_tarjeta', tarjetaId: el.dataset.id, nombre: 'Pago ' + nombreTarjeta(el.dataset.id) }); break;
      case 'nuevo-atajo': abrirForm({}, true); break;
      case 'editar': abrirForm(S.items.get(el.dataset.id)); break;
      case 'editar-atajo': abrirForm(S.items.get(el.dataset.id), true); break;
      case 'usar': await usarAtajo(el.dataset.id); break;
      case 'cancelar-import': S.imp = null; S.view = 'pagos'; renderMain(); break;
      case 'nueva-tarjeta': abrirTarjetaForm(); break;
      case 'editar-tarjeta': abrirTarjetaForm(S.items.get(el.dataset.id)); break;
      case 'borrar-tarjeta': if (await confirmar('¿Eliminar tarjeta?', 'Sus compras y pagos se conservan, pero quedan como "Sin tarjeta asignada".', 'Eliminar', true)) { await delRec(el.dataset.id); renderMain(); } break;
      case 'nuevo-pago': abrirPagoForm(); break;
      case 'editar-pago': abrirPagoForm(S.items.get(el.dataset.id)); break;
      case 'pagar': await pagarPago(el.dataset.id); break;
      case 'borrar-pago': if (await confirmar('¿Eliminar pago recurrente?', 'Los movimientos ya registrados no se borran.', 'Eliminar', true)) { await delRec(el.dataset.id); renderMain(); } break;
      case 'borrar-mov': {
        const m = S.items.get(el.dataset.id); closeSheet(); const borrados = await eliminarConCuotas(m); renderMain();
        toast(borrados.length > 1 ? `Pago eliminado y ${borrados.length - 1} cuota${borrados.length === 2 ? '' : 's'} sin marcar` : 'Movimiento eliminado', { label: 'Deshacer', fn: async () => { for (const x of borrados) await saveRec(x); renderMain(); } }, 6000); break;
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
    else if (f.id === 'f-pago') await guardarPago(f);
    else if (f.id === 'f-tarjeta') await guardarTarjeta(f);
    else if (f.id === 'f-import') await guardarImport(f);
    else if (f.id === 'f-dividir') await guardarDividir(f);
    else if (f.id === 'f-persona') await guardarPersona(f);
    else if (f.id === 'f-clave') await cargarEstado(null, f.clave.value);
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
  const f = e.target.closest('#f-mov, #f-pago'); if (f) actualizarForm(f);
  const fi = e.target.closest('#f-import'); if (fi) actualizarImport(fi);
  const fd = e.target.closest('#f-dividir'); if (fd) actualizarDividir(fd);
  if (e.target.id === 'imp-eecc' && e.target.files[0]) { const a = e.target.files[0]; e.target.value = ''; try { await cargarEstado(a); } catch (ex) { toast(ex.message, null, 6000); } }
  if (e.target.id === 'imp' && e.target.files[0]) { try { await importar(e.target.files[0]); } catch (ex) { toast(ex.message); } e.target.value = ''; }
});
document.addEventListener('input', e => {
  const fd = e.target.closest('#f-dividir'); if (fd) { actualizarDividir(fd); return; }
  const fi = e.target.closest('#f-import');
  if (fi) { if (e.target.name === 'monto') { const v = parseMonto(e.target.value); e.target.value = v ? fmtNum(v) : ''; } actualizarImport(fi); return; }
  const f = e.target.closest('#f-mov, #f-pago'); if (!f) return;
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
