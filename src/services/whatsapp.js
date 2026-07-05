/**
 * WhatsApp client service using Baileys — equivalent to Go's whatsapp.go
 * Handles: connection, QR code generation, presence subscription, event handling.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
    syncFullHistory: false,
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
      broadcastUpdate({
        type: 'presence',
        jid: normalizedJid,
        username: state.userNames[normalizedJid] || '',
        status: statusText,
        isOnline,
        onlineRanges,
        logs,
      });

      saveState();
    }
  });
}

module.exports = {
  setupWhatsApp,
  getSocket,
  getQRDataURL,
  getConnectionStatus,
  getAllContacts,
  resolveContactLid,
  jidToLid,
};
