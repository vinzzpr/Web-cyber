/**
 * server.js
 * - Express backend
 * - Uploads large files (up to 500MB per file)
 * - List, delete, and run files inside Docker sandbox
 * - Real-time streaming of logs to connected clients via Socket.IO
 *
 * IMPORTANT:
 * - Set ADMIN_TOKEN in environment before exposing publicly.
 * - Requires Docker installed and user allowed to run docker.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Server } = require('socket.io');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Basic middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ADMIN token protection
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme_localtoken';
if (ADMIN_TOKEN === 'changeme_localtoken') {
  console.warn('WARNING: ADMIN_TOKEN is default. Set process.env.ADMIN_TOKEN to a strong value before exposing this service.');
}

// Multer configuration: allow up to 500MB per file
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]/g, '_');
      cb(null, `${Date.now()}_${uuidv4()}_${safe}`);
    }
  }),
  limits: {
    fileSize: 500 * 1024 * 1024 // 500 MB
  }
});

// Helper: list files
function listUploads() {
  return fs.readdirSync(UPLOAD_DIR).map(fname => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, fname));
    return {
      name: fname,
      size: stat.size,
      mtime: stat.mtimeMs
    };
  }).sort((a,b) => b.mtime - a.mtime);
}

// Routes
app.get('/api/files', (req, res) => {
  res.json(listUploads());
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  // make executable where appropriate
  try { fs.chmodSync(path.join(UPLOAD_DIR, req.file.filename), 0o755); } catch(e){}
  res.json({ ok: true, filename: req.file.filename });
});

app.post('/api/delete', (req, res) => {
  const token = req.headers['x-admin-token'] || req.body.token;
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const p = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'delete failed', detail: e.message });
  }
});

// Run a script inside Docker and stream logs to socket room named by runId
app.post('/api/run', (req, res) => {
  const token = req.headers['x-admin-token'] || req.body.token;
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });

  const { filename, timeoutSeconds = 30 } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const safeName = filename;
  if (safeName.includes('..') || safeName.length > 300) return res.status(400).json({ error: 'invalid filename' });

  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });

  // Determine image and run command by extension
  const ext = path.extname(safeName).toLowerCase();
  let image = 'alpine:3.18';
  let execCmd = `./${safeName}`;
  if (ext === '.py') { image = 'python:3.11-slim'; execCmd = `python "${safeName}"`; }
  if (ext === '.js') { image = 'node:18-slim'; execCmd = `node "${safeName}"`; }
  if (ext === '.sh') { image = 'alpine:3.18'; execCmd = `sh "${safeName}"`; }
  if (ext === '.pl') { image = 'perl:5.36'; execCmd = `perl "${safeName}"`; }

  // create unique run id for socket room
  const runId = uuidv4();

  // Prepare docker command array
  const dockerArgs = [
    'run', '--rm',
    '--read-only',
    '--network', 'none',
    '--memory', '400m',
    '--cpus', '0.5',
    '--user', '65534:65534',
    '-v', `${UPLOAD_DIR}:/srv/uploads:ro`,
    '-w', '/srv/uploads',
    image,
    'sh', '-c', `chmod +x "${safeName}" || true; ${execCmd}`
  ];

  // spawn docker
  const docker = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  // emit start event to room
  io.to(runId).emit('run:start', { runId, filename: safeName, startedAt: Date.now() });

  // stream stdout/stderr
  docker.stdout.on('data', chunk => {
    io.to(runId).emit('run:stdout', { runId, chunk: chunk.toString() });
  });
  docker.stderr.on('data', chunk => {
    io.to(runId).emit('run:stderr', { runId, chunk: chunk.toString() });
  });

  // handle finish
  const timeoutMs = Math.min(Math.max(parseInt(timeoutSeconds) || 30, 1), 300) * 1000;
  const timer = setTimeout(() => {
    try { docker.kill('SIGKILL'); } catch(e) {}
  }, timeoutMs);

  docker.on('exit', (code, signal) => {
    clearTimeout(timer);
    io.to(runId).emit('run:exit', { runId, code, signal, finishedAt: Date.now() });
  });

  docker.on('error', (err) => {
    clearTimeout(timer);
    io.to(runId).emit('run:error', { runId, error: err.message });
  });

  // return runId to client so they can join the socket room
  res.json({ ok: true, runId });
});

// Serve UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO connection handling
io.on('connection', socket => {
  // client should join room corresponding to runId to receive logs
  socket.on('join', (data) => {
    if (data && data.runId) {
      socket.join(data.runId);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Script panel running at http://localhost:${PORT}`);
});