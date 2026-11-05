import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime';
import { createLocalCertificates, type CertificateResult } from '../src/tls/certificates';
import { PASSWORDS, setupTestApp, USERNAMES } from './helpers';

let dir: string;
let certs: CertificateResult;
let server: https.Server;
let port: number;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-tls-'));
  certs = await createLocalCertificates({ ips: ['127.0.0.1'], outDir: dir });
  const ctx = setupTestApp(); // cookieSecure 'auto' → Secure over HTTPS
  server = https.createServer({ cert: fs.readFileSync(certs.certFile), key: fs.readFileSync(certs.keyFile) }, ctx.app);
  const rt = attachRealtime(server, ctx.events, ctx.auth, { corsOrigins: [] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  close = async () => {
    await rt.close();
    ctx.sqlite.close();
  };
}, 60_000);

afterAll(async () => {
  await close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(pathName: string, opts: https.RequestOptions = {}, body?: unknown): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: pathName, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...opts },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('HTTPS with the locally generated certificate', () => {
  it('does not write the CA private key anywhere', () => {
    expect(fs.readdirSync(dir).sort()).toEqual(['restaurant-pos-ca.crt', 'server.crt', 'server.key']);
    expect(fs.readFileSync(certs.caCertFile, 'utf8')).not.toMatch(/PRIVATE KEY/);
  });

  it('is trusted by a client that trusts the CA', async () => {
    const res = await get('/api/health', { ca: fs.readFileSync(certs.caCertFile) });
    expect(res.status).toBe(200);
  });

  it('is rejected by a client that does not trust the CA', async () => {
    await expect(get('/api/health')).rejects.toThrow(/self-signed|unable to verify|certificate/i);
  });

  it('is only valid for the addresses it was made for', async () => {
    const other = await createLocalCertificates({ ips: ['192.168.1.20'], hostnames: ['reception-pc'], outDir: path.join(dir, 'other') });
    const leaf = new X509Certificate(fs.readFileSync(other.certFile, 'utf8').split(/(?=-----BEGIN CERTIFICATE-----)/)[0]);
    expect(leaf.checkIP('192.168.1.20')).toBe('192.168.1.20');
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(leaf.checkHost('reception-pc')).toBe('reception-pc');
    expect(leaf.checkIP('192.168.1.21')).toBeUndefined(); // another PC's address
    expect(leaf.checkHost('example.com')).toBeUndefined();
    expect(leaf.ca).toBe(false);
    expect(new X509Certificate(fs.readFileSync(other.caCertFile)).ca).toBe(true);
    await expect(createLocalCertificates({ ips: ['not-an-ip'], outDir: path.join(dir, 'bad') })).rejects.toThrow(/Not an IPv4 address/);
  }, 60_000);

  it('marks the session cookie Secure over HTTPS', async () => {
    const res = await get('/api/auth/login', { ca: fs.readFileSync(certs.caCertFile) }, { username: USERNAMES.KITCHEN, password: PASSWORDS.KITCHEN });
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as string[])[0];
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('carries live updates over secure WebSockets (wss)', async () => {
    const login = await get('/api/auth/login', { ca: fs.readFileSync(certs.caCertFile) }, { username: USERNAMES.KITCHEN, password: PASSWORDS.KITCHEN });
    const cookie = (login.headers['set-cookie'] as string[])[0].split(';')[0];
    const s = connect(`https://127.0.0.1:${port}`, { transports: ['websocket'], ca: fs.readFileSync(certs.caCertFile, 'utf8'), extraHeaders: { Cookie: cookie }, reconnection: false });
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    expect(s.io.engine.transport.name).toBe('websocket');
    s.disconnect();
  });
});
