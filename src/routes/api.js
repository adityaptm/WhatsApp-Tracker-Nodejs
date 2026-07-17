/**
 * REST API routes — equivalent to Go's HTTP handlers
 */

const express = require('express');
const router = express.Router();
const { getQRDataURL, getConnectionStatus, getSocket, getAllContacts, resolveContactLid, jidToLid, getOrFetchProfilePic, logoutWhatsApp } = require('../services/whatsapp');
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

// POST /api/logout — Logout from WhatsApp session
router.post('/logout', async (req, res) => {
  const result = await logoutWhatsApp();
  if (result.success) {
    res.json({ status: 'ok', message: 'Logout berhasil, device sudah ter-unlink dari WhatsApp' });
  } else {
    res.status(500).json({ 
      status: 'partial', 
      message: 'Aplikasi logout secara lokal, tapi gagal unlink dari server WhatsApp. Silakan unlink manual dari HP di menu Perangkat Tertaut.', 
      error: result.error 
    });
  }
});

// GET /api/contacts — all available contacts from WhatsApp store
router.get('/contacts', (req, res) => {
  const contacts = getAllContacts();
  const result = [];
  for (const [jid, contact] of Object.entries(contacts)) {
    // Skip non-user JIDs (groups, broadcast, etc)
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    // Map to LID for frontend if available, else omit (or fetch it)
    const lid = contact.lid || (jidToLid && jidToLid[jid]);
    if (lid) {
      result.push({
        jid: lid, // return LID
        name: contact.name || contact.notify || contact.verifiedName || lid,
        profilePicUrl: contact.profilePicUrl || null,
      });
    }
  }
  // Sort by name
  result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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

  const waInfos = await resolveContactLid(...selectedJIDs) || [];
  
  for (const jid of selectedJIDs) {
    try {
      await sock.presenceSubscribe(jid);
      console.log("Subscribed:", jid);
      
      const info = waInfos.find(i => i.jid === jid);
      const lid = (info && info.lid) ? info.lid : jid;
      
      if (lid !== jid && lid.includes('@lid')) {
        await sock.presenceSubscribe(lid);
        console.log("Subscribed directly to LID:", lid);
      }
      
      if (!state.userStatus[lid]) {
        state.userStatus[lid] = 'Menunggu...';
      }
      if (lid !== jid) {
         state.phoneMapping[lid] = jid;
      }
      // Fetch profile pic in background
      getOrFetchProfilePic(lid).catch(err => console.error('Error fetching profile pic:', err.message));
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
  const contacts = getAllContacts();
  for (const [jid, logs] of Object.entries(state.userStatusLog)) {
    const onlineRanges = calculateOnlineRanges(logs);
    let isOnline = false;
    if (logs.length > 0) {
      isOnline = logs[logs.length - 1].status === 'Online';
    }
    
    // Get profilePicUrl from contacts cache
    const phoneJid = state.phoneMapping[jid] || jid;
    const contactInfo = contacts[jid] || contacts[phoneJid] || {};
    const profilePicUrl = contactInfo.profilePicUrl || null;

    updates.push({
      jid,
      username: state.userNames[jid] || '',
      onlineRanges,
      isOnline,
      logs,
      profilePicUrl,
    });
  }
  res.json(updates);
});

// GET /api/contacts/:jid/status — specific contact status
router.get('/contacts/:jid/status', (req, res) => {
  const jid = req.params.jid;
  // JID passed here will now likely be a LID from the frontend.
  // We can just use it directly.
  let fullJid = jid;
  if (!fullJid.includes('@')) fullJid += '@s.whatsapp.net'; // Only if they manually typed it

  // But we allow it to be LID
  if (jid.includes('@lid')) {
    fullJid = jid;
  }

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
    const waInfo = await resolveContactLid(jid);
    if (!waInfo || waInfo.length === 0 || !waInfo[0].exists || !waInfo[0].lid) {
       return res.status(400).json({ error: 'Nomor tidak ditemukan di WhatsApp atau tidak memiliki LID' });
    }
    const lid = waInfo[0].lid;
    
    await sock.presenceSubscribe(jid);
    console.log(`Subscribed: ${jid} (LID: ${lid})`);
    if (lid !== jid && lid.includes('@lid')) {
      await sock.presenceSubscribe(lid);
      console.log(`Subscribed directly to LID: ${lid}`);
    }
    
    if (!state.userStatus[lid]) {
      state.userStatus[lid] = 'Menunggu...';
    }
    if (name) {
      state.userNames[lid] = name;
    } else if (!state.userNames[lid]) {
      state.userNames[lid] = lid; // Do not use phone number
    }
  
    if (!state.userStatusLog[lid]) {
      state.userStatusLog[lid] = [];
    }
    
    state.phoneMapping[lid] = jid;
    saveState();
    console.log(`📌 Kontak ditambahkan: LID ${lid} (${state.userNames[lid]})`);
    
    // Fetch profile pic in background
    getOrFetchProfilePic(lid).catch(err => console.error('Error fetching profile pic:', err.message));
  
    res.json({
      status: 'ok',
      jid: lid,
      name: state.userNames[lid],
    });
  } catch (err) {
    return res.status(400).json({ error: 'Gagal menambahkan kontak: ' + err.message });
  }
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

// ─── Story / Status Saver ────────────────────────────────────────────
// NOTE: These MUST come AFTER all literal /contacts/* routes (e.g. /contacts/tracked)
// to prevent Express matching 'tracked' as the :jid param.

// GET /api/statuses — ALL stories from ALL tracked contacts, newest first
router.get('/statuses', (req, res) => {
  try {
    // ── DEBUG: show raw state before any filtering ──
    const keys = Object.keys(state.userStatuses);
    console.log(`🔍 [DEBUG] GET /statuses — state.userStatuses has ${keys.length} keys: ${keys.join(', ')}`);
    for (const k of keys) {
      const arr = state.userStatuses[k];
      console.log(`🔍 [DEBUG]   key="${k}" → isArray=${Array.isArray(arr)}, length=${Array.isArray(arr) ? arr.length : 'N/A'}`);
      if (Array.isArray(arr) && arr.length > 0) {
        arr.forEach((s, i) => console.log(`🔍 [DEBUG]     [${i}] id=${s.id} ts=${s.timestamp} type=${s.type}`));
      }
    }
    // ─────────────────────────────────────────────────

    const retentionDays = parseInt(process.env.STORY_RETENTION_DAYS || '30', 10);
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const all = [];

    for (const [jid, stories] of Object.entries(state.userStatuses)) {
      if (!Array.isArray(stories)) continue;
      const name = state.userNames[jid] || jid;
      for (const s of stories) {
        if (s.timestamp >= cutoffTime) {
          all.push({ ...s, jid, contactName: name });
        } else {
          console.log(`⚠️ [Story API] Filtered out story id=${s.id} from ${jid}: ts=${s.timestamp} < cutoff=${cutoffTime} (retentionDays=${retentionDays})`);
        }
      }
    }

    all.sort((a, b) => b.timestamp - a.timestamp);
    console.log(`[Story API] GET /statuses → ${all.length} stories total`);
    return res.json(all);
  } catch (err) {
    console.error('[Story API] /statuses error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:jid/statuses
router.get('/contacts/:jid/statuses', (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid);
    console.log(`[Story API] GET statuses for JID: "${jid}"`);

    let fullJid = jid;
    if (!fullJid.includes('@')) fullJid += '@s.whatsapp.net';

    const statuses = state.userStatuses[fullJid] || [];
    console.log(`🔍 [DEBUG] /contacts/${jid}/statuses → found ${statuses.length} stories for key "${fullJid}"`);

    const retentionDays = parseInt(process.env.STORY_RETENTION_DAYS || '30', 10);
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const validStatuses = statuses.filter(s => s.timestamp >= cutoffTime);

    if (validStatuses.length !== statuses.length) {
      const removed = statuses.length - validStatuses.length;
      console.log(`🗑️ [Story API] Retention cleanup: removing ${removed} expired stories from "${fullJid}" (cutoff=${cutoffTime})`);
      // Log each removed story for debugging
      statuses.filter(s => s.timestamp < cutoffTime).forEach(s => {
        console.log(`🗑️ [Story API]   removed: id=${s.id} ts=${s.timestamp} type=${s.type}`);
      });
      state.userStatuses[fullJid] = validStatuses;
      saveState();
    }

    return res.json(validStatuses.sort((a, b) => b.timestamp - a.timestamp));
  } catch (err) {
    console.error('[Story API] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contacts/:jid/statuses/:statusId
router.delete('/contacts/:jid/statuses/:statusId', (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid);
    const statusId = req.params.statusId;

    let fullJid = jid;
    if (!fullJid.includes('@')) fullJid += '@s.whatsapp.net';

    if (!state.userStatuses[fullJid]) {
      return res.status(404).json({ error: 'No statuses found for this contact' });
    }

    const story = state.userStatuses[fullJid].find(s => s.id === statusId);
    if (story && story.mediaUrl) {
      try {
        const fs = require('fs');
        const filepath = require('path').join(__dirname, '..', '..', story.mediaUrl);
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      } catch (fileErr) {
        console.error('Failed to delete media file:', fileErr.message);
      }
    }

    const before = state.userStatuses[fullJid].length;
    state.userStatuses[fullJid] = state.userStatuses[fullJid].filter(s => s.id !== statusId);

    if (state.userStatuses[fullJid].length < before) {
      saveState();
      return res.json({ status: 'ok' });
    }

    return res.status(404).json({ error: 'Status not found' });
  } catch (err) {
    console.error('[Story API] Delete Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
