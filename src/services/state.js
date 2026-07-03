/**
 * Persistent state manager — replaces the Go global variables + JSON file persistence.
 * Maps directly to Go's PersistentState struct:
 *   { logs: {jid: [{time, status}]}, names: {jid: name}, status: {jid: status} }
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', '..', 'logs.json');

// In-memory state (equivalent to Go's global vars)
const state = {
  userStatus: {},    // map[string]string — current status per JID
  userNames: {},     // map[string]string — display name per JID
  userStatusLog: {}, // map[string][]StatusLog — history of status changes
};

/**
 * Load state from logs.json (same format as Go version)
 */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);

    // Support new format { logs, names, status }
    if (data.logs) {
      state.userStatusLog = data.logs;
    }
    if (data.names) {
      state.userNames = data.names;
    }
    if (data.status) {
      state.userStatus = data.status;
    }

    // Fallback: old format where the file was just the logs map directly
    if (!data.logs && !data.names && !data.status) {
      state.userStatusLog = data;
    }

    const count = Object.keys(state.userStatus).length;
    console.log(`📂 State dimuat: ${count} kontak terpantau`);
  } catch (err) {
    console.error('Error loading state:', err.message);
  }
}

/**
 * Save state to logs.json (same format as Go version)
 */
function saveState() {
  try {
    const data = {
      logs: state.userStatusLog,
      names: state.userNames,
      status: state.userStatus,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving state:', err.message);
  }
}

/**
 * Calculate online ranges from logs (equivalent to Go's calculateOnlineRanges)
 */
function calculateOnlineRanges(logs) {
  const ranges = [];
  let currentRange = null;

  for (const log of logs) {
    if (log.status === 'Online') {
      if (!currentRange) {
        currentRange = { start: log.time };
      }
    } else if (log.status === 'Offline' && currentRange) {
      currentRange.end = log.time;
      ranges.push({ ...currentRange });
      currentRange = null;
    }
  }

  if (currentRange) {
    currentRange.end = new Date().toISOString();
    ranges.push({ ...currentRange });
  }

  return ranges;
}

module.exports = {
  state,
  loadState,
  saveState,
  calculateOnlineRanges,
};
