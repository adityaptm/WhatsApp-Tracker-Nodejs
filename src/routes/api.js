/**
 * REST API routes — equivalent to Go's HTTP handlers
 */

const express = require('express');
const router = express.Router();
const { getQRDataURL, getConnectionStatus, getSocket, getAllContacts } = require('../services/whatsapp');
const { state, saveState, calculateOnlineRanges } = require('../services/state');

// GET /api/qr — QR code as data URL
router.get('/qr', (req, res) => {
  const qr = getQRDataURL();
  if (qr) {
    res.json({ qr, status: 'waiting_qr' });
  } else {
    const connStatus = getConnectionStatus();
    res.json({ qr: null, status: connStatus });
  }
});

// GET /api/status — WhatsApp connection status
router.get('/status', (req, res) => {
  res.json({ status: getConnectionStatus() });
});

// GET /api/contacts — all available contacts from WhatsApp store
router.get('/contacts', (req, res) => {
  const contacts = getAllContacts();
  const result = [];
  for (const [jid, contact] of Object.entries(contacts)) {
    // Skip non-user JIDs (groups, broadcast, etc)
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    result.push({
      jid,
      name: contact.name || contact.notify || contact.verifiedName || '+' + jid.split('@')[0],
    });
  }
  // Sort by name
  result.sort((a, b) => a.name.localeCompare(b.name));
  res.json(result);
});

// POST /api/contacts/select — select contacts to monitor (body: { contacts: [jid1, jid2, ...] })
router.post('/contacts/select', async (req, res) => {
  const sock = getSocket();
  if (!sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  // Support both JSON body and form-encoded
  let selectedJIDs = req.body.contacts;
  if (!selectedJIDs && typeof req.body === 'object') {
    // form-encoded "contacts" can be a string or array
    selectedJIDs = Array.isArray(req.body.contacts) ? req.body.contacts : [req.body.contacts].filter(Boolean);
  }

  if (!selectedJIDs || !Array.isArray(selectedJIDs)) {
    return res.status(400).json({ error: 'contacts array is required' });
  }

  for (const jid of selectedJIDs) {
    try {
      await sock.presenceSubscribe(jid);
      console.log("Subscribed:", jid);
      if (!state.userStatus[jid]) {
        state.userStatus[jid] = 'Menunggu...';
      }
    } catch (err) {
      console.error(`Failed to subscribe ${jid}:`, err.message);
    }
  }

  saveState();

  // Wait a moment for presence data to arrive (like Go's time.Sleep(1 * time.Second))
  setTimeout(() => {
    res.json({ status: 'ok', tracked: selectedJIDs.length });
  }, 1000);
});

// GET /api/contacts/tracked — tracked contacts with real-time status (replaces Go's /api/status-updates)
router.get('/contacts/tracked', (req, res) => {
  const updates = [];
  for (const [jid, logs] of Object.entries(state.userStatusLog)) {
    const onlineRanges = calculateOnlineRanges(logs);
    let isOnline = false;
    if (logs.length > 0) {
      isOnline = logs[logs.length - 1].status === 'Online';
    }
    updates.push({
      jid,
      username: state.userNames[jid] || '',
      onlineRanges,
      isOnline,
      logs,
    });
  }
  res.json(updates);
});

// GET /api/contacts/:jid/status — specific contact status
router.get('/contacts/:jid/status', (req, res) => {
  const jid = req.params.jid;
  // Support both full JID and just phone number
  const fullJid = jid.includes('@') ? jid : jid + '@s.whatsapp.net';

  if (!state.userStatus[fullJid]) {
    return res.status(404).json({ error: 'Contact not tracked' });
  }

  const logs = state.userStatusLog[fullJid] || [];
  const onlineRanges = calculateOnlineRanges(logs);
  let isOnline = false;
  if (logs.length > 0) {
    isOnline = logs[logs.length - 1].status === 'Online';
  }

  res.json({
    jid: fullJid,
    username: state.userNames[fullJid] || '',
    currentStatus: state.userStatus[fullJid],
    onlineRanges,
    isOnline,
    logs,
  });
});

// POST /api/remove-contact — remove a tracked contact (same as Go's /api/remove-contact)
router.post('/remove-contact', (req, res) => {
  const jid = req.body.jid;
  if (!jid) {
    return res.status(400).json({ error: 'jid is required' });
  }

  delete state.userStatus[jid];
  delete state.userStatusLog[jid];
  delete state.userNames[jid];
  saveState();

  res.json({ status: 'ok' });
});

// POST /api/rename — rename a tracked contact (same as Go's /api/rename)
router.post('/rename', (req, res) => {
  const { jid, name } = req.body;
  if (!jid || !name) {
    return res.status(400).json({ error: 'jid and name are required' });
  }

  state.userNames[jid] = name;
  saveState();

  res.json({ status: 'ok' });
});

// POST /api/add-contact — add contact by phone number (same as Go's /api/add-contact)
router.post('/add-contact', async (req, res) => {
  const sock = getSocket();
  if (!sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  let phone = req.body.phone || '';
  const name = req.body.name || '';

  if (!phone) {
    return res.status(400).json({ error: 'phone is required' });
  }

  // Clean phone number (same logic as Go)
  phone = phone.replace(/\+/g, '').replace(/-/g, '').replace(/ /g, '');
  if (phone.startsWith('0')) {
    phone = '62' + phone.substring(1);
  }

  const jid = phone + '@s.whatsapp.net';

  try {
    await sock.presenceSubscribe(jid);
    console.log("Subscribed:", jid);
  } catch (err) {
    return res.status(400).json({ error: 'invalid phone number' });
  }

  if (!state.userStatus[jid]) {
    state.userStatus[jid] = 'Menunggu...';
  }
  if (name) {
    state.userNames[jid] = name;
  } else if (!state.userNames[jid]) {
    state.userNames[jid] = '+' + phone;
  }

  if (!state.userStatusLog[jid]) {
    state.userStatusLog[jid] = [];
  }

  saveState();
  console.log(`📌 Kontak ditambahkan: ${jid} (${state.userNames[jid]})`);

  res.json({
    status: 'ok',
    jid,
    name: state.userNames[jid],
  });
});

// Legacy compatibility: /api/status-updates (used by status.html polling)
router.get('/status-updates', (req, res) => {
  const updates = [];
  for (const [jid, logs] of Object.entries(state.userStatusLog)) {
    const onlineRanges = calculateOnlineRanges(logs);
    let isOnline = false;
    if (logs.length > 0) {
      isOnline = logs[logs.length - 1].status === 'Online';
    }
    updates.push({
      jid,
      username: state.userNames[jid] || '',
      onlineRanges,
      isOnline,
      logs,
    });
  }
  res.json(updates);
});

module.exports = router;
