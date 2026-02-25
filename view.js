// view.js (DISK STREAM + AUTO DELETE + MAX SIZE + STATUS LIKE)
// View Bot: reenvía medios citados (view-once imagen/video + audios) a un chat configurado.
// Extra: si "view estado" está ON, intenta reenviar el estado al que le diste / (requiere cache).
// Solo responde/actúa si el mensaje es del dueño.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'view_config.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Carpeta temporal en disco (se borra después de reenviar)
const MEDIA_DIR = path.join(process.cwd(), 'media_tmp');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Máximo por archivo (default 120MB)
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES || (120 * 1024 * 1024));

// Cache de estados (en RAM). Se limpia con TTL.
// Clave: statusKey = `${id}|${participantOrRemote}`
const STATUS_CACHE = new Map();
const STATUS_TTL_MS = Number(process.env.STATUS_TTL_MS || (24 * 60 * 60 * 1000)); // 24h

// Limpieza defensiva de temporales viejos (por si crasheó antes)
(function cleanupOldTmp() {
  try {
    const maxAgeMs = Number(process.env.TMP_MAX_AGE_MS || (6 * 60 * 60 * 1000)); // 6h
    const now = Date.now();
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      const p = path.join(MEDIA_DIR, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && (now - st.mtimeMs) > maxAgeMs) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
})();

(function cleanupOldStatusCache() {
  // Limpieza periódica de cache (cada 10 min)
  const everyMs = Number(process.env.STATUS_CLEAN_MS || (10 * 60 * 1000));
  setInterval(() => {
    try {
      const now = Date.now();
      for (const [k, v] of STATUS_CACHE.entries()) {
        if (!v?.ts || (now - v.ts) > STATUS_TTL_MS) STATUS_CACHE.delete(k);
      }
    } catch {}
  }, everyMs).unref?.();
})();

// =========================
// OWNER (solo vos)
// =========================
function jidToNumber(jid) {
  return String(jid || '').split('@')[0].replace(/\D/g, '');
}

function getSenderJid(msg) {
  return msg?.key?.participant || msg?.key?.remoteJid || '';
}

function isOwnerMsg(msg) {
  if (msg?.key?.fromMe) return true;

  const owner = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
  if (!owner) return false;

  const sender = jidToNumber(getSenderJid(msg));
  return sender === owner;
}

// =========================
// CONFIG
// =========================
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {
        chat: null,
        triggers: ['view'],
        sticker: true,
        
        status: false,
      };
    }

    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      chat: j?.chat || null,
      triggers: Array.isArray(j?.triggers) ? j.triggers : ['view'],
      sticker: typeof j?.sticker === 'boolean' ? j.sticker : true,
      audio: typeof j?.audio === 'boolean' ? j.audio : true,
      status: typeof j?.status === 'boolean' ? j.status : false,
    };
  } catch {
    return { chat: null, triggers: ['view'], sticker: true,  status: false };
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(
        {
          chat: cfg?.chat || null,
          triggers: Array.isArray(cfg?.triggers) ? cfg.triggers : ['view'],
          sticker: typeof cfg?.sticker === 'boolean' ? cfg.sticker : true,
          audio: typeof cfg?.audio === 'boolean' ? cfg.audio : true,
          status: typeof cfg?.status === 'boolean' ? cfg.status : false,
        },
        null,
        2
      )
    );
  } catch {}
}

// =========================
// Helpers texto / triggers
// =========================
function extractTextAny(message) {
  try {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    return '';
  } catch {
    return '';
  }
}

function normalizeWord(s) {
  return String(s || '').trim().toLowerCase();
}

function normalizeTriggerFromText(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t.split(/\s+/)[0];
  t = t.replace(/^[?!.,;:/\\]+/, '');
  return normalizeWord(t);
}

function normalizeTargetJid(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;

  if (s.endsWith('@g.us') || s.endsWith('@s.whatsapp.net')) return s;

  const num = s.replace(/\D/g, '');
  if (num) return `${num}@s.whatsapp.net`;

  return null;
}

// =========================
// Unwrap quoted media
// =========================
function unwrapQuotedViewOnce(quotedMsg) {
  if (!quotedMsg) return null;

  let viewOnceMessage = quotedMsg;

  if (quotedMsg.viewOnceMessage?.message) viewOnceMessage = quotedMsg.viewOnceMessage.message;
  else if (quotedMsg.viewOnceMessageV2?.message) viewOnceMessage = quotedMsg.viewOnceMessageV2.message;
  else if (quotedMsg.viewOnceMessageV2Extension?.message)
    viewOnceMessage = quotedMsg.viewOnceMessageV2Extension.message;

  const mediaMessage = viewOnceMessage?.imageMessage || viewOnceMessage?.videoMessage;
  if (!mediaMessage) return null;

  return { wrappedMessage: viewOnceMessage, mediaMessage, kind: 'viewonce' };
}

function unwrapQuotedAudio(quotedMsg) {
  if (!quotedMsg) return null;

  const audioMessage = quotedMsg.audioMessage;
  if (!audioMessage) return null;

  return { wrappedMessage: quotedMsg, mediaMessage: audioMessage, kind: 'audio' };
}

function getQuotedContext(msg) {
  return (
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.stickerMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.audioMessage?.contextInfo ||
    null
  );
}

// =========================
// Disk download helper (stream -> file)
// =========================
function pickExt(mimetype, fallbackExt) {
  const m = String(mimetype || '').toLowerCase();
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('jpg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('mpeg')) return '.mp3';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('opus')) return '.ogg';
  if (m.includes('pdf')) return '.pdf';
  return fallbackExt || '';
}

function newTmpPath(ext) {
  const name = `view_${Date.now()}_${Math.random().toString(16).slice(2)}${ext || ''}`;
  return path.join(MEDIA_DIR, name);
}

async function downloadToFile({ sock, fakeMsg, mimetype, fallbackExt }) {
  const ext = pickExt(mimetype, fallbackExt);
  const filePath = newTmpPath(ext);

  const stream = await downloadMediaMessage(
    fakeMsg,
    'stream',
    {},
    { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
  );

  const write = fs.createWriteStream(filePath);
  await pipeline(stream, write);

  return filePath;
}

// =========================
// Download + forward
// =========================
function tooLarge(fileLength) {
  const n = Number(fileLength || 0);
  return n > 0 && n > MAX_MEDIA_BYTES;
}

async function forwardMediaMessageToTarget({ sock, fromJid, targetJid, message, caption }) {
  const m = message?.imageMessage || message?.videoMessage || message?.audioMessage;
  if (!m) return false;

  const isVideo = !!message?.videoMessage;
  const isImage = !!message?.imageMessage;
  const isAudio = !!message?.audioMessage;

  if (tooLarge(m.fileLength)) {
    try {
      await sock.sendMessage(fromJid, {
        text: ` Archivo supera el tamaño permitido (max ${(MAX_MEDIA_BYTES / (1024 * 1024)).toFixed(0)}MB).`,
      });
    } catch {}
    return true;
  }

  const fakeMsg = { key: message.__keyForDownload, message: message.__wrappedForDownload };

  const mimetype = m.mimetype || (isAudio ? 'audio/ogg; codecs=opus' : undefined);
  const fallbackExt = isVideo ? '.mp4' : isImage ? '.jpg' : '.ogg';

  const tmpFile = await downloadToFile({ sock, fakeMsg, mimetype, fallbackExt });

  try {
    if (isImage) {
      await sock.sendMessage(targetJid, {
        image: { url: tmpFile },
        mimetype,
        caption: caption || m.caption || undefined,
      });
      return true;
    }

    if (isVideo) {
      await sock.sendMessage(targetJid, {
        video: { url: tmpFile },
        mimetype,
        caption: caption || m.caption || undefined,
      });
      return true;
    }

    if (isAudio) {
      await sock.sendMessage(targetJid, {
        audio: { url: tmpFile },
        mimetype,
        ptt: !!m.ptt,
      });
      return true;
    }

    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function buildFakeMsgForDownload({ msg, from, ctx, wrappedMessage }) {
  const stanzaId = ctx?.stanzaId;
  const participant = ctx?.participant;

  const quotedKey = stanzaId
    ? { remoteJid: from, fromMe: false, id: stanzaId, participant: participant || undefined }
    : msg.key;

  return { key: quotedKey, message: wrappedMessage };
}

async function forwardQuotedMediaToTarget({ sock, msg, from, target, cfg }) {
  const ctx = getQuotedContext(msg);
  const quotedMsg = ctx?.quotedMessage;
  if (!quotedMsg) return false;

  // 1) view-once image/video
  const unwrappedVO = unwrapQuotedViewOnce(quotedMsg);
  if (unwrappedVO) {
    if (tooLarge(unwrappedVO.mediaMessage.fileLength)) {
      try {
        await sock.sendMessage(from, {
          text: ` Archivo supera el tamaño permitido (max ${(MAX_MEDIA_BYTES / (1024 * 1024)).toFixed(0)}MB).`,
        });
      } catch {}
      return true;
    }

    const fake = await buildFakeMsgForDownload({ msg, from, ctx, wrappedMessage: unwrappedVO.wrappedMessage });

    const isVideo = String(unwrappedVO.mediaMessage.mimetype || '').startsWith('video');
    const tmpFile = await downloadToFile({
      sock,
      fakeMsg: fake,
      mimetype: unwrappedVO.mediaMessage.mimetype,
      fallbackExt: isVideo ? '.mp4' : '.jpg',
    });

    try {
      await sock.sendMessage(target, {
        [isVideo ? 'video' : 'image']: { url: tmpFile },
        mimetype: unwrappedVO.mediaMessage.mimetype,
        caption: unwrappedVO.mediaMessage.caption || undefined,
      });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    return true;
  }

  // 2) audio
  if (true) {
    const unwrappedAu = unwrapQuotedAudio(quotedMsg);
    if (unwrappedAu) {
      if (tooLarge(unwrappedAu.mediaMessage.fileLength)) {
        try {
          await sock.sendMessage(from, {
            text: ` Audio supera el tamaño permitido (max ${(MAX_MEDIA_BYTES / (1024 * 1024)).toFixed(0)}MB).`,
          });
        } catch {}
        return true;
      }

      const fake = await buildFakeMsgForDownload({ msg, from, ctx, wrappedMessage: unwrappedAu.wrappedMessage });

      const mimetype = unwrappedAu.mediaMessage.mimetype || 'audio/ogg; codecs=opus';
      const ptt = !!unwrappedAu.mediaMessage.ptt;

      const tmpFile = await downloadToFile({ sock, fakeMsg: fake, mimetype, fallbackExt: '.ogg' });

      try {
        await sock.sendMessage(target, { audio: { url: tmpFile }, mimetype, ptt });
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }

      return true;
    }
  }

  return false;
}

// =========================
// STATUS CACHE
// =========================
function makeStatusCacheKey({ id, participantOrRemote }) {
  return `${String(id || '')}|${String(participantOrRemote || '')}`;
}

function pickParticipantOrRemote(key) {
  // Para status@broadcast normalmente viene participant (autor del estado)
  return key?.participant || key?.remoteJid || '';
}

function cacheStatusMessage(msg) {
  try {
    if (!msg?.message || msg?.key?.remoteJid !== 'status@broadcast') return;

    // Solo cachear medios (imagen/video)
    const wrapped = msg.message;

    let media = wrapped.imageMessage || wrapped.videoMessage;

    // A veces el status viene envuelto en viewOnce*
    if (!media) {
      const vo =
        wrapped.viewOnceMessage?.message ||
        wrapped.viewOnceMessageV2?.message ||
        wrapped.viewOnceMessageV2Extension?.message ||
        null;
      if (vo) media = vo.imageMessage || vo.videoMessage;
    }

    if (!media) return;

    const id = msg?.key?.id;
    if (!id) return;

    const participantOrRemote = pickParticipantOrRemote(msg.key);
    const cacheKey = makeStatusCacheKey({ id, participantOrRemote });

    STATUS_CACHE.set(cacheKey, {
      ts: Date.now(),
      key: msg.key,
      message: msg.message,
      mimetype: media.mimetype,
      kind: media.videoMessage ? 'video' : 'image',
    });
  } catch {}
}

function isHeartOrLike(emoji) {
  const e = String(emoji || '').trim();
  return e === '' || e === '' || e === '' || e === '' || e === '' || e === '' || e === '' || e === '';
}

async function tryForwardStatusFromReaction({ sock, from, cfg, ev }) {
  try {
    // Baileys suele emitir events con { key, reaction }
    const emoji = ev?.reaction?.text || ev?.reaction?.emoji || ev?.reaction?.reaction || ev?.text || '';
    if (!isHeartOrLike(emoji)) return false;

    const key = ev?.key || ev?.reaction?.key;
    const id = key?.id;

    // participant es clave para encontrar el mismo status
    const participantOrRemote = pickParticipantOrRemote(key);

    if (!id) return false;

    const cacheKey = makeStatusCacheKey({ id, participantOrRemote });
    const cached = STATUS_CACHE.get(cacheKey);

    if (!cached) {
      // fallback: intentar sin participant (a veces viene vacío)
      const cacheKey2 = makeStatusCacheKey({ id, participantOrRemote: '' });
      const cached2 = STATUS_CACHE.get(cacheKey2);
      if (!cached2) return false;
      return await forwardCachedStatus({ sock, from, target: cfg.chat, cached: cached2 });
    }

    return await forwardCachedStatus({ sock, from, target: cfg.chat, cached });
  } catch {
    return false;
  }
}

function wrapForDownload(key, message) {
  // downloadMediaMessage necesita { key, message }
  // Guardamos dentro de message para reusarlo sin copiar más cosas.
  const cloned = message;
  // marcadores internos
  cloned.__keyForDownload = key;
  cloned.__wrappedForDownload = message;
  return cloned;
}

async function forwardCachedStatus({ sock, from, target, cached }) {
  try {
    const key = cached?.key;
    const message = cached?.message;
    if (!key || !message) return false;

    const wrapped = wrapForDownload(key, message);

    // Intenta encontrar media en el wrapper original o en viewOnce*
    let payload = wrapped;
    let inner = wrapped.imageMessage || wrapped.videoMessage;

    if (!inner) {
      const vo =
        wrapped.viewOnceMessage?.message ||
        wrapped.viewOnceMessageV2?.message ||
        wrapped.viewOnceMessageV2Extension?.message ||
        null;
      if (vo) {
        payload = vo;
        // Importante: mantener key/message originales para descargar
        payload.__keyForDownload = key;
        payload.__wrappedForDownload = wrapped;
      }
    }

    // Si quedó en vo, el media está dentro de payload
    // forwardMediaMessageToTarget usa __keyForDownload + __wrappedForDownload
    return await forwardMediaMessageToTarget({
      sock,
      fromJid: from,
      targetJid: target,
      message: payload,
      caption: undefined,
    });
  } catch {
    return false;
  }
}

// =========================
// MAIN (mensajes normales)
// =========================
async function onMessage({ sock, msg }) {
  try {
    if (!msg?.message) return;
    if (!isOwnerMsg(msg)) return;

    const from = msg.key.remoteJid;
    const cfg = loadConfig();

    const bodyText = (extractTextAny(msg.message) || '').trim();
    const lower = bodyText.toLowerCase().trim();
    const isSticker = !!msg.message?.stickerMessage;

    // ====== CONFIG ======
    if (!isSticker && lower === 'view here') {
      if (cfg.chat === from) return;
      cfg.chat = from;
      saveConfig(cfg);
      try { await sock.sendMessage(from, { text: ' Hecho.' }); } catch {}
      return;
    }

    if (!isSticker && lower.startsWith('view ')) {
      const rest = bodyText.slice(5).trim();
      const restLower = rest.toLowerCase().trim();

      if (restLower === 'sticker on' || restLower === 'sticker off') {
        const want = restLower.endsWith('on');
        if (cfg.sticker === want) return;
        cfg.sticker = want;
        saveConfig(cfg);
        try { await sock.sendMessage(from, { text: ' Hecho.' }); } catch {}
        return;
      }

      if (restLower === 'audio on' || restLower === 'audio off') {
        const want = restLower.endsWith('on');
        if (cfg.audio === want) return;
        cfg.audio = want;
        saveConfig(cfg);
        try { await sock.sendMessage(from, { text: ' Hecho.' }); } catch {}
        return;
      }

      if (restLower === 'estado on' || restLower === 'estado off') {
        const want = restLower.endsWith('on');
        if (cfg.status === want) return;
        cfg.status = want;
        saveConfig(cfg);
        try { await sock.sendMessage(from, { text: ' Hecho.' }); } catch {}
        return;
      }

      if (restLower.startsWith('add ')) {
        const w = normalizeWord(rest.slice(4));
        if (!w) return;

        const set = new Set((cfg.triggers || []).map(normalizeWord).filter(Boolean));
        if (set.has(w)) return;

        set.add(w);
        cfg.triggers = [...set].slice(0, 50);
        saveConfig(cfg);

        try { await sock.sendMessage(from, { text: ' Hecho.' }); } catch {}
        return;
      }

      if (restLower.startsWith('del ')) {
        const w = normalizeWord(rest.slice(4));
        if (!w) return;

        const arr = (cfg.triggers || []).map(normalizeWord).filter(Boolean);
        const next = arr.filter((x) => x !== w);
        if (next.length === arr.length) return;

        cfg.triggers = next.length ? next : ['view'];
        saveConfig(cfg);

        try { await sock.sendMessage(from, { text: ' Hecho.' }); } catch {}
        return;
      }

      if (restLower === 'list') {
        const list = (cfg.triggers || []).map(normalizeWord).filter(Boolean);
        const text =
          ` Triggers: ${list.length ? list.join(', ') : '—'}\n` +
          ` Sticker: ${cfg.sticker ? 'on' : 'off'}\n` +
          `` +
          ` Estado: ${cfg.status ? 'on' : 'off'}\n` +
          ` Max: ${(MAX_MEDIA_BYTES / (1024 * 1024)).toFixed(0)}MB\n` +
          ` Chat: ${cfg.chat || '—'}`;
        await sock.sendMessage(from, { text });
        return;
      }

      if (restLower.startsWith('setchat ')) {
        const maybe = normalizeTargetJid(rest.slice(8).trim());
        if (!maybe) return;
        if (cfg.chat === maybe) return;
        cfg.chat = maybe;
        saveConfig(cfg);
        try { await sock.sendMessage(from, { text: ' Hecho.' }); } catch {}
        return;
      }
    }

    // ====== DISPARO REAL ======
    if (!cfg.chat) return;

    const ctx = getQuotedContext(msg);
    const quoted = ctx?.quotedMessage;
    if (!quoted) return;

    if (isSticker && cfg.sticker) {
      await forwardQuotedMediaToTarget({ sock, msg, from, target: cfg.chat, cfg });
      return;
    }

    if (!isSticker && bodyText) {
      const trig = normalizeTriggerFromText(bodyText);
      if (!trig) return;

      const allowed = new Set((cfg.triggers || []).map(normalizeWord).filter(Boolean));
      if (!allowed.has(trig)) return;

      await forwardQuotedMediaToTarget({ sock, msg, from, target: cfg.chat, cfg });
      return;
    }
  } catch {}
}

// =========================
// REACTIONS (status like)
// =========================
async function onReaction({ sock, ev }) {
  try {
    const cfg = loadConfig();
    if (!cfg?.status) return;
    if (!cfg?.chat) return;

    // En reacciones, el evento puede venir sin msg; limitamos a dueño por seguridad.
    // Si no podemos comprobar, NO actuamos.
    const actor = ev?.key?.participant || ev?.participant || '';
    const owner = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
    if (!owner) return;
    const actorNum = jidToNumber(actor);
    if (actorNum !== owner) return;

    const from = cfg.chat; // para notificar errores, usamos el mismo chat destino

    const ok = await tryForwardStatusFromReaction({ sock, from, cfg, ev });
    if (ok) return;

    // Fallback honesto: no estaba en cache
    try {
      await sock.sendMessage(from, {
        text:
          ' No pude reenviar ese estado.\n' +
          'Causa típica: el estado no entró al bot (cache) o WhatsApp no lo expuso.\n' +
          'Tip: abrí el estado primero (que cargue) y recién ahí dale .',
      });
    } catch {}
  } catch {}
}

module.exports = {
  onMessage,
  onReaction,
  cacheStatusMessage,
  STATUS_CACHE,
  makeStatusCacheKey,
};
