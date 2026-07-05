/**
 * WebSocket server for real-time status updates.
 * Replaces Go's 1-second polling with true push-based updates.
 */

const { WebSocketServer } = require('ws');

let wssInstance = null;

function setupWebSocket(server) {
  wssInstance = new WebSocketServer({ server, path: '/ws' });

  // Ping interval to keep connections alive and detect dead connections
  const interval = setInterval(() => {
    if (!wssInstance) return;
    wssInstance.clients.forEach((client) => {
      if (client.isAlive === false) {
        console.log('🔌 Terminating dead WebSocket client');
        return client.terminate();
      }
      client.isAlive = false;
      client.ping();
    });
  }, 30000);

  wssInstance.on('connection', (ws) => {
    console.log('🔌 WebSocket client connected');
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 WebSocket client disconnected (Code: ${code}, Reason: ${reason ? reason.toString() : 'No reason'})`);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  });

  wssInstance.on('close', () => {
    clearInterval(interval);
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
