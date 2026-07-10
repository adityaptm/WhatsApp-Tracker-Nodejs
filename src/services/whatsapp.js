/**
 * WhatsApp client service using Baileys — equivalent to Go's whatsapp.go
 * Handles: connection, QR code generation, presence subscription, event handling.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { state, saveState, calculateOnlineRanges } = require('./state');
const { loadState } = require('./state');
const { sendNtfyNotification } = require('./ntfy');
const { broadcastUpdate } = require('./websocket');

const AUTH_DIR = path.join(__dirname, '..', '..', 'auth_info');
const CONTACTS_CACHE_FILE = path.join(__dirname, '..', '..', 'contacts_cache.json');

let sock = null;
let qrDataURL = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'waiting_qr' | 'connected'
let allContacts = {}; // cached contacts from WhatsApp store

function loadContactsCache() {
  try {
    if (fs.existsSync(CONTACTS_CACHE_FILE)) {
      const data = fs.readFileSync(CONTACTS_CACHE_FILE, 'utf8');
      allContacts = JSON.parse(data);
      console.log(`📇 Contact cache loaded: ${Object.keys(allContacts).length} kontak`);
    }
  } catch (err) {
    console.error('Error loading contacts cache:', err.message);
  }
}

function saveContactsCache() {
  try {
    fs.writeFileSync(CONTACTS_CACHE_FILE, JSON.stringify(allContacts, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving contacts cache:', err.message);
  }
}

const lidToJid = {}; // lid -> jid mapping
const jidToLid = {}; // jid -> lid mapping

function getSocket() { return sock; }
function getQRDataURL() { return qrDataURL; }
function getConnectionStatus() { return connectionStatus; }
function getAllContacts() { return allContacts; }

async function resolveContactLid(...jids) {
  if (!sock || jids.length === 0) return;
  try {
    const waInfo = await sock.onWhatsApp(...jids);
    for (const info of waInfo || []) {
      if (info.exists && info.lid) {
        lidToJid[info.lid] = info.jid;
        jidToLid[info.jid] = info.lid;
      }
    }
    return waInfo;
  } catch (err) {
    console.error('Failed to resolve LID(s):', err.message);
    return null;
  }
}

// In-memory store for getMessage (required for SenderKey decryption of status messages)
const messageStore = new Map();

async function getOrFetchProfilePic(lid) {
  const phoneJid = state.phoneMapping[lid] || lidToJid[lid] || lid;
  const name = state.userNames[lid] || phoneJid;
  
  // check if we already fetched it recently
  const contact = allContacts[lid] || allContacts[phoneJid] || {};
  if (contact.profilePicUrl !== undefined) {
     // Check if we need to refresh (e.g. > 24 hours)
     if (contact.profilePicFetchedAt && (Date.now() - contact.profilePicFetchedAt < 24 * 60 * 60 * 1000)) {
         return contact.profilePicUrl;
     }
  }

  // fetch from WA
  let profilePicUrl = null;
  if (sock) {
     try {
         profilePicUrl = await sock.profilePictureUrl(phoneJid, 'image');
         console.log(`🖼️ Foto profil diambil untuk ${name}: berhasil`);
     } catch(err) {
         console.log(`🖼️ Foto profil diambil untuk ${name}: tidak tersedia/private`);
     }
  }

  // update allContacts and save
  if (!allContacts[lid]) allContacts[lid] = { id: lid };
  allContacts[lid].profilePicUrl = profilePicUrl;
  allContacts[lid].profilePicFetchedAt = Date.now();
  saveContactsCache();
  
  return profilePicUrl;
}

async function setupWhatsApp(wss) {
  loadState();
  loadContactsCache();

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['WA-Tracker', 'Chrome', '4.0.0'],
    syncFullHistory: true,
    // Required for SenderKey decryption (status/story messages use Signal SenderKey protocol)
    getMessage: async (key) => {
      const id = `${key.remoteJid}:${key.id}`;
      return messageStore.get(id);
    },
  });

  // Handle connection updates (QR code, connected, disconnected)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'waiting_qr';
      try {
        qrDataURL = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        console.log('📱 QR Code tersedia — scan dari /api/qr atau terminal');
      } catch (err) {
        console.error('QR generation error:', err.message);
      }

      // Broadcast QR update via WebSocket
      broadcastUpdate({ type: 'qr', qr: qrDataURL });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      connectionStatus = 'disconnected';
      qrDataURL = null;

      if (reason !== DisconnectReason.loggedOut) {
        console.log(`🔄 Reconnecting... (Reason: ${reason})`);
        setTimeout(() => setupWhatsApp(wss), 3000);
      } else {
        console.log('🚪 Logged out. Session invalid. Deleting auth folder and restarting...');
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        setTimeout(() => setupWhatsApp(wss), 3000);
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrDataURL = null;
      console.log('✅ WhatsApp terhubung!');

      // Send presence available (like Go's client.SendPresence)
      await sock.sendPresenceUpdate('available');

      // Populate in-memory JID-to-LID mapping from persistent phoneMapping
      if (state.phoneMapping) {
        for (const [lid, phoneJid] of Object.entries(state.phoneMapping)) {
          lidToJid[lid] = phoneJid;
          jidToLid[phoneJid] = lid;
        }
        console.log(`🔗 Loaded ${Object.keys(jidToLid).length} LID mappings from phoneMapping`);
      }

      // Migrate existing state from JID to LID if necessary
      const trackedKeys = Object.keys(state.userStatus);
      const jidsToResolve = trackedKeys.filter(k => k.includes('@s.whatsapp.net'));
      
      if (jidsToResolve.length > 0) {
        await resolveContactLid(...jidsToResolve);
        for (const jid of jidsToResolve) {
          const lid = jidToLid[jid];
          if (lid) {
            state.userStatus[lid] = state.userStatus[jid];
            state.userNames[lid] = state.userNames[jid];
            state.userStatusLog[lid] = state.userStatusLog[jid];
            state.phoneMapping[lid] = jid;
            
            delete state.userStatus[jid];
            delete state.userNames[jid];
            delete state.userStatusLog[jid];
          }
        }
        saveState();
      }

      // Re-subscribe all tracked contacts. Use phoneMapping to get the JID.
      const updatedKeys = Object.keys(state.userStatus);
      for (const id of updatedKeys) {
        // Find the phone JID to subscribe to. Fallback to ID if not mapped.
        const phoneJid = state.phoneMapping[id] || lidToJid[id] || id;
        try {
          await sock.presenceSubscribe(phoneJid);
          console.log(`Subscribed: ${phoneJid} (LID: ${id})`);
          if (id !== phoneJid && id.includes('@lid')) {
            await sock.presenceSubscribe(id);
            console.log(`Subscribed directly to LID: ${id}`);
          }
          // Fetch profile pic in background
          getOrFetchProfilePic(id).catch(err => console.error('Error fetching profile pic:', err.message));
        } catch (err) {
          console.error(`Failed to re-subscribe ${phoneJid}:`, err.message);
        }
      }

      broadcastUpdate({ type: 'connection', status: 'connected' });
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);



  // Handle contacts sync
  sock.ev.on('messaging-history.set', ({ contacts }) => {
    let newCount = 0;
    for (const contact of contacts) {
      if (contact.id) {
        allContacts[contact.id] = contact;
        newCount++;
      }
    }
    saveContactsCache();
    console.log(`📂 Sinkronisasi awal: ${newCount} kontak diterima dari riwayat WhatsApp`);
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    let newCount = 0;
    for (const contact of contacts) {
      if (contact.id) {
        allContacts[contact.id] = Object.assign(allContacts[contact.id] || {}, contact);
        newCount++;
      }
    }
    saveContactsCache();
    if (newCount > 0) console.log(`📇 Contact cache updated: +${newCount} kontak baru (upsert)`);
  });

  sock.ev.on('contacts.update', (contacts) => {
    for (const contact of contacts) {
      if (contact.id) {
        allContacts[contact.id] = Object.assign(allContacts[contact.id] || {}, contact);
      }
    }
    saveContactsCache();
  });

  // Handle presence updates — the core tracking logic (like Go's eventHandler for *events.Presence)
  sock.ev.on('presence.update', (presenceUpdate) => {
    console.log('👀 Presence event masuk:', JSON.stringify(presenceUpdate));
    const rawJid = presenceUpdate.id;
    if (!rawJid) return;

    let normalizedJid = rawJid;
    if (rawJid.includes('@s.whatsapp.net') && jidToLid[rawJid]) {
      // If event comes as normal JID, map it to LID since state uses LID
      normalizedJid = jidToLid[rawJid];
    } else if (rawJid.includes('@lid') && !state.userStatus[rawJid]) {
        // Just in case it's not tracked directly but we have it? No, keep it as LID
    }

    console.log(`Presence RAW: ${rawJid} → NORMALIZED: ${normalizedJid}`);
    console.log("Presence Update:", JSON.stringify(presenceUpdate));
    
    // Only process tracked contacts
    if (!(normalizedJid in state.userStatus)) return;

    const presences = presenceUpdate.presences;
    if (!presences) return;

    for (const [participantJid, presence] of Object.entries(presences)) {
      const isOnline = presence.lastKnownPresence === 'available' || presence.lastKnownPresence === 'composing';
      const statusText = isOnline ? 'Online' : 'Offline';

      const prevStatus = state.userStatus[normalizedJid];
      state.userStatus[normalizedJid] = statusText;

      if (!state.userStatusLog[normalizedJid]) {
        state.userStatusLog[normalizedJid] = [];
      }
      state.userStatusLog[normalizedJid].push({
        time: new Date().toISOString(),
        status: statusText,
      });

      const name = state.userNames[normalizedJid] || normalizedJid;

      // Only send notification if status actually changed (like Go version)
      if (prevStatus !== statusText) {
        if (statusText === 'Online') {
          console.log(`🟢 ${name} Online`);
          sendNtfyNotification(`${name} sedang Online! 🟢`);
        } else {
          console.log(`🔴 ${name} Offline`);
          sendNtfyNotification(`${name} sekarang Offline 🔴`);
        }
      }

      // Broadcast via WebSocket for real-time update
      const logs = state.userStatusLog[normalizedJid] || [];
      const onlineRanges = calculateOnlineRanges(logs);
      
      const phoneJid = state.phoneMapping[normalizedJid] || normalizedJid;
      const contactInfo = allContacts[normalizedJid] || allContacts[phoneJid] || {};
      const profilePicUrl = contactInfo.profilePicUrl || null;

      broadcastUpdate({
        type: 'presence',
        jid: normalizedJid,
        username: state.userNames[normalizedJid] || '',
        status: statusText,
        isOnline,
        onlineRanges,
        logs,
        profilePicUrl,
      });

      saveState();
    }
  });

  // Handle Status updates (Story saver)
  // Debug: log EVERY messages.upsert RAW to diagnose delivery
  sock.ev.on('messages.upsert', async (m) => {
    // ── Store ALL messages for getMessage callback (SenderKey decryption) ──
    for (const msg of m.messages || []) {
      if (msg.key && msg.message) {
        const storeId = `${msg.key.remoteJid}:${msg.key.id}`;
        messageStore.set(storeId, msg.message);
        // Keep store bounded — remove oldest if over 500 entries
        if (messageStore.size > 500) {
          messageStore.delete(messageStore.keys().next().value);
        }
      }
    }

    // ── DEBUG: always log to see what's coming in ──────────────────
    const hasStatusBroadcast = m.messages && m.messages.some(msg => msg.key && msg.key.remoteJid === 'status@broadcast');
    if (hasStatusBroadcast) {
      console.log('📡 [STORY DEBUG] status@broadcast message received!');
      console.log('📡 [STORY DEBUG] RAW:', JSON.stringify(m, null, 2));
    } else {
      // Log non-story upserts briefly (not full dump)
      console.log(`📩 [messages.upsert] type=${m.type} count=${m.messages?.length}`);
    }
    // ──────────────────────────────────────────────────────────────

    // Accept both 'notify' (new msg) and 'append' (history-synced status)
    if (m.type !== 'notify' && m.type !== 'append') return;

    for (const msg of m.messages) {
      if (msg.key.remoteJid !== 'status@broadcast') continue;

      // participant field holds the real sender JID for status@broadcast
      // For self-stories it is absent — skip those
      const participantJid = msg.key.participant || msg.participant;
      console.log(`📡 [STORY DEBUG] participant=${participantJid} fromMe=${msg.key.fromMe}`);
      if (!participantJid) continue;

      // Reverse lookup: participantJid is always @s.whatsapp.net
      // Check if this phone JID maps to a tracked LID via phoneMapping
      let normalizedJid = null;
      for (const [lid, phoneJid] of Object.entries(state.phoneMapping)) {
        if (phoneJid === participantJid && state.userStatus[lid] !== undefined) {
          normalizedJid = lid;
          break;
        }
      }
      // Also try direct match (in case contact was tracked by phone JID directly)
      if (!normalizedJid && state.userStatus[participantJid] !== undefined) {
        normalizedJid = participantJid;
      }

      if (!normalizedJid) {
        console.log(`📡 [STORY DEBUG] participant ${participantJid} NOT tracked — skip`);
        continue;
      }

      console.log(`📡 [STORY DEBUG] ✅ Matched tracked contact: ${normalizedJid}`);

      const msgId = msg.key.id;
      const timestamp = (msg.messageTimestamp
        ? (typeof msg.messageTimestamp === 'object' ? Number(msg.messageTimestamp.low || msg.messageTimestamp) : msg.messageTimestamp)
        : Math.floor(Date.now() / 1000)) * 1000;

      const messageContent = msg.message;
      if (!messageContent) {
        console.log('📡 [STORY DEBUG] msg.message is empty — skip');
        continue;
      }

      const contentKeys = Object.keys(messageContent);
      console.log(`📡 [STORY DEBUG] contentKeys: ${contentKeys.join(', ')}`);

      // Try to find the real content, unwrapping senderKeyDistributionMessage etc.
      let contentKey = contentKeys.find(k => ['imageMessage', 'videoMessage', 'extendedTextMessage'].includes(k));

      if (!contentKey) {
        console.log(`📡 [STORY DEBUG] No usable content key found in: ${contentKeys.join(', ')}`);
        continue;
      }

      try {
        let type = 'unknown';
        let caption = '';
        let mediaUrl = null;
        let textOptions = null;

        if (contentKey === 'imageMessage' || contentKey === 'videoMessage') {
          type = contentKey === 'imageMessage' ? 'image' : 'video';
          const mediaObj = messageContent[contentKey];
          caption = mediaObj.caption || '';

          const ext = type === 'image' ? 'jpg' : 'mp4';
          const jidFolder = normalizedJid.replace(/[^a-zA-Z0-9]/g, '_');
          const saveDir = path.join(__dirname, '..', '..', 'storage', 'statuses', jidFolder);
          if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

          const fileName = `${timestamp}_${msgId}.${ext}`;
          const savePath = path.join(saveDir, fileName);

          if (!fs.existsSync(savePath)) {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            fs.writeFileSync(savePath, buffer);
          }
          mediaUrl = `/storage/statuses/${jidFolder}/${fileName}`;

        } else if (contentKey === 'extendedTextMessage') {
          type = 'text';
          const textMsg = messageContent[contentKey];
          caption = textMsg.text || '';
          let bgHex = '#000000';
          if (textMsg.backgroundArgb) {
            bgHex = '#' + (textMsg.backgroundArgb >>> 0).toString(16).padStart(8, '0').slice(2);
          }
          textOptions = { backgroundColor: bgHex, font: textMsg.font || 0 };
        }

        if (type !== 'unknown') {
          if (!state.userStatuses[normalizedJid]) state.userStatuses[normalizedJid] = [];
          const exists = state.userStatuses[normalizedJid].find(s => s.id === msgId);
          if (!exists) {
            state.userStatuses[normalizedJid].push({ id: msgId, timestamp, type, mediaUrl, caption, textOptions });
            saveState();
            const name = state.userNames[normalizedJid] || normalizedJid;
            console.log(`📖 Story baru disimpan dari ${name} (${normalizedJid}): ${type}`);
          } else {
            console.log(`📡 [STORY DEBUG] Duplicate story ${msgId} — skip`);
          }
        }
      } catch (err) {
        console.error(`❌ Failed to save story from ${participantJid}:`, err.message);
      }
    }
  });

  // Also listen on 'status.update' if it exists in this Baileys version
  if (typeof sock.ev.on === 'function') {
    try {
      sock.ev.on('status.update', (update) => {
        console.log('📡 [STATUS.UPDATE]', JSON.stringify(update, null, 2));
      });
    } catch(_) { /* event may not exist */ }
  }
}


module.exports = {
  setupWhatsApp,
  getSocket,
  getQRDataURL,
  getConnectionStatus,
  getAllContacts,
  resolveContactLid,
  jidToLid,
  getOrFetchProfilePic,
};
