'use strict';
/* Lectura de estados de cuenta en PDF. El archivo se procesa solo en el navegador:
   nunca se envía a un servidor. Cada banco necesita su propio formato. */
window.FinImport = (() => {
  const NUM = '-?\\d{1,3}(?:\\.\\d{3})*';
  const n = s => parseInt(String(s).replace(/\./g, ''), 10);
  const iso = d => { const [a, b, c] = d.split('/'); return `${c.length === 2 ? '20' + c : c}-${b}-${a}`; };
  const MES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
  const mesCol = s => { if (!s) return null; const [m, y] = s.split('-'); return MES[m] ? `${y}-${String(MES[m]).padStart(2, '0')}` : null; };
  const sigMes = m => { let [y, mo] = m.split('-').map(Number); mo++; if (mo > 12) { mo = 1; y++; } return `${y}-${String(mo).padStart(2, '0')}`; };
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();

  // Agrupa el texto por posición vertical para reconstruir las filas de cada tabla
  async function leerFilas(buffer, password) {
    const pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', document.baseURI).href;
    const tarea = pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), password, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
    try {
      const doc = await tarea.promise;
      const filas = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const { items } = await (await doc.getPage(p)).getTextContent();
        const it = items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
        it.sort((a, b) => b.y - a.y || a.x - b.x);
        let cur = [];
        const cerrar = () => { if (cur.length) { filas.push(cur.sort((a, b) => a.x - b.x).map(c => c.s).join(' ')); cur = []; } };
        for (const i of it) { if (cur.length && Math.abs(i.y - cur[0].y) > 2.5) cerrar(); cur.push(i); }
        cerrar();
      }
      return filas;
    } finally { await tarea.destroy(); }
  }

  function lineasCMR(filas) {
    const re = new RegExp(`(\\d{2}/\\d{2}/\\d{4})\\s+(.+?)\\s+(?:(?:T|A\\d)\\s+)?(${NUM})\\s+(${NUM})\\s+(\\d{2})/(\\d{2})(?:\\s+([a-z]{3}-\\d{4}))?(?:\\s+(${NUM}))?\\s*$`);
    const reCargo = new RegExp(`(\\d{2}/\\d{2}/\\d{4})\\s+(.+?)\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s*$`);
    const out = [];
    for (const f of filas) {
      let m = f.match(re);
      if (m) { out.push({ fecha: iso(m[1]), desc: m[2].trim(), compra: n(m[3]), total: n(m[4]), n: +m[5], de: +m[6], primerMes: mesCol(m[7]), monto: m[8] ? n(m[8]) : 0 }); continue; }
      m = /impuesto|comisi|interes|inter.s|servicio/i.test(f) && f.match(reCargo);
      if (m) out.push({ fecha: iso(m[1]), desc: m[2].trim(), compra: n(m[3]), total: n(m[4]), n: 1, de: 1, monto: n(m[5]) });
    }
    return out;
  }
  function lineasNacional(filas) {
    const re = new RegExp(`(\\d{2}/\\d{2}/\\d{2})\\s+(\\d{9,})\\s+(.+?)\\s+\\$\\s*(${NUM})\\s+\\$\\s*(${NUM})\\s+(\\d{2})/(\\d{2})\\s+\\$\\s*(${NUM})\\s*$`);
    const out = [];
    for (const fila of filas) {
      const f = fila.replace(/-\s*\$\s*(?=\d)/g, '$$ -'); // Acepta "-$ 100" además de "$ -100"
      const m = f.match(re);
      if (m) out.push({ fecha: iso(m[1]), desc: m[3].replace(/\s+TASA.*$/, '').trim(), compra: n(m[4]), total: n(m[5]), n: +m[6], de: +m[7], monto: n(m[8]) });
    }
    return out;
  }

  // Sugiere qué hacer con cada línea; la persona lo confirma en la pantalla de revisión
  function clasificar(lineas, mes) {
    // Un monto negativo siempre es un abono. Con monto positivo, se reconoce por su descripción
    const pagos = lineas.filter(l => l.compra < 0 || l.total < 0 || l.monto < 0 || /^(pago|abono)\b|monto cancelado|pago tarjeta|nota de cr[eé]dito|reversa/i.test(l.desc));
    for (const p of pagos) p.pago = Math.abs(p.compra || p.total || p.monto);
    for (const l of lineas) {
      if (pagos.includes(l)) {
        l.accion = 'ignorar'; l.monto = l.pago;
        l.aviso = 'Es un pago o abono a la tarjeta: no se suma a la deuda. Si fue una compra, cámbialo.';
        continue;
      }
      if (/impuesto|comisi[oó]n|inter[eé]s|servicio administraci/i.test(l.desc)) { l.accion = 'cargo'; continue; }
      if (l.n === 0) {
        if (lineas.some(o => o !== l && o.n > 0 && norm(o.desc) === norm(l.desc) && o.total === l.total)) {
          l.accion = 'ignorar'; l.aviso = 'Es la misma compra de otra línea, informada de nuevo por el banco.'; continue;
        }
        l.accion = 'cuotas'; l.primerMes = l.primerMes || sigMes(mes);
        l.monto = l.monto || Math.round(l.total / l.de);
        l.aviso = `Aún no se cobra: según el banco, la primera cuota parte en ${l.primerMes}. No suma a este estado de cuenta.`;
        continue;
      }
      if (l.de > 1) { l.accion = 'cuotas'; continue; }
      l.accion = 'compra';
      if (pagos.some(p => p.fecha === l.fecha && p.pago === l.compra)) {
        l.accion = 'ignorar';
        l.aviso = 'Coincide con un pago de la tarjeta del mismo día y monto. Revisa si fue una compra real.';
      }
    }
    return lineas;
  }

  function analizar(filas) {
    filas = filas.map(f => f.replace(/[\u2212\u2013](?=\s*\$?\s*\d)/g, '-'));
    const t = filas.join('\n'), dato = re => { const m = t.match(re); return m ? m[1] : null; };
    let r = null;
    if (/BancoFalabella|Fpuntos|Pago tarjeta cmr/i.test(t)) {
      const vence = dato(/Pagar Hasta\s+(\d{2}\/\d{2}\/\d{4})/i), total = dato(new RegExp(`Monto Total Facturado a Pagar\\s+\\$?(${NUM})`, 'i'));
      if (vence && total) r = { nombre: 'CMR Falabella', clave: /cmr|falabella/i, vence: iso(vence), total: n(total), minimo: n(dato(new RegExp(`Monto m.nimo a pagar\\s+\\$?(${NUM})`, 'i')) || 0), lineas: lineasCMR(filas) };
    } else if (/ESTADO DE CUENTA NACIONAL DE TARJETA DE CR.DITO/i.test(t)) {
      const vence = dato(/(\d{2}\/\d{2}\/\d{4})\s+\$\s*[\d.]+\s+\d{2}\/\d{2}\/\d{4}/), total = dato(new RegExp(`MONTO TOTAL FACTURADO A PAGAR\\s+\\(A\\+B\\+C\\+D\\)\\s+\\$\\s*(${NUM})`));
      if (vence && total) r = { nombre: 'BCI', clave: /bci/i, vence: iso(vence), total: n(total), minimo: n(dato(new RegExp(`MONTO M.NIMO A PAGAR\\s+\\$\\s*(${NUM})`)) || 0), lineas: lineasNacional(filas) };
    }
    if (!r || !r.lineas.length) return null;
    r.mes = r.vence.slice(0, 7);
    clasificar(r.lineas, r.mes);
    return r;
  }

  return { leerFilas, analizar };
})();
