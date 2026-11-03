/**
 * OEE Planta — Backend de Google Apps Script
 * ============================================
 * Conecta un Google Sheet con la app OEE_Planta.html (doGet = punto de
 * entrada web). Protocolo (JSONP):
 *
 *   ?action=read&sheet=NOMBRE[&since=YYYY-MM-DD]       -> filas de UNA hoja
 *   ?action=readAll&sheets=A,B,C[&since=YYYY-MM-DD]    -> varias hojas en UNA llamada
 *   ?action=write&sheet=NOMBRE&data={...}              -> agrega UNA fila
 *   ?action=upsert&sheet=NOMBRE&data={...}[&ifNewer=1] -> actualiza la fila con ese "id" o la agrega
 *                                                         (con ifNewer=1 no pisa una fila con updatedAt MÁS NUEVO: lo usan los reintentos)
 *   ?action=writeAll&sheet=NOMBRE&data=[...]           -> reemplaza TODO el contenido de la hoja
 *   ?action=delete&sheet=NOMBRE&id=...                 -> borra la fila con ese "id"
 *   ?action=ping[&detail=1]                            -> prueba de conexión (versión, build y resumen)
 *   ?action=login&username=...&password=...            -> verifica la cuenta y entrega el token de sesión
 *   ?action=setPassword&id=...&password=...            -> cambia la contraseña de una cuenta (administrador de cuentas)
 *
 *   Todas las acciones, salvo ping y login, llevan &t=TOKEN. Sin token válido
 *   no se lee ni se escribe nada (respuesta con auth:"sesion").
 *
 * ── QUÉ CAMBIÓ EN ESTA VERSIÓN (login seguro, 2026-11-03) ──
 *  • Las contraseñas ya no salen del servidor: la hoja Usuarios se entrega sin
 *    la columna password y el login se verifica aquí.
 *  • Las contraseñas se guardan cifradas (hash con sal y una clave secreta que
 *    vive en Propiedades del script). Las que estaban en texto se cifran solas
 *    en el primer inicio de sesión después de instalar esta versión.
 *  • Cada petición lleva un token firmado que vence en 120 días y se renueva solo
 *    mientras se use. Cambiar la contraseña o desactivar la cuenta lo invalida.
 *  • Solo quien administra cuentas (Ingeniero, o Líder con el permiso
 *    «Usuarios») puede crear, editar o borrar cuentas.
 *  • 5 intentos fallidos seguidos bloquean esa cuenta 10 minutos.
 *  • Menú OEE Planta → Cuentas: restablecer una contraseña desde el Sheet.
 *
 * ── VERSIONES ANTERIORES (depuración) ──
 *  • Solo se aceptan las hojas que la plataforma realmente usa (HOJAS, abajo).
 *    Un cliente viejo o con errores ya no puede crear hojas basura ni escribir
 *    en hojas retiradas (p. ej. "Mantenimiento").
 *  • Lecturas más rápidas: el filtro "since" lee primero SOLO la columna fecha
 *    y trae únicamente las filas recientes; Programa_Dia (la más pesada) se
 *    limita a los últimos días aunque la app no pida ventana.
 *  • Filtro de fechas por TEXTO (YYYY-MM-DD): ya no depende de la zona horaria
 *    del proyecto (antes podía descartar las filas del día límite).
 *  • Escrituras con candado: dos dispositivos escribiendo a la vez ya no
 *    duplican encabezados ni filas.
 *  • writeAll ya no vacía la hoja antes de escribir (nadie lee una hoja vacía a
 *    medias) y se rechaza vaciar Usuarios o Mant_Plan.
 *  • Contraseñas y fechas se guardan como texto (una contraseña "0452" ya no se
 *    convierte en 452).
 *  • Se eliminó migrarHojaUsuarios(): reescribía Usuarios con el esquema viejo y
 *    habría borrado centros, permisos y permisos de captura.
 *  • Hoja Materiales_Config (calibres de lámina y tipos de tubular compartidos entre dispositivos).
 *  • Hoja Maquina_Predeterminada (máquina que cada usuario abre al iniciar sesión) y reintentos
 *    seguros con ifNewer=1: un envío rezagado ya no pisa una versión más nueva.
 *  • Menú "OEE Planta" dentro del Sheet con herramientas de mantenimiento
 *    (diagnóstico, depurar, archivar). Todas muestran primero una VISTA
 *    PREVIA y respaldan cada hoja antes de modificarla.
 *
 * ── INSTALACIÓN ──
 * 1. Abre tu Google Sheet → Extensiones → Apps Script.
 * 2. Borra el código anterior, pega TODO este archivo y guarda.
 * 3. Implementar → Administrar implementaciones → ✎ → Versión: "Nueva versión"
 *    → Implementar (la URL no cambia).
 * 4. Confirma: abre  TU_URL?action=ping&callback=x  → debe mostrar
 *    "build":"2026-11-03a-login-seguro".  Si no aparece, la implementación sigue
 *    sirviendo el código anterior: repite el paso 3.
 * 5. Cierra y vuelve a abrir el Sheet: aparece el menú "OEE Planta".
 */

// Protocolo: debe coincidir con EXPECTED_GAS_VERSION de OEE_Planta.html
// (no cambiarlo salvo que cambie el protocolo; si no, la app avisa "backend desactualizado").
const SCRIPT_VERSION = '2026-11-03a';
// Identifica ESTE código (sirve para confirmar con ?action=ping que ya se actualizó).
const BUILD = '2026-11-03a-login-seguro';

const LECTURA_MAX_FILAS = 3000;   // tope de filas (las más recientes) por lectura
const ESPERA_BLOQUEO_MS = 20000;  // cuánto espera una escritura si hay otra en curso

/**
 * HOJAS que usa la plataforma. Para cada una:
 *   clave         columnas que identifican un registro (para quitar duplicados)
 *   maxDias       tope de antigüedad al leer (aunque la app pida más)
 *   archivarDias  Archivar registros más viejos que esto (menú OEE Planta)
 *   vacios        tipo de registro "en cero" que se puede depurar ('oee' | 'hora')
 *   protegida     no se permite vaciarla con writeAll
 *   texto         columnas que deben guardarse como texto plano
 * Si agregas una hoja NUEVA a la plataforma, agrégala aquí.
 */
const HOJAS = (function () {
  const h = {
    Usuarios:           { clave: ['id'], protegida: true, texto: ['password', 'username'] },
    Maquinas_Config:    { clave: ['id'] },
    Maquina_Predeterminada: { clave: ['id'] },   // máquina predeterminada de cada usuario en Registrar turno (id = id de la cuenta)
    Materiales_Config:        { clave: ['id'], texto: ['sku'] }, // catálogo de calibres de lámina y tipos de tubular (una fila por material; deleted = eliminado)
    Mant_Plan:          { clave: ['ct', 'mach'], protegida: true },   // actividades del checklist de arranque
    CT_Targets:         { clave: ['id'] },
    OEE_Registros:      { clave: ['id'], archivarDias: 120, vacios: 'oee' },
    Cierre_Dia:         { clave: ['id'], archivarDias: 120 },
    Checklist_Arranque: { clave: ['id'], archivarDias: 120 },
    Programa_Dia:       { clave: ['id'], maxDias: 120, archivarDias: 120 }, // el programa vigente se conserva hasta que se suba otro (la app pide solo lo reciente en cada consulta)
    Aprovechamiento:    { clave: ['id'] },
    Merma_Semanal:      { clave: ['id'], texto: ['weekStart'] },
    Atrasos:            { clave: ['id'], archivarDias: 180 }
  };
  ['Troqueles', 'Laser', 'Muebles', 'Sillas', 'Mamparas'].forEach(function (ct) {
    h['Produccion_' + ct] = { clave: ['id'], archivarDias: 120, vacios: 'hora' };   // hora por hora por centro de trabajo
  });
  return h;
})();

// Hojas que ya no se usan (se pueden ocultar con Depurar; nunca se borran solas).
const HOJAS_OBSOLETAS = ['Mantenimiento'];

// Claves de permiso que ya no existen en la plataforma (se limpian de Usuarios.permissions).
const PERMISOS_OBSOLETOS = ['mantenimiento', 'mant-registro', 'mant-historial', 'mant-cumplimiento',
                            'reg-hora-captura', 'reg-dia-captura', 'aprov-captura'];
const CAPTURA_VALIDA = ['hora', 'dia', 'aprov'];

// ══════════════════════════════════════════════════════════════════
//  PUNTO DE ENTRADA
// ══════════════════════════════════════════════════════════════════

function doGet(e) {
  const cb = String((e.parameter && e.parameter.callback) || 'callback');
  const callback = /^[A-Za-z0-9_$.]+$/.test(cb) ? cb : 'callback';   // evita inyectar código en la respuesta
  let payload;
  try {
    payload = handleRequest(e.parameter || {});
  } catch (err) {
    payload = { error: String(err && err.message ? err.message : err) };
    if (err && err.auth) payload.auth = err.auth;   // 'login' | 'sesion' | 'permiso'
  }
  payload.version = SCRIPT_VERSION;
  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(payload) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function handleRequest(params) {
  const action = params.action;

  if (action === 'ping') {
    const out = { ok: true, time: new Date().toISOString(), build: BUILD };
    if (params.detail) out.hojas = resumenHojas();
    return out;
  }

  secreto_();   // antes de cualquier candado: la clave se crea una sola vez y con su propio candado

  if (action === 'login') return iniciarSesion_(params.username, params.password);

  // Todo lo demás requiere una sesión válida.
  const sesion = validarSesion_(params.t);
  const out = atenderAccion_(action, params, sesion);
  if (sesion.renovado && !out.tok) out.tok = sesion.renovado;
  return out;
}

function atenderAccion_(action, params, sesion) {
  if (action === 'setPassword') {
    exigirAdminCuentas_(sesion);
    const pw = String(params.password === undefined || params.password === null ? '' : params.password);
    if (pw.trim().length < 4) throw new Error('La contraseña debe tener al menos 4 caracteres.');
    const hash = guardarHash_(params.id, pw);
    // Si cambió su propia contraseña, su token anterior deja de valer: se le entrega uno nuevo.
    return String(params.id) === String(sesion.id) ? { ok: true, tok: firmarToken_(sesion.id, huella_(hash)) } : { ok: true };
  }

  // Varias hojas en UNA sola ejecución (evita encolar una petición por hoja).
  if (action === 'readAll') {
    const names = String(params.sheets || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    const results = {};
    names.forEach(function (name) {
      try {
        results[name] = leerHoja(name, params.since);
      } catch (err) {
        results[name] = { __error: String(err && err.message ? err.message : err) };
      }
    });
    return { results: results };
  }

  const sheetName = params.sheet;
  if (!sheetName) throw new Error('Falta el parámetro "sheet"');
  if (sheetName === 'Usuarios' && action !== 'read') exigirAdminCuentas_(sesion);

  if (action === 'read')     return { rows: leerHoja(sheetName, params.since) };
  if (action === 'write')    { escribirFila(sheetName, parseJSON(params.data, {}), false); return { ok: true }; }
  if (action === 'upsert')   {
    const r = escribirFila(sheetName, parseJSON(params.data, {}), true, params.ifNewer === '1');
    return (r && r.skipped) ? { ok: true, skipped: true } : { ok: true };
  }
  if (action === 'writeAll') { reemplazarHoja(sheetName, parseJSON(params.data, [])); return { ok: true }; }
  if (action === 'delete')   { borrarFila(sheetName, params.id); return { ok: true }; }

  throw new Error('Acción no reconocida: ' + action);
}

function parseJSON(text, vacio) {
  if (text === undefined || text === null || text === '') return vacio;
  try { return JSON.parse(text); } catch (e) { throw new Error('El parámetro "data" no es JSON válido'); }
}

function requireHoja(name) {
  if (!Object.prototype.hasOwnProperty.call(HOJAS, name)) {
    throw new Error('Hoja no reconocida: "' + name + '". Si es una hoja nueva de la plataforma, agrégala a HOJAS en el script.');
  }
  return HOJAS[name];
}

// Todas las escrituras pasan por aquí: una a la vez.
function conBloqueo(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(ESPERA_BLOQUEO_MS)) {
    throw new Error('El servidor está ocupado con otra escritura; intenta de nuevo en unos segundos.');
  }
  try { return fn(); } finally { lock.releaseLock(); }
}

// ══════════════════════════════════════════════════════════════════
//  CUENTAS Y SESIÓN
//  La contraseña nunca sale del servidor: se guarda cifrada (hash con sal y
//  una clave secreta que vive en Propiedades del script) y el login se
//  verifica aquí. Al entrar, la app recibe un token firmado que acompaña cada
//  petición; sin token válido no se lee ni se escribe nada.
// ══════════════════════════════════════════════════════════════════

const TOKEN_DIAS = 120;            // vigencia del token de sesión
const TOKEN_RENOVAR_DIAS = 7;      // un token con más de esto se renueva solo en la siguiente petición
const HASH_PREFIJO = 'h1$';
const HASH_VUELTAS = 200;
const LOGIN_INTENTOS = 5;          // intentos fallidos seguidos antes de bloquear la cuenta un rato
const LOGIN_BLOQUEO_SEG = 600;
const CUENTAS_CACHE_SEG = 300;     // cada cuánto se relee la hoja Usuarios para validar sesiones
const CUENTAS_CACHE_KEY = 'cuentas_sesion_v1';
const ROLES = { operator: 'operador', operador: 'operador', op: 'operador', leader: 'lider', lider: 'lider', 'líder': 'lider',
                lead: 'lider', engineer: 'ingeniero', ingeniero: 'ingeniero', ing: 'ingeniero' };

// tipo: 'login' (datos de acceso incorrectos) | 'sesion' (hay que volver a entrar) | 'permiso' (la cuenta no puede hacer esto)
function errorSesion_(msg, tipo) { const e = new Error(msg); e.auth = tipo; return e; }

let _secreto = null;
function secreto_() {
  if (_secreto) return _secreto;
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('AUTH_SECRET');
  if (!s) {
    conBloqueo(function () {   // dos peticiones simultáneas no deben crear dos claves distintas
      s = props.getProperty('AUTH_SECRET');
      if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('AUTH_SECRET', s); }
    });
  }
  return (_secreto = s);
}

function b64_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function hashContrasena_(pw, sal) {
  const clave = Utilities.newBlob(secreto_()).getBytes();
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(sal + '|' + pw).getBytes(), clave);
  for (let i = 1; i < HASH_VUELTAS; i++) h = Utilities.computeHmacSha256Signature(h, clave);
  return b64_(h);
}
function esHash_(v) { return String(v === null || v === undefined ? '' : v).indexOf(HASH_PREFIJO) === 0; }
function cifrar_(pw) {
  const sal = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  return HASH_PREFIJO + sal + '$' + hashContrasena_(String(pw), sal);
}
function verificar_(pw, guardada) {
  guardada = String(guardada === null || guardada === undefined ? '' : guardada);
  if (guardada === '') return false;
  if (!esHash_(guardada)) return guardada === String(pw);   // contraseña vieja todavía sin cifrar
  const p = guardada.split('$');                            // ['h1', sal, hash]
  return p.length === 3 && hashContrasena_(String(pw), p[1]) === p[2];
}

// Cuentas tal como están en la hoja (con contraseña). Solo para uso interno del servidor.
function cuentas_() {
  const sheet = ss_().getSheetByName('Usuarios');
  const out = { sheet: sheet, headers: [], lista: [] };
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return out;
  const v = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  out.headers = v[0].map(String);
  for (let i = 1; i < v.length; i++) {
    if (filaVacia(v[i])) continue;
    const o = filaAObjeto(out.headers, v[i]);
    o._fila = i + 1;
    out.lista.push(o);
  }
  return out;
}
function contrasenaDe_(c) {
  const v = (c.password !== undefined && c.password !== null && c.password !== '') ? c.password : c.pass;
  return v === undefined || v === null ? '' : String(v);
}
function activa_(c) { return !(c.active === false || String(c.active).toUpperCase() === 'FALSE'); }
function rolDe_(c) { return ROLES[String(c.role || '').trim().toLowerCase()] || 'operador'; }
function cuentaPublica_(c) {
  const o = {};
  Object.keys(c).forEach(function (k) { if (k !== 'password' && k !== 'pass' && k !== '_fila') o[k] = c[k]; });
  o.role = rolDe_(c);
  return o;
}
// Huella corta de la contraseña guardada: va dentro del token, así cambiarla invalida las sesiones abiertas.
function huella_(guardada) {
  return b64_(Utilities.computeHmacSha256Signature(Utilities.newBlob('pv|' + guardada).getBytes(), Utilities.newBlob(secreto_()).getBytes())).slice(0, 12);
}

// Lo mínimo para validar sesiones, en caché unos minutos (no lleva contraseñas).
function mapaCuentas_(forzar) {
  const cache = CacheService.getScriptCache();
  if (!forzar) {
    const j = cache.get(CUENTAS_CACHE_KEY);
    if (j) { try { return JSON.parse(j); } catch (e) { /* se reconstruye */ } }
  }
  const mapa = {};
  cuentas_().lista.forEach(function (c) {
    mapa[String(c.id)] = { activa: activa_(c), rol: rolDe_(c), permisos: parseObj(c.permissions) || null, pv: huella_(contrasenaDe_(c)) };
  });
  try { cache.put(CUENTAS_CACHE_KEY, JSON.stringify(mapa), CUENTAS_CACHE_SEG); } catch (e) { /* sin caché: se lee cada vez */ }
  return mapa;
}
function olvidarCuentas_() { try { CacheService.getScriptCache().remove(CUENTAS_CACHE_KEY); } catch (e) { /* nada que olvidar */ } }

// Token: idBase64 . vence(ms) . huella . firma
function firmarToken_(id, pv) {
  const base = [b64_(Utilities.newBlob(String(id)).getBytes()), Date.now() + TOKEN_DIAS * 86400000, pv].join('.');
  return base + '.' + b64_(Utilities.computeHmacSha256Signature(Utilities.newBlob(base).getBytes(), Utilities.newBlob(secreto_()).getBytes()));
}
function validarSesion_(token) {
  const p = String(token || '').split('.');
  if (p.length !== 4) throw errorSesion_('Inicia sesión para continuar.', 'sesion');
  const base = p.slice(0, 3).join('.');
  const firma = b64_(Utilities.computeHmacSha256Signature(Utilities.newBlob(base).getBytes(), Utilities.newBlob(secreto_()).getBytes()));
  if (firma !== p[3]) throw errorSesion_('La sesión no es válida. Vuelve a iniciar sesión.', 'sesion');
  const vence = Number(p[1]);
  if (!(vence > Date.now())) throw errorSesion_('Tu sesión venció. Vuelve a iniciar sesión.', 'sesion');
  let id;
  try { id = Utilities.newBlob(Utilities.base64DecodeWebSafe(p[0] + '==='.slice((p[0].length + 3) % 4))).getDataAsString(); }
  catch (e) { throw errorSesion_('La sesión no es válida. Vuelve a iniciar sesión.', 'sesion'); }
  let c = mapaCuentas_(false)[id];
  if (!c || c.pv !== p[2]) c = mapaCuentas_(true)[id];   // caché vieja: se confirma contra la hoja
  if (!c || !c.activa || c.pv !== p[2]) throw errorSesion_('Tu cuenta cambió (contraseña o baja). Vuelve a iniciar sesión.', 'sesion');
  const s = { id: id, rol: c.rol, permisos: c.permisos };
  if (vence - Date.now() < (TOKEN_DIAS - TOKEN_RENOVAR_DIAS) * 86400000) s.renovado = firmarToken_(id, c.pv);
  return s;
}

// Crear, editar o borrar cuentas: Ingeniero (salvo que se le quite el permiso) o Líder con el permiso «Usuarios».
function exigirAdminCuentas_(sesion) {
  const v = sesion.permisos ? sesion.permisos['cfg-usuarios'] : undefined;
  const puede = sesion.rol === 'ingeniero' ? v !== false : v === true;
  if (!puede) throw errorSesion_('Tu cuenta no puede administrar usuarios.', 'permiso');
}

function iniciarSesion_(usuario, pw) {
  usuario = String(usuario || '').trim().toLowerCase();
  pw = String(pw === undefined || pw === null ? '' : pw);
  if (!usuario || !pw) throw errorSesion_('Escribe tu usuario y tu contraseña.', 'login');
  const cache = CacheService.getScriptCache(), kFallos = 'login_fallos_' + usuario;
  const fallos = Number(cache.get(kFallos) || 0);
  if (fallos >= LOGIN_INTENTOS) throw errorSesion_('Demasiados intentos fallidos. Espera 10 minutos e intenta de nuevo.', 'login');
  migrarContrasenas_();
  const c = cuentas_().lista.filter(function (x) { return String(x.username || '').trim().toLowerCase() === usuario; })[0];
  if (!c || !activa_(c) || !verificar_(pw, contrasenaDe_(c))) {
    cache.put(kFallos, String(fallos + 1), LOGIN_BLOQUEO_SEG);
    throw errorSesion_('Usuario o contraseña incorrectos.', 'login');
  }
  cache.remove(kFallos);
  let guardada = contrasenaDe_(c);
  if (!esHash_(guardada)) guardada = guardarHash_(c.id, pw);   // por si quedó alguna en texto
  return { ok: true, token: firmarToken_(c.id, huella_(guardada)), user: cuentaPublica_(c) };
}

// Escribe la contraseña cifrada de una cuenta (y borra la columna vieja "pass" si existe).
function guardarHash_(id, pw) {
  const hash = cifrar_(pw);   // fuera del candado: es lo más tardado
  conBloqueo(function () {
    const cs = cuentas_();
    const c = cs.lista.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!c) throw new Error('No existe esa cuenta.');
    escribirHash_(cs, c, hash);
  });
  olvidarCuentas_();
  return hash;
}
function escribirHash_(cs, c, hash) {
  let idx = cs.headers.indexOf('password');
  if (idx === -1) { idx = cs.headers.length; cs.headers.push('password'); cs.sheet.getRange(1, idx + 1).setValue('password'); }
  const celda = cs.sheet.getRange(c._fila, idx + 1);
  celda.setNumberFormat('@');
  celda.setValue(hash);
  const pIdx = cs.headers.indexOf('pass');
  if (pIdx !== -1) cs.sheet.getRange(c._fila, pIdx + 1).setValue('');
}

// Una sola vez: cifra todas las contraseñas que sigan en texto plano.
function migrarContrasenas_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('PASS_CIFRADAS') === '1') return 0;
  secreto_();   // la clave se crea (si hace falta) antes de tomar el candado
  let n = 0;
  conBloqueo(function () {
    if (props.getProperty('PASS_CIFRADAS') === '1') return;
    const cs = cuentas_();
    cs.lista.forEach(function (c) {
      const g = contrasenaDe_(c);
      if (g === '' || esHash_(g)) return;
      escribirHash_(cs, c, cifrar_(g));
      n++;
    });
    props.setProperty('PASS_CIFRADAS', '1');
  });
  olvidarCuentas_();
  return n;
}

// La contraseña nunca se guarda en texto: una nueva se cifra; si no viene
// (la app ya no la conoce), se conserva la que ya tenía la cuenta.
function cuentaParaGuardar_(record) {
  const r = Object.assign({}, record);
  const pw = r.password === undefined || r.password === null ? '' : String(r.password);
  delete r.pass;
  r.password = (pw.trim() !== '' && !esHash_(pw)) ? cifrar_(pw) : '';
  return r;
}
function conservarContrasena_(record, sheet, headers, destino) {
  if (record.password !== '') return;
  const idx = headers.indexOf('password');
  if (destino > 0 && idx !== -1) record.password = sheet.getRange(destino, idx + 1, 1, 1).getValues()[0][0];
}

// ══════════════════════════════════════════════════════════════════
//  LECTURA
// ══════════════════════════════════════════════════════════════════

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getOrCreateSheet(name) {
  const ss = ss_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function fechaHaceDias(n) {
  return Utilities.formatDate(new Date(Date.now() - n * 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// Fecha mínima efectiva: la que pide la app, limitada por maxDias de la hoja.
function desdeEfectivo(cfg, since) {
  let desde = /^\d{4}-\d{2}-\d{2}$/.test(String(since || '')) ? String(since) : null;
  if (cfg.maxDias) {
    const limite = fechaHaceDias(cfg.maxDias);
    if (!desde || desde < limite) desde = limite;
  }
  return desde;
}

function leerHoja(name, since) {
  const cfg = requireHoja(name);
  const desde = desdeEfectivo(cfg, since);
  const rows = desde ? readSheetSince(name, desde) : readSheet(name);
  if (name === 'Usuarios') rows.forEach(function (r) { delete r.password; delete r.pass; });   // las contraseñas nunca salen del servidor
  return rows;
}

// Google Sheets a veces convierte un texto "2026-08-26" en fecha real. Al leerlo
// llega como Date; aquí se devuelve SIEMPRE como texto plano consistente.
function normalizeCellValue(value, headerName) {
  if (Object.prototype.toString.call(value) !== '[object Date]') return value;
  if (headerName === 'fecha' || headerName === 'weekStart') return fechaLocal(value);
  return value.toISOString();   // updatedAt, completedAt, etc.: texto ISO con hora
}

function fechaLocal(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 'YYYY-MM-DD' de una celda (Date o texto); null si no se puede interpretar.
function fechaComoTexto(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : fechaLocal(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v === null || v === undefined ? '' : v));
  return m ? m[1] : null;
}

function filaAObjeto(headers, row) {
  const obj = {};
  for (let j = 0; j < headers.length; j++) {
    if (headers[j] === '') continue;
    obj[headers[j]] = normalizeCellValue(row[j], headers[j]);
  }
  return obj;
}

function filaVacia(row) {
  return row.every(function (c) { return c === '' || c === null; });
}

// Lee las últimas `maxRows` filas (las más recientes); nunca todo el historial.
function readSheet(name, maxRows) {
  const sheet = ss_().getSheetByName(name);
  if (!sheet) return [];                        // la hoja aún no existe -> sin datos, sin error
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const n = Math.min(lastRow - 1, maxRows || LECTURA_MAX_FILAS);
  const values = sheet.getRange(lastRow - n + 1, 1, n, lastCol).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    if (filaVacia(values[i])) continue;
    rows.push(filaAObjeto(headers, values[i]));
  }
  return rows;
}

// Igual que readSheet, pero solo filas con fecha >= desde (texto YYYY-MM-DD).
// Lee primero ÚNICAMENTE la columna fecha, localiza la primera fila reciente y
// trae las filas completas solo desde ahí. Las filas sin fecha interpretable
// siempre se incluyen (para no perder datos por error).
function readSheetSince(name, desde) {
  const sheet = ss_().getSheetByName(name);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const fechaIdx = headers.indexOf('fecha');
  if (fechaIdx === -1) return readSheet(name);                 // sin columna fecha: no se puede filtrar

  const n = Math.min(lastRow - 1, LECTURA_MAX_FILAS);
  const start = lastRow - n + 1;
  const fechas = sheet.getRange(start, fechaIdx + 1, n, 1).getValues();
  const pasa = [];
  let primera = -1;
  for (let i = 0; i < n; i++) {
    const f = fechaComoTexto(fechas[i][0]);
    pasa[i] = (f === null) || f >= desde;
    if (pasa[i] && primera === -1) primera = i;
  }
  if (primera === -1) return [];

  const values = sheet.getRange(start + primera, 1, n - primera, lastCol).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    if (!pasa[primera + i] || filaVacia(values[i])) continue;
    rows.push(filaAObjeto(headers, values[i]));
  }
  return rows;
}

function resumenHojas() {
  const out = { activas: {}, obsoletas: [], noReconocidas: [] };
  ss_().getSheets().forEach(function (s) {
    const n = s.getName();
    if (Object.prototype.hasOwnProperty.call(HOJAS, n)) out.activas[n] = { filas: Math.max(0, s.getLastRow() - 1), columnas: s.getLastColumn() };
    else if (HOJAS_OBSOLETAS.indexOf(n) !== -1) out.obsoletas.push(n);
    else if (!/^(RESPALDO_|Archivo_|OBSOLETA_)/.test(n)) out.noReconocidas.push(n);
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  ESCRITURA (siempre con candado)
// ══════════════════════════════════════════════════════════════════

// Los objetos/arreglos anidados ya llegan como texto JSON desde la app; si llega
// uno real se convierte a texto para que quepa en una celda.
function stringifyIfNeeded(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

// Fuerza texto plano en las columnas de fecha/contraseña de la fila destino
// ANTES de escribirla, para que Sheets no las convierta (p. ej. "0452" -> 452).
function formatoTexto(sheet, headers, cfg, fila) {
  const cols = ['fecha'].concat(cfg.texto || []);
  cols.forEach(function (c) {
    const idx = headers.indexOf(c);
    if (idx !== -1) sheet.getRange(fila, idx + 1, 1, 1).setNumberFormat('@');
  });
}

// write (agrega) y upsert (actualiza por "id" o agrega). Crea encabezados si la
// hoja está vacía y agrega al final las columnas nuevas que traiga el registro.
function escribirFila(name, record, upsert, soloSiMasNuevo) {
  const cfg = requireHoja(name);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('El registro no es un objeto');
  if (name === 'Usuarios') record = cuentaParaGuardar_(record);   // cifra aquí, fuera del candado
  const r = conBloqueo(function () {
    const sheet = getOrCreateSheet(name);
    let lastRow = sheet.getLastRow();
    let headers;
    if (lastRow === 0) {
      headers = Object.keys(record);
      sheet.appendRow(headers);
      lastRow = 1;
    } else {
      headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const nuevas = Object.keys(record).filter(function (k) { return headers.indexOf(k) === -1; });
      if (nuevas.length) {
        headers = headers.concat(nuevas);
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      }
    }

    let destino = -1;
    const idCol = headers.indexOf('id');
    if (upsert && idCol !== -1 && record.id !== undefined && lastRow > 1) {
      const ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
      // de abajo hacia arriba: lo más probable es editar un registro reciente
      for (let i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === String(record.id)) { destino = i + 2; break; }
      }
    }
    // Reintento seguro: si la hoja ya tiene una versión MÁS NUEVA de este registro, no se pisa.
    if (soloSiMasNuevo && destino > 0 && record.updatedAt && tiempo(record.updatedAt) > 0) {
      const uIdx = headers.indexOf('updatedAt');
      if (uIdx !== -1 && tiempo(sheet.getRange(destino, uIdx + 1, 1, 1).getValues()[0][0]) > tiempo(record.updatedAt)) return { skipped: true };
    }
    if (name === 'Usuarios') conservarContrasena_(record, sheet, headers, destino);
    formatoTexto(sheet, headers, cfg, destino > 0 ? destino : lastRow + 1);
    const fila = headers.map(function (h) { return stringifyIfNeeded(record[h]); });
    if (destino > 0) sheet.getRange(destino, 1, 1, headers.length).setValues([fila]);
    else sheet.appendRow(fila);
  });
  if (name === 'Usuarios') olvidarCuentas_();
  return r;
}

function borrarFila(name, id) {
  requireHoja(name);
  const r = borrarFilaConBloqueo_(name, id);
  if (name === 'Usuarios') olvidarCuentas_();
  return r;
}

function borrarFilaConBloqueo_(name, id) {
  return conBloqueo(function () {
    const sheet = ss_().getSheetByName(name);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const idCol = headers.indexOf('id');
    if (idCol === -1) return;
    const ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) { sheet.deleteRow(i + 2); return; }   // si no está, no hace nada
    }
  });
}

// Reemplaza TODO el contenido. Escribe lo nuevo ENCIMA y solo después limpia lo
// que sobre — nunca hay un instante con la hoja vacía.
function reemplazarHoja(name, records) {
  const cfg = requireHoja(name);
  if (!Array.isArray(records)) throw new Error('writeAll espera una lista de registros');
  if (name === 'Usuarios') throw new Error('La hoja Usuarios no se reemplaza completa: se edita cuenta por cuenta.');
  if (cfg.protegida && !records.length) throw new Error('Por seguridad no se permite vaciar la hoja "' + name + '".');
  return conBloqueo(function () {
    const sheet = getOrCreateSheet(name);
    if (!records.length) { sheet.clear(); return; }
    const set = {};
    records.forEach(function (r) { Object.keys(r).forEach(function (k) { set[k] = true; }); });   // unión de llaves
    const headers = Object.keys(set);
    const filas = records.map(function (r) { return headers.map(function (h) { return stringifyIfNeeded(r[h]); }); });
    escribirMatriz(sheet, cfg, headers, filas);
  });
}

// Escribe encabezados + filas sobre la hoja y limpia el sobrante (sin vaciarla antes).
function escribirMatriz(sheet, cfg, headers, filas) {
  const nFilas = filas.length + 1, nCols = headers.length;
  if (sheet.getMaxRows() < nFilas) sheet.insertRowsAfter(sheet.getMaxRows(), nFilas - sheet.getMaxRows());
  if (sheet.getMaxColumns() < nCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), nCols - sheet.getMaxColumns());
  const filasAntes = sheet.getLastRow(), colsAntes = sheet.getLastColumn();
  ['fecha'].concat(cfg.texto || []).forEach(function (c) {      // columnas de texto: formato ANTES de escribir
    const idx = headers.indexOf(c);
    if (idx !== -1 && filas.length) sheet.getRange(2, idx + 1, filas.length, 1).setNumberFormat('@');
  });
  sheet.getRange(1, 1, nFilas, nCols).setValues([headers].concat(filas));
  if (filasAntes > nFilas) sheet.getRange(nFilas + 1, 1, filasAntes - nFilas, Math.max(colsAntes, nCols)).clearContent();
  if (colsAntes > nCols) sheet.getRange(1, nCols + 1, Math.min(filasAntes, nFilas), colsAntes - nCols).clearContent();
}

// ══════════════════════════════════════════════════════════════════
//  MANTENIMIENTO DEL SHEET (menú "OEE Planta")
//  Todo trabaja en dos pasos: VISTA PREVIA (no cambia nada) y APLICAR
//  (respalda cada hoja que modifica en una hoja oculta RESPALDO_...).
// ══════════════════════════════════════════════════════════════════

function leerTodo(sheet) {
  const lr = sheet.getLastRow(), lc = sheet.getLastColumn();
  if (lr < 1 || lc < 1) return { headers: [], rows: [] };
  const v = sheet.getRange(1, 1, lr, lc).getValues();
  return { headers: v[0].map(function (h) { return String(h); }), rows: v.slice(1).filter(function (r) { return !filaVacia(r); }) };
}

function tiempo(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getTime();
  const t = Date.parse(String(v || ''));
  return isNaN(t) ? 0 : t;
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// Misma regla que la plataforma: gana la fila con updatedAt más reciente; si
// empatan o no hay fecha de edición, gana la que está más abajo.
function quitarDuplicados(headers, rows, clave) {
  const idx = clave.map(function (c) { return headers.indexOf(c); });
  if (idx.some(function (i) { return i === -1; })) return { rows: rows, quitadas: 0 };
  const uIdx = headers.indexOf('updatedAt');
  const ganadora = {};
  rows.forEach(function (r, i) {
    const k = idx.map(function (c) { return String(r[c]); }).join('|');
    if (idx.every(function (c) { return r[c] === '' || r[c] === null; })) return;   // sin clave: no se toca
    const t = uIdx === -1 ? 0 : tiempo(r[uIdx]);
    const prev = ganadora[k];
    if (!prev || t >= prev.t) ganadora[k] = { i: i, t: t };
  });
  const keep = rows.filter(function (r, i) {
    if (idx.every(function (c) { return r[c] === '' || r[c] === null; })) return true;
    const k = idx.map(function (c) { return String(r[c]); }).join('|');
    return ganadora[k].i === i;
  });
  return { rows: keep, quitadas: rows.length - keep.length };
}

function esVacio(headers, r, tipo) {
  const g = function (c) { const i = headers.indexOf(c); return i === -1 ? 0 : num(r[i]); };
  if (tipo === 'oee')  return !(g('piezasProg') > 0 || g('piezasTotal') > 0 || g('piezasRechazo') > 0 || g('parosNoProg') > 0);
  if (tipo === 'hora') return !(g('totalFabricadas') > 0 || g('totalDanadas') > 0 || g('tiempoDibujos') > 0);
  return false;
}

function parseObj(txt) { try { const o = JSON.parse(txt); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; } catch (e) { return null; } }
function parseArr(txt) { try { const o = JSON.parse(txt); return Array.isArray(o) ? o : null; } catch (e) { return null; } }

// Usuarios: roles en español, contraseña en "password", centros en "cts",
// permisos sin claves que ya no existen y permisos de captura válidos. No toca
// ids, nombres, contraseñas ni los permisos de captura ya otorgados a Líder/Ingeniería.
function depurarUsuarios(headers, rows) {
  const roleMap = ROLES;
  const OBSOLETAS = ['pass', 'createdAt', 'ct'];
  const BASE = ['id', 'name', 'username', 'password', 'role', 'cts', 'permissions', 'captura', 'active', 'updatedAt'];
  const extras = headers.filter(function (h) { return h !== '' && BASE.indexOf(h) === -1 && OBSOLETAS.indexOf(h) === -1; });
  const nuevos = BASE.concat(extras);
  const stats = { cuentas: rows.length, roles: 0, columnasViejas: 0, permisosLimpiados: 0, capturaOperadores: 0, capturaInvalida: 0 };
  stats.columnasViejas = headers.filter(function (h) { return OBSOLETAS.indexOf(h) !== -1; }).length;
  const out = rows.map(function (r) {
    const o = {};
    headers.forEach(function (h, i) { o[h] = r[i]; });
    const nuevo = {};
    nuevo.id = String(o.id !== undefined && o.id !== '' ? o.id : ('u' + Date.now() + Math.random().toString(36).slice(2)));
    nuevo.name = String(o.name || o.username || 'Usuario');
    nuevo.username = String(o.username || '').trim();
    nuevo.password = String((o.password !== undefined && o.password !== '') ? o.password : (o.pass !== undefined ? o.pass : ''));
    const rolRaw = String(o.role || '').trim().toLowerCase();
    nuevo.role = roleMap[rolRaw] || 'operador';
    if (nuevo.role !== String(o.role || '')) stats.roles++;
    let cts = parseArr(o.cts);
    if (!cts) cts = o.ct ? [String(o.ct)] : [];
    nuevo.cts = JSON.stringify(cts);
    const perms = parseObj(o.permissions);
    if (perms) {
      let cambio = false;
      PERMISOS_OBSOLETOS.forEach(function (k) { if (k in perms) { delete perms[k]; cambio = true; } });
      if (cambio) stats.permisosLimpiados++;
      nuevo.permissions = Object.keys(perms).length ? JSON.stringify(perms) : '';
    } else nuevo.permissions = '';
    let cap = parseArr(o.captura) || [];
    const valida = cap.filter(function (k) { return CAPTURA_VALIDA.indexOf(k) !== -1; });
    if (valida.length !== cap.length) stats.capturaInvalida++;
    if (nuevo.role === 'operador' && valida.length) { stats.capturaOperadores++; cap = []; } else cap = valida;
    nuevo.captura = JSON.stringify(cap);
    nuevo.active = !(o.active === false || o.active === 'false' || o.active === 'FALSE');
    nuevo.updatedAt = o.updatedAt === undefined ? '' : o.updatedAt;
    extras.forEach(function (h) { nuevo[h] = o[h] === undefined ? '' : o[h]; });
    return nuevos.map(function (h) { return nuevo[h]; });
  });
  return { headers: nuevos, rows: out, stats: stats };
}

// Calcula qué haría "Depurar" SIN escribir nada.
function planDepuracion() {
  const ss = ss_();
  const plan = { cambios: [], hojas: [], obsoletas: [], noReconocidas: [], avisos: [] };
  Object.keys(HOJAS).forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const cfg = HOJAS[name];
    let t = leerTodo(sheet);
    if (!t.headers.length) return;
    const info = { nombre: name, filas: t.rows.length, duplicadas: 0, vacias: 0, usuarios: null };
    let headers = t.headers, rows = t.rows, cambio = false;

    if (name === 'Usuarios') {
      const u = depurarUsuarios(headers, rows);
      info.usuarios = u.stats;
      const antes = JSON.stringify([headers, rows]), despues = JSON.stringify([u.headers, u.rows]);
      if (antes !== despues) { headers = u.headers; rows = u.rows; cambio = true; }
      const nombres = {};
      u.rows.forEach(function (r) { const k = String(r[2]).toLowerCase(); if (k) nombres[k] = (nombres[k] || 0) + 1; });
      Object.keys(nombres).forEach(function (k) { if (nombres[k] > 1) plan.avisos.push('Usuarios: el usuario "' + k + '" está repetido ' + nombres[k] + ' veces (revísalo a mano).'); });
    }
    const d = quitarDuplicados(headers, rows, cfg.clave);
    if (d.quitadas) { rows = d.rows; info.duplicadas = d.quitadas; cambio = true; }
    if (cfg.vacios) {
      const keep = rows.filter(function (r) { return !esVacio(headers, r, cfg.vacios); });
      if (keep.length !== rows.length) { info.vacias = rows.length - keep.length; rows = keep; cambio = true; }
    }
    plan.hojas.push(info);
    if (cambio) plan.cambios.push({ nombre: name, headers: headers, rows: rows });
  });
  ss.getSheets().forEach(function (s) {
    const n = s.getName();
    if (HOJAS_OBSOLETAS.indexOf(n) !== -1) plan.obsoletas.push(n);
    else if (!Object.prototype.hasOwnProperty.call(HOJAS, n) && !/^(RESPALDO_|Archivo_|OBSOLETA_)/.test(n)) plan.noReconocidas.push(n);
  });
  return plan;
}

function sello() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm'); }

// Copia oculta de la hoja antes de modificarla.
function respaldar(name) {
  const ss = ss_();
  const sheet = ss.getSheetByName(name);
  if (!sheet) return null;
  const copia = sheet.copyTo(ss);
  copia.setName(('RESPALDO_' + name + '_' + sello()).substring(0, 99));
  copia.hideSheet();
  return copia.getName();
}

// aplicar=false → solo informa. aplicar=true → respalda y escribe.
function depurar(aplicar) {
  const plan = planDepuracion();
  const rep = { aplicado: !!aplicar, hojas: plan.hojas, cambios: plan.cambios.map(function (c) { return c.nombre; }),
                obsoletas: plan.obsoletas, noReconocidas: plan.noReconocidas, avisos: plan.avisos, respaldos: [] };
  if (!aplicar) return rep;
  conBloqueo(function () {
    plan.cambios.forEach(function (c) {
      rep.respaldos.push(respaldar(c.nombre));
      escribirMatriz(ss_().getSheetByName(c.nombre), HOJAS[c.nombre], c.headers, c.rows);
    });
    plan.obsoletas.forEach(function (n) {
      const s = ss_().getSheetByName(n);
      if (s) { s.setName(('OBSOLETA_' + n).substring(0, 99)); s.hideSheet(); }
    });
  });
  return rep;
}

// Mueve a "Archivo_<hoja>" los registros más viejos que archivarDias. La
// plataforma solo lee ~45 días, así que no los echa de menos y las lecturas
// quedan más ligeras. aplicar=false → solo cuenta.
function archivarAntiguos(aplicar) {
  const ss = ss_();
  const rep = { aplicado: !!aplicar, hojas: [], respaldos: [] };
  Object.keys(HOJAS).forEach(function (name) {
    const cfg = HOJAS[name];
    if (!cfg.archivarDias) return;
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const t = leerTodo(sheet);
    const fIdx = t.headers.indexOf('fecha');
    if (fIdx === -1) return;
    const corte = fechaHaceDias(cfg.archivarDias);
    const viejas = [], quedan = [];
    t.rows.forEach(function (r) {
      const f = fechaComoTexto(r[fIdx]);
      if (f !== null && f < corte) viejas.push(r); else quedan.push(r);
    });
    if (!viejas.length) return;
    rep.hojas.push({ nombre: name, archivar: viejas.length, quedan: quedan.length, corte: corte });
    if (!aplicar) return;
    conBloqueo(function () {
      rep.respaldos.push(respaldar(name));
      const aName = ('Archivo_' + name).substring(0, 99);
      const a = getOrCreateSheet(aName);
      const prev = leerTodo(a);
      const headers = prev.headers.length ? prev.headers.slice() : t.headers.slice();
      t.headers.forEach(function (h) { if (h !== '' && headers.indexOf(h) === -1) headers.push(h); });
      const filasPrev = prev.rows.map(function (r) { return headers.map(function (h, i) { return i < r.length ? r[i] : ''; }); });
      const filasNuevas = viejas.map(function (r) {
        return headers.map(function (h) { const i = t.headers.indexOf(h); return i === -1 ? '' : (h === 'fecha' ? (fechaComoTexto(r[i]) || r[i]) : r[i]); });
      });
      escribirMatriz(a, cfg, headers, filasPrev.concat(filasNuevas));
      escribirMatriz(sheet, cfg, t.headers, quedan.map(function (r) {
        return r.map(function (v, i) { return t.headers[i] === 'fecha' ? (fechaComoTexto(v) || v) : v; });
      }));
    });
  });
  return rep;
}

function diagnostico() {
  const plan = planDepuracion();
  const res = resumenHojas();
  const grandes = [];
  Object.keys(res.activas).forEach(function (n) { if (res.activas[n].filas > 2000) grandes.push(n + ' (' + res.activas[n].filas + ' filas)'); });
  return { build: BUILD, activas: res.activas, obsoletas: plan.obsoletas, noReconocidas: plan.noReconocidas,
           porDepurar: plan.hojas.filter(function (h) { return h.duplicadas || h.vacias; }),
           usuarios: (plan.hojas.filter(function (h) { return h.nombre === 'Usuarios'; })[0] || {}).usuarios || null,
           avisos: plan.avisos, grandes: grandes, archivar: archivarAntiguos(false).hojas };
}

// ── Textos para el menú ──
function textoDiagnostico(d) {
  const L = ['OEE Planta — diagnóstico (' + d.build + ')', ''];
  L.push('Hojas activas:');
  Object.keys(d.activas).forEach(function (n) { L.push('  • ' + n + ': ' + d.activas[n].filas + ' filas'); });
  if (d.usuarios) {
    const u = d.usuarios;
    L.push('', 'Cuentas: ' + u.cuentas + ' · roles por normalizar: ' + u.roles + ' · columnas viejas: ' + u.columnasViejas +
           ' · permisos viejos por limpiar: ' + u.permisosLimpiados + ' · operadores con captura extra: ' + u.capturaOperadores);
  }
  if (d.porDepurar.length) { L.push('', 'Por depurar:'); d.porDepurar.forEach(function (h) { L.push('  • ' + h.nombre + ': ' + h.duplicadas + ' duplicadas, ' + h.vacias + ' en cero'); }); }
  if (d.obsoletas.length) L.push('', 'Hojas obsoletas (se ocultan al depurar): ' + d.obsoletas.join(', '));
  if (d.noReconocidas.length) L.push('', 'Hojas que la plataforma no usa (no se tocan): ' + d.noReconocidas.join(', '));
  if (d.archivar.length) { L.push('', 'Registros antiguos que se pueden archivar:'); d.archivar.forEach(function (h) { L.push('  • ' + h.nombre + ': ' + h.archivar + ' (anteriores a ' + h.corte + ')'); }); }
  if (d.grandes.length) L.push('', 'Hojas grandes: ' + d.grandes.join(', '));
  d.avisos.forEach(function (a) { L.push('', '⚠ ' + a); });
  return L.join('\n');
}

function textoDepuracion(r) {
  const L = [r.aplicado ? 'Depuración APLICADA' : 'Vista previa de la depuración (no se ha cambiado nada)', ''];
  r.hojas.forEach(function (h) {
    const partes = [];
    if (h.duplicadas) partes.push(h.duplicadas + ' filas duplicadas');
    if (h.vacias) partes.push(h.vacias + ' registros en cero');
    if (h.usuarios) {
      const u = h.usuarios;
      if (u.roles) partes.push(u.roles + ' roles a normalizar');
      if (u.columnasViejas) partes.push(u.columnasViejas + ' columnas viejas');
      if (u.permisosLimpiados) partes.push(u.permisosLimpiados + ' cuentas con permisos viejos');
      if (u.capturaOperadores) partes.push(u.capturaOperadores + ' operadores con captura extra');
    }
    if (partes.length) L.push('• ' + h.nombre + ': ' + partes.join(', '));
  });
  if (L.length === 2) L.push('Nada que depurar: todo está limpio.');
  if (r.obsoletas.length) L.push('', 'Se ocultan (no se borran): ' + r.obsoletas.join(', '));
  if (r.respaldos.length) L.push('', 'Respaldos creados (hojas ocultas): ' + r.respaldos.join(', '));
  r.avisos.forEach(function (a) { L.push('', '⚠ ' + a); });
  return L.join('\n');
}

function hayCambios(r) {
  return r.cambios.length > 0 || r.obsoletas.length > 0;
}

// ── Menú dentro del Sheet ──
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('OEE Planta')
      .addItem('Diagnóstico', 'menuDiagnostico')
      .addSeparator()
      .addItem('Depurar datos — vista previa', 'menuDepurarVista')
      .addItem('Depurar datos — aplicar…', 'menuDepurarAplicar')
      .addSeparator()
      .addItem('Archivar registros antiguos — vista previa', 'menuArchivarVista')
      .addItem('Archivar registros antiguos — aplicar…', 'menuArchivarAplicar')
      .addSeparator()
      .addItem('Cuentas — restablecer contraseña…', 'menuRestablecerContrasena')
      .addItem('Cuentas — cifrar contraseñas en texto', 'menuCifrarContrasenas')
      .addToUi();
  } catch (e) { /* sin interfaz (ejecución desde el editor): no pasa nada */ }
}

function mostrar_(titulo, texto) { SpreadsheetApp.getUi().alert(titulo, texto, SpreadsheetApp.getUi().ButtonSet.OK); }
function confirmar_(titulo, texto) {
  const ui = SpreadsheetApp.getUi();
  return ui.alert(titulo, texto, ui.ButtonSet.YES_NO) === ui.Button.YES;
}
function menuDiagnostico() { mostrar_('Diagnóstico', textoDiagnostico(diagnostico())); }
function menuDepurarVista() { mostrar_('Depurar — vista previa', textoDepuracion(depurar(false))); }
function menuDepurarAplicar() {
  const vista = depurar(false);
  if (!hayCambios(vista)) { mostrar_('Depurar', textoDepuracion(vista)); return; }
  if (!confirmar_('Depurar — aplicar', textoDepuracion(vista) + '\n\nCada hoja que se modifique se respalda antes en una hoja oculta RESPALDO_… ¿Aplicar?')) return;
  mostrar_('Depurar', textoDepuracion(depurar(true)));
}
function textoArchivo_(r) {
  if (!r.hojas.length) return 'No hay registros antiguos que archivar.';
  return (r.aplicado ? 'Archivado:' : 'Se archivarían:') + '\n' + r.hojas.map(function (h) {
    return '• ' + h.nombre + ': ' + h.archivar + ' registros anteriores a ' + h.corte + ' (quedan ' + h.quedan + ')';
  }).join('\n') + (r.respaldos.length ? '\n\nRespaldos (ocultos): ' + r.respaldos.join(', ') : '');
}
function menuArchivarVista() { mostrar_('Archivar — vista previa', textoArchivo_(archivarAntiguos(false))); }
function menuArchivarAplicar() {
  const vista = archivarAntiguos(false);
  if (!vista.hojas.length) { mostrar_('Archivar', textoArchivo_(vista)); return; }
  if (!confirmar_('Archivar — aplicar', textoArchivo_(vista) + '\n\nSe copian a hojas "Archivo_…" y se respalda cada hoja antes. ¿Aplicar?')) return;
  mostrar_('Archivar', textoArchivo_(archivarAntiguos(true)));
}
// Por si nadie puede entrar a la app (contraseña olvidada): solo quien edita el Sheet puede usarlo.
function menuRestablecerContrasena() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('Restablecer contraseña', 'Usuario de la cuenta (como lo escribe en la app):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const usuario = r1.getResponseText().trim().toLowerCase();
  const c = cuentas_().lista.filter(function (x) { return String(x.username || '').trim().toLowerCase() === usuario; })[0];
  if (!c) { mostrar_('Restablecer contraseña', 'No existe la cuenta "' + usuario + '".'); return; }
  const r2 = ui.prompt('Restablecer contraseña', 'Nueva contraseña para ' + (c.name || usuario) + ' (mínimo 4 caracteres):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const pw = r2.getResponseText();
  if (pw.trim().length < 4) { mostrar_('Restablecer contraseña', 'La contraseña debe tener al menos 4 caracteres. No se cambió nada.'); return; }
  guardarHash_(c.id, pw);
  CacheService.getScriptCache().remove('login_fallos_' + usuario);
  mostrar_('Restablecer contraseña', 'Listo. La contraseña de ' + (c.name || usuario) + ' se cambió y se guardó cifrada. Sus sesiones abiertas se cierran.');
}
function menuCifrarContrasenas() {
  PropertiesService.getScriptProperties().deleteProperty('PASS_CIFRADAS');
  const n = migrarContrasenas_();
  mostrar_('Cifrar contraseñas', n ? 'Se cifraron ' + n + ' contraseñas que estaban en texto.' : 'Todas las contraseñas ya estaban cifradas.');
}
