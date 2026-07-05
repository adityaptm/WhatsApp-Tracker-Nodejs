/**
 * WhatsApp client service using Baileys — equivalent to Go's whatsapp.go
 * Handles: connection, QR code generation, presence subscription, event handling.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const { state, saveState, calculateOnlineRanges } = require('./state');
const { loadState } = require('./state');
const { sendNtfyNotification } = require('./ntfy');
const { broadcastUpdate } = require('./websocket');

const AUTH_DIR = path.join(__dirname, '..', '..', 'auth_info');

let sock = null;
let qrDataURL = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'waiting_qr' | 'connected'
let allContacts = {}; // cached contacts from WhatsApp store

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
  } catch (err) {
    console.error('Failed to resolve LID(s):', err.message);
  }
}

async function setupWhatsApp(wss) {
  loadState();

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['WA-Tracker', 'Chrome', '4.0.0'],
    syncFullHistory: true,
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
        console.log('🔄 Reconnecting...');
        setTimeout(() => setupWhatsApp(wss), 3000);
      } else {
        console.log('🚪 Logged out. Please restart to scan QR again.');
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrDataURL = null;
      console.log('✅ WhatsApp terhubung!');

      // Send presence available (like Go's client.SendPresence)
      await sock.sendPresenceUpdate('available');

      const trackedJids = Object.keys(state.userStatus);
      await resolveContactLid(...trackedJids);

      // Re-subscribe all tracked contacts (like Go's re-subscribe loop)
      for (const jid of trackedJids) {
        try {
          await sock.presenceSubscribe(jid);
          console.log(`Subscribed: ${jid}`);
        } catch (err) {
          console.error(`Failed to re-subscribe ${jid}:`, err.message);
        }
      }

      broadcastUpdate({ type: 'connection', status: 'connected' });
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);



  // Handle contacts sync
  sock.ev.on('messaging-history.set', ({ contacts }) => {
    for (const contact of contacts) {
      if (contact.id) {
        allContacts[contact.id] = contact;
      }
    }
    console.log(`📂 Sinkronisasi awal: ${contacts.length} kontak diterima dari riwayat WhatsApp`);
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.id) {
        allContacts[contact.id] = Object.assign(allContacts[contact.id] || {}, contact);
      }
    }
  });

  sock.ev.on('contacts.update', (contacts) => {
    for (const contact of contacts) {
      if (contact.id) {
        allContacts[contact.id] = Object.assign(allContacts[contact.id] || {}, contact);
      }
    }
  });

  // Handle presence updates — the core tracking logic (like Go's eventHandler for *events.Presence)
  sock.ev.on('presence.update', (presenceUpdate) => {
    const rawJid = presenceUpdate.id;
    if (!rawJid) return;

    let normalizedJid = rawJid;
    if (rawJid.includes('@lid') && lidToJid[rawJid]) {
      normalizedJid = lidToJid[rawJid];
    } else if (rawJid.includes('@s.whatsapp.net') && jidToLid[rawJid]) {
      // Sometimes it might come as normal JID but we want to ensure consistency. 
      // State always uses @s.whatsapp.net format.
      normalizedJid = rawJid;
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
};
