const filesListEl = document.getElementById('filesList');
const consoleEl = document.getElementById('consoleOutput');
const fileInput = document.getElementById('fileInput');
const refreshBtn = document.getElementById('refreshBtn');
const tokenInput = document.getElementById('token');

const socket = io(); // default

async function reloadFiles() {
  filesListEl.innerHTML = 'Loading...';
  try {
    const res = await fetch('/api/files');
    const list = await res.json();
    if (!list.length) return filesListEl.innerHTML = '<div class="smallmuted">No files uploaded.</div>';
    filesListEl.innerHTML = '';
    list.forEach(f => {
      const el = document.createElement('div');
      el.className = 'file-card';
      const info = document.createElement('div');
      info.className = 'file-info';
      const date = new Date(f.mtime).toLocaleString();
      info.innerHTML = `<strong>${f.name}</strong><div class="smallmuted">${(f.size/1024).toFixed(2)} KB • ${date}</div>`;
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const runBtn = document.createElement('button'); runBtn.textContent = 'Run';
      const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
      runBtn.onclick = () => runFile(f.name);
      delBtn.onclick = () => deleteFile(f.name);
      actions.appendChild(runBtn); actions.appendChild(delBtn);
      el.appendChild(info); el.appendChild(actions);
      filesListEl.appendChild(el);
    });
  } catch (e) {
    filesListEl.innerHTML = 'Failed to load files: ' + e.message;
  }
}

fileInput.addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const form = new FormData();
  form.append('file', f);
  consoleEl.textContent = `Uploading ${f.name} (${(f.size/1024/1024).toFixed(2)} MB)...`;
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const j = await res.json();
    if (j.ok) {
      consoleEl.textContent = `Uploaded: ${j.filename}\n`;
      reloadFiles();
    } else {
      consoleEl.textContent = 'Upload failed: ' + JSON.stringify(j);
    }
  } catch (err) {
    consoleEl.textContent = 'Upload error: ' + err.message;
  } finally {
    fileInput.value = '';
  }
});

refreshBtn.addEventListener('click', reloadFiles);

// delete
async function deleteFile(filename) {
  const token = tokenInput.value || '';
  if (!token) return alert('Provide ADMIN TOKEN to delete');
  if (!confirm('Delete ' + filename + '?')) return;
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filename, token })
    });
    const j = await res.json();
    if (j.ok) {
      consoleEl.textContent = `Deleted ${filename}\n`;
      reloadFiles();
    } else {
      consoleEl.textContent = 'Delete failed: ' + JSON.stringify(j);
    }
  } catch (e) {
    consoleEl.textContent = 'Delete error: ' + e.message;
  }
}

// run file (creates runId then joins socket room to stream logs)
async function runFile(filename) {
  const token = tokenInput.value || '';
  if (!token) return alert('Provide ADMIN TOKEN to run');
  consoleEl.textContent = `Requesting run for ${filename}...\n`;
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filename, timeoutSeconds: 60, token })
    });
    const j = await res.json();
    if (!j.ok) {
      consoleEl.textContent += 'Run request failed: ' + JSON.stringify(j);
      return;
    }
    const runId = j.runId;
    consoleEl.textContent += `Run started (id: ${runId}). Streaming logs...\n\n`;

    // join socket room
    socket.emit('join', { runId });

    socket.off('run:stdout'); socket.off('run:stderr'); socket.off('run:exit'); socket.off('run:error');

    socket.on('run:stdout', data => {
      if (data.runId !== runId) return;
      consoleEl.textContent += data.chunk;
      consoleEl.scrollTop = consoleEl.scrollHeight;
    });
    socket.on('run:stderr', data => {
      if (data.runId !== runId) return;
      consoleEl.textContent += data.chunk;
      consoleEl.scrollTop = consoleEl.scrollHeight;
    });
    socket.on('run:exit', data => {
      if (data.runId !== runId) return;
      consoleEl.textContent += `\n\nProcess exited. code=${data.code} signal=${data.signal}\n`;
      consoleEl.scrollTop = consoleEl.scrollHeight;
    });
    socket.on('run:error', data => {
      if (data.runId !== runId) return;
      consoleEl.textContent += `\n\nRun error: ${data.error}\n`;
      consoleEl.scrollTop = consoleEl.scrollHeight;
    });

  } catch (e) {
    consoleEl.textContent += 'Run request error: ' + e.message;
  }
}

// initial load
reloadFiles();