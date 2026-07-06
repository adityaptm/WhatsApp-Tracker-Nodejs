/**
 * Page routes — serves the HTML pages (select_contacts.html, status.html)
 */

const express = require('express');
const router = express.Router();
const path = require('path');

// GET / or /select — Select Contacts page
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'select_contacts.html'));
});

router.get('/select', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'select_contacts.html'));
});

// POST /select — handle form submission, redirect to /status
router.post('/select', (req, res) => {
  // The actual logic is handled by /api/contacts/select
  // This just redirects after form post (like Go's http.Redirect)
  let contacts = req.body.contacts;
  if (!contacts) {
    return res.redirect('/select');
  }
  if (!Array.isArray(contacts)) {
    contacts = [contacts];
  }

  // Forward to the API handler internally
  const { getSocket } = require('../services/whatsapp');
  const { state, saveState } = require('../services/state');
  const sock = getSocket();

  if (sock) {
    const promises = contacts.map(async (jid) => {
      try {
        await sock.presenceSubscribe(jid);
        
        // Resolve LID
        const waInfo = await sock.onWhatsApp(jid);
        const lid = (waInfo && waInfo[0] && waInfo[0].exists && waInfo[0].lid) ? waInfo[0].lid : jid;
        
        if (lid !== jid && lid.includes('@lid')) {
          await sock.presenceSubscribe(lid);
          state.phoneMapping[lid] = jid;
        }

        if (!state.userStatus[lid]) {
          state.userStatus[lid] = 'Menunggu...';
        }
        if (!state.userStatusLog[lid]) {
          state.userStatusLog[lid] = [];
        }
      } catch (err) {
        console.error(`Failed to subscribe ${jid}:`, err.message);
      }
    });

    Promise.all(promises).then(() => {
      saveState();
      setTimeout(() => {
        res.redirect('/status');
      }, 1000);
    });
  } else {
    res.redirect('/status');
  }
});

// GET /status — Status page
router.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'status.html'));
});

module.exports = router;
