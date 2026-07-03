/**
 * WebSocket server for real-time status updates.
 * Replaces Go's 1-second polling with true push-based updates.
 */

const { WebSocketServer } = require('ws');

let wssInstance = null;

function setupWebSocket(server) {
  wssInstance = new WebSocketServer({ server, path: '/ws' });

  wssInstance.on('connection', (ws) => {
    console.log('🔌 WebSocket client connected');

    ws.on('close', () => {
      console.log('🔌 WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  });

  return wssInstance;
}

/**
 * Broadcast a message to all connected WebSocket clients
 */
function broadcastUpdate(data) {
  if (!wssInstance) return;

  const message = JSON.stringify(data);
  wssInstance.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

module.exports = { setupWebSocket, broadcastUpdate };
