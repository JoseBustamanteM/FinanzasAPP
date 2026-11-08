'use strict';
/* Lectura de fotos o capturas del detalle de una compra en la app del banco.
   El texto se reconoce en el mismo dispositivo con Tesseract (vendor/ocr):
   la imagen nunca se envía a un servidor. */
window.FinFoto = (() => {
  const base = new URL('vendor/ocr/', document.baseURI).href;
  let cargando = null, worker = null;

  function cargarLibreria() {
    if (window.Tesseract) return Promise.resolve();
    return cargando || (cargando = new Promise((ok, mal) => {
      const s = document.createElement('script');
      s.src = base + 'tesseract.min.js';
      s.onload = ok; s.onerror = () => { cargando = null; mal(new Error('No se pudo cargar el lector de fotos. Revisa tu conexión.')); };
      document.head.appendChild(s);
    }));
  }
  async function obtenerWorker(progreso) {
    await cargarLibreria();
    if (!worker) {
      worker = await window.Tesseract.createWorker('spa', 1, {
        workerPath: base + 'worker.min.js', corePath: base, langPath: base.replace(/\/$/, ''),
        workerBlobURL: false, gzip: true,
        logger: m => { if (progreso && m.status === 'recognizing text') progreso(m.progress); },
      });
    }
    return worker;
  }

  const n = s => parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0;
  const MONTO = '\\$\\s?(\\d{1,3}(?:[.,]\\d{3})+|\\d{1,9})';
  const ETIQUETA = /^(c[oó]digo|origen|categor[ií]a|fecha|tarjeta|cuotas?\b|n[°ºo]?\s*de cuotas|valor|monto|tipo|estado|¿necesitas|necesitas)/i;
  const limpiar = s => s.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Extrae los datos de la compra del texto reconocido
  function analizar(texto) {
    const lineas = texto.split('\n').map(limpiar).filter(Boolean);
    const todo = lineas.join('\n');
    const r = { texto: todo };

    // Cada dato se busca dentro de una línea: así una hora como "22:38" no se confunde con la línea siguiente
    const reMonto = new RegExp(MONTO), reSolo = new RegExp(`^${MONTO}$`), reDudoso = /^[5S8s]\s?\d{1,3}(?:[.,]\d{3})+$/;
    // Sin "$": el signo pudo leerse como 5, S u 8 ("551.990" en vez de "$51.990")
    const valorLinea = l => (l === undefined ? 0 : reSolo.test(l) ? n(l) : reDudoso.test(l) ? n(l.slice(1)) : 0);
    // Un dato con etiqueta: "Monto total $150.000", o la etiqueta bajo el número grande ("$56.759" / "Valor cuota")
    const etiquetado = re => {
      for (let k = 0; k < lineas.length; k++) {
        if (!re.test(lineas[k])) continue;
        const m = lineas[k].match(reMonto);
        if (m) return n(m[1]);
        const v = valorLinea(lineas[k - 1]) || valorLinea(lineas[k + 1]);
        if (v) return v;
      }
      return 0;
    };
    const total = etiquetado(/monto\s*total|total\s*(?:de\s*la\s*)?compra|monto\s*(?:de\s*la\s*)?compra|monto\s*original|monto\s*financiado/i);
    let valor = etiquetado(/(?:valor|monto)\s*(?:de\s*(?:la|cada)\s*)?cuota/i);
    if (!valor) { const v = todo.match(new RegExp(`\\d[ \\t]*cuotas?[ \\t]*de[ \\t]*${MONTO}`, 'i')); if (v) valor = n(v[1]); }

    let cuotas = 0, actual = 0;
    for (let k = 0; k < lineas.length && !cuotas; k++) {
      const l = lineas[k];
      let m = l.match(/\bcuotas?[ \t:]*(\d{1,2})[ \t]*(?:de|\/)[ \t]*(\d{1,2})\b/i)
        || (/^cuotas?:?$/i.test(lineas[k - 1] || '') && l.match(/^(\d{1,2})[ \t]*(?:de|\/)[ \t]*(\d{1,2})$/));
      if (m) { actual = +m[1]; cuotas = +m[2]; break; }
      m = l.match(/n[°ºo]?[ \t]*(?:de[ \t]*)?cuotas?[ \t:]*(\d{1,2})\b/i) || l.match(/^cuotas?[ \t:]+(\d{1,2})$/i) || l.match(/\b(\d{1,2})[ \t]*cuotas?\b/i);
      if (m) cuotas = +m[1];
    }
    if (cuotas >= 1 && cuotas <= 72) { r.cuotas = cuotas; if (actual >= 1 && actual <= cuotas) r.cuotaActual = actual; }
    if (valor) r.valorCuota = valor;

    // El número grande del detalle: es el monto, salvo que el banco indique que es el valor de la cuota
    const iSolo = lineas.findIndex(l => reSolo.test(l)), iDudoso = lineas.findIndex(l => reDudoso.test(l));
    const soloMonto = lineas[iSolo], dudoso = iSolo < 0 && lineas[iDudoso];
    const grande = soloMonto ? n(soloMonto) : 0;
    const algunMonto = todo.match(reMonto);
    if (total) r.monto = total;
    else if (grande && grande !== valor) r.monto = grande;
    else if (valor && r.cuotas) r.monto = valor * r.cuotas;
    else if (grande || algunMonto) r.monto = grande || n(algunMonto[1]);
    if (dudoso && !total) { const d = n(dudoso.slice(1)); if (d !== valor) r.montoDudoso = d; }

    const reFecha = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/;
    const f = (lineas.find(l => /fecha/i.test(l) && reFecha.test(l)) || todo).match(reFecha);
    if (f) {
      const y = f[3].length === 2 ? '20' + f[3] : f[3], mo = +f[2], d = +f[1];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) r.fecha = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    // Comercio: lo que sigue a la etiqueta "Comercio", aunque ocupe dos líneas
    const i = lineas.findIndex(l => /^comercio\b/i.test(l));
    if (i >= 0) {
      const partes = [lineas[i].replace(/^comercio\s*:?\s*/i, '')];
      for (let j = i + 1; j < lineas.length && j <= i + 2 && !ETIQUETA.test(lineas[j]) && !/\d{2}[/-]\d{2}/.test(lineas[j]); j++) partes.push(lineas[j]);
      r.comercio = limpiar(partes.join(' '));
    }
    // Sin etiqueta: el título que va justo antes del monto
    if (!r.comercio && (soloMonto || dudoso)) {
      const k = lineas.indexOf(soloMonto || dudoso), titulo = [];
      for (let j = k - 1; j >= 0 && titulo.length < 2 && !/detalle|movimiento/i.test(lineas[j]); j--) titulo.unshift(lineas[j]);
      if (titulo.length) r.comercio = limpiar(titulo.join(' '));
    }
    if (r.comercio) r.comercio = r.comercio.replace(/^[^\wÁÉÍÓÚÑáéíóúñ*]+/, '').slice(0, 120);

    r.sinInteres = /sin\s*inter[eé]s/i.test(todo);
    return r;
  }

  // El navegador decodifica la imagen (también HEIC en iPhone) y se le entrega a Tesseract como canvas
  async function aCanvas(archivo) {
    const url = URL.createObjectURL(archivo);
    try {
      const img = new Image(); img.src = url;
      await img.decode().catch(() => { throw new Error('No se pudo abrir la imagen. Prueba con una captura de pantalla.'); });
      const escala = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * escala); c.height = Math.round(img.naturalHeight * escala);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
  async function leer(archivo, progreso) {
    const [w, canvas] = await Promise.all([obtenerWorker(progreso), aCanvas(archivo)]);
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    const r = analizar((await w.recognize(canvas)).data.text || '');
    if (!r.monto) {
      // El monto grande a veces se pierde con el diseño de la pantalla: se busca de nuevo como texto disperso
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const otra = analizar((await w.recognize(canvas)).data.text || '');
      r.monto = otra.monto || r.montoDudoso || otra.montoDudoso;
      for (const k of ['cuotas', 'valorCuota', 'fecha']) if (!r[k] && otra[k]) r[k] = otra[k];
    }
    return r;
  }

  return { leer, analizar };
})();
