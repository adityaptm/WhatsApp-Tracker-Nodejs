const fs = require('fs');

let content = fs.readFileSync('E:/Wa-Tracker/status.html', 'utf8');

// 1. Remove the Go template loop
const regex = /\{\{range \$jid, \$data := \.\}\}[\s\S]*?\{\{end\}\}/;
content = content.replace(regex, '');

// 2. Add WebSocket connection
const wsCode = `
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(\`\${wsProtocol}//\${window.location.host}/ws\`);
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'presence') {
      let container = document.getElementById(data.jid);
      if (!container) {
        createContactCard(data.jid, data.username, data.isOnline);
      }
      updateChartTitles([{jid: data.jid, username: data.username}]);
      updateStatusIndicator(data.jid, data.isOnline);
      
      const content = document.getElementById(\`chart-content-\${data.jid}\`);
      if (content && content.classList.contains('active')) {
        if (!charts[data.jid]) {
          createChart(data.jid);
        }
        updateChart(data.jid, data.onlineRanges, data.isOnline);
        updateActivityLog(data.jid, data.logs);
      }
    } else if (data.type === 'connection') {
      console.log('WhatsApp connection status:', data.status);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected, reconnecting in 3s...');
    setTimeout(() => window.location.reload(), 3000);
  };
`;

content = content.replace('setInterval(fetchUpdates, 1000);', wsCode);
content = content.replace("fetch('/api/status-updates')", "fetch('/api/contacts/tracked')");

fs.writeFileSync('E:/Wa-Tracker-Nodejs/public/status.html', content);
console.log('status.html migrated successfully');
