require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { setupWebSocket } = require('./services/websocket');
const { setupWhatsApp } = require('./services/whatsapp');
const apiRoutes = require('./routes/api');
const pageRoutes = require('./routes/pages');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/storage', express.static(path.join(__dirname, '..', 'storage')));

// Routes
app.use('/', pageRoutes);
app.use('/api', apiRoutes);

// Setup WebSocket
const wss = setupWebSocket(server);

// Setup WhatsApp
setupWhatsApp(wss);

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ WhatsApp Status Monitor running on http://0.0.0.0:${PORT}`);
  console.log(`📱 Buka URL di atas dari browser manapun untuk mengakses dashboard`);
});
