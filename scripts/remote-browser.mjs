// Run Playwright browsers on the desktop PC instead of this laptop.
//
// On by default when ~/.config/pw-remote/config.json exists; PW_REMOTE=0 forces local browsers.
// The PC runs one `playwright run-server` per Playwright version (they must match exactly), reached
// through an SSH tunnel on 127.0.0.1:<port>. Every connection gets its own fresh browser on the PC,
// and `exposeNetwork: '<loopback>'` lets that browser load this laptop's localhost dev servers.
// If the PC can't be reached, callers get null and fall back to local browsers (with a warning).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = join(homedir(), '.config/pw-remote/config.json');
let cached;

function warn(message) {
  if (!process.env.TEST_WORKER_INDEX) console.warn(`[pw-remote] ${message}`);
}

function playwrightVersion() {
  const require = createRequire(import.meta.url);
  return require('playwright-core/package.json').version;
}

// Any HTTP answer means the run-server is reachable; 000 means no tunnel or nothing behind it.
function serverUp(port, path) {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '3', '-w', '%{http_code}', `http://127.0.0.1:${port}${path}`], { encoding: 'utf8' });
  return r.stdout !== '000' && r.stdout !== '';
}

function tunnelListening(port) {
  return spawnSync('nc', ['-z', '-G', '2', '127.0.0.1', String(port)]).status === 0;
}

function waitFor(check, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (check()) return true;
    spawnSync('sleep', ['0.5']);
  }
  return check();
}

function connect({ host, path, port }) {
  if (serverUp(port, path)) return true;
  if (!tunnelListening(port)) {
    spawnSync('ssh', ['-f', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=30',
      '-L', `${port}:127.0.0.1:${port}`, host], { stdio: 'ignore', timeout: 15_000 });
    if (waitFor(() => serverUp(port, path), 3)) return true;
  }
  // Tunnel is up but nothing answers: (re)start the PC's launchers.
  spawnSync('ssh', ['-o', 'ConnectTimeout=5', host, 'schtasks /run /tn pw-remote-servers'], { stdio: 'ignore', timeout: 15_000 });
  return waitFor(() => serverUp(port, path), 15);
}

/**
 * Returns `{ wsEndpoint, exposeNetwork }` for a browser on the PC, or null to use a local browser.
 * `launchOptions` (headless, args, ...) travel in the endpoint URL; channel 'chromium' is forced because
 * the default headless shell renders WebGL in software, while full Chromium uses the PC's GPU.
 */
export function remoteBrowser(launchOptions = {}) {
  if (process.env.PW_REMOTE === '0') return null;
  if (cached === undefined) {
    cached = null;
    let config;
    try { config = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return null; }
    const version = playwrightVersion();
    const port = config.ports?.[version];
    if (!port) {
      warn(`PC has no launcher for Playwright ${version} (has ${Object.keys(config.ports ?? {}).join(', ')}); using local browsers.`);
    } else if (!connect({ host: config.host, path: config.path, port })) {
      warn(`couldn't reach the PC launcher (${config.host}, port ${port}); using local browsers.`);
    } else {
      warn(`browsers run on ${config.host} (Playwright ${version}). PW_REMOTE=0 to run locally.`);
      cached = { base: `ws://127.0.0.1:${port}${config.path}` };
    }
  }
  if (!cached) return null;
  const options = { headless: true, ...launchOptions, channel: 'chromium' };
  return {
    wsEndpoint: `${cached.base}?launch-options=${encodeURIComponent(JSON.stringify(options))}`,
    exposeNetwork: '<loopback>',
  };
}
