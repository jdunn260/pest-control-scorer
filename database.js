const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'calls.json');

function read() {
  if (!fs.existsSync(DB_FILE)) return { calls: [], nextId: 1 };
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { calls: [], nextId: 1 };
  }
}

function write(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const db = {
  insertCall(rep_name, disposition) {
    const data = read();
    const id = data.nextId;
    data.calls.push({
      id,
      rep_name,
      disposition,
      created_at: new Date().toISOString(),
      transcript: null,
      score: null,
      scorecard: null,
      status: 'uploading',
      error: null
    });
    data.nextId = id + 1;
    write(data);
    return id;
  },

  updateCall(id, fields) {
    const data = read();
    const idx = data.calls.findIndex(c => c.id === id);
    if (idx === -1) return;
    data.calls[idx] = { ...data.calls[idx], ...fields };
    write(data);
  },

  getCall(id) {
    const data = read();
    return data.calls.find(c => c.id === id) || null;
  },

  getAllCalls() {
    const data = read();
    return [...data.calls].reverse();
  }
};

module.exports = db;
