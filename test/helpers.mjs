// Test plumbing. Every instance gets its own temp directory holding a config.json and
// the SQLite file it names, so tests never touch the checkout's habits.db.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER = join(ROOT, 'server.mjs');
export const TOKEN = 'test-token-0123456789';

export function tempConfig(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-test-'));
  const path = join(dir, 'config.json');
  // port 0 -> the OS picks a free one, so parallel test files never collide.
  writeFileSync(path, JSON.stringify({ port: 0, token: TOKEN, lang: 'ja', db: 'habits.db', ...extra }));
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Imports server.mjs against a throwaway config. KUSA_CONFIG has to be set before the
// import, since the module reads it at evaluation time.
export async function loadServer(extra) {
  const cfg = tempConfig(extra);
  process.env.KUSA_CONFIG = cfg.path;
  return { ...cfg, mod: await import(SERVER) };
}

// Boots the real server as a child process and waits for the port it actually bound.
export async function startServer(extra) {
  const cfg = tempConfig(extra);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, KUSA_CONFIG: cfg.path },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 10s; stderr:\n' + stderr)), 10000);
    let out = '';
    child.stdout.on('data', c => {
      out += c;
      const m = out.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited with ' + code + '; stderr:\n' + stderr)); });
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    url: (p, keyed = true) => base + p + (keyed ? (p.includes('?') ? '&' : '?') + 'key=' + TOKEN : ''),
    post: (p, bodyObj) => fetch(base + p + '?key=' + TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    }),
    stop: async () => {
      child.kill();
      await new Promise(r => child.on('exit', r));
      cfg.cleanup();
    }
  };
}

// Wipes both tables so each test starts from a known board.
export function reset(db) {
  db.exec('DELETE FROM checkins; DELETE FROM habits;');
}

// Inserts a habit and its check-ins. `mode` is 'daily' | 'any' | 'all'.
export function addHabit(db, { name, mode = 'daily', days = [], checked = [], skipped = [] }) {
  const anyDays = mode === 'any' ? JSON.stringify(days) : null;
  const allDays = mode === 'all' ? JSON.stringify(days) : null;
  const id = Number(db.prepare('INSERT INTO habits (name, emoji, any_days, all_days) VALUES (?,?,?,?)')
    .run(name, '', anyDays, allDays).lastInsertRowid);
  const chk = db.prepare('INSERT INTO checkins (habit_id, date, skip) VALUES (?,?,?)');
  for (const d of checked) chk.run(id, d, 0);
  for (const d of skipped) chk.run(id, d, 1);
  return id;
}

// A date `n` days before `from`, as YYYY-MM-DD. For tests that must be relative to the
// real today (anything reaching code that calls today() itself).
export function daysBefore(from, n) {
  const d = new Date(from + 'T12:00:00');
  d.setDate(d.getDate() - n);
  const m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}
