const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fsPromises = fs.promises;

const app = express();
const PORT = 3005;
const LOG_FILE = path.join(__dirname, 'telemetry.jsonl');

let fileMutex = Promise.resolve();

// CORS middleware
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origin.startsWith('chrome-extension://') || origin === 'http://localhost:3005' || origin === 'null') {
      callback(null, true);
    } else {
      callback(new Error('Forbidden origin'));
    }
  },
  methods: ['POST', 'DELETE', 'OPTIONS']
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.use(express.json({ limit: '5mb', type: '*/*' }));

app.post('/log', (req, res) => {
  if (req.body === undefined) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  let payload = req.body;
  const isPlainObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload);

  if (!isPlainObject) {
    payload = { data: payload, timestamp: Date.now() };
  } else if (!payload.timestamp) {
    payload.timestamp = Date.now();
  }

  const logLine = JSON.stringify(payload) + '\n';
  
  fileMutex = fileMutex.then(() => fsPromises.appendFile(LOG_FILE, logLine))
    .then(() => {
      res.status(200).json({ success: true });
    })
    .catch((err) => {
      console.error('File write error:', err);
      res.status(500).json({ error: 'Failed to write to log file' });
    });
});

app.get('/log', (req, res) => {
  fileMutex = fileMutex.then(() => fsPromises.readFile(LOG_FILE, 'utf8'))
    .then((data) => {
      res.status(200).type('text/plain').send(data);
    })
    .catch((err) => {
      if (err.code === 'ENOENT') {
        return res.status(200).type('text/plain').send('');
      }
      console.error('File read error:', err);
      res.status(500).json({ error: 'Failed to read log file' });
    });
});

app.delete('/log', (req, res) => {
  fileMutex = fileMutex.then(() => fsPromises.writeFile(LOG_FILE, ''))
    .then(() => {
      res.status(200).json({ success: true });
    })
    .catch((err) => {
      console.error('File clear error:', err);
      res.status(500).json({ error: 'Failed to clear log file' });
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload Too Large' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  if (err.message === 'Forbidden origin') {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  res.status(500).json({ error: 'Internal Server Error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Telemetry server listening on port ${PORT}`);
  });
}

module.exports = app;
