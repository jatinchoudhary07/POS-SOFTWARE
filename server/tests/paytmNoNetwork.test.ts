import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stage 1 promise: nothing in the terminal-payment code can reach the network, and no real credential exists anywhere.
 * If a later stage adds a real client it must change these tests on purpose, with approval.
 */
const dir = path.resolve(__dirname, '../src/payments/paytm');
const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => ({ f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Stage 1 safety: no real Paytm connection', () => {
  it('has the mock client and no other client', () => {
    expect(sources.map((s) => s.f).sort()).toEqual(['codes.ts', 'mock.ts', 'service.ts', 'setup.ts', 'stateMachine.ts', 'types.ts']);
  });

  it('imports no network module and makes no network call', () => {
    for (const { f, text } of sources) {
      const c = code(text);
      expect(c, f).not.toMatch(/from\s+['"]node:(http|https|http2|net|tls|dns|dgram|child_process)['"]/);
      expect(c, f).not.toMatch(/from\s+['"](axios|undici|node-fetch|got|superagent|ws|socket\.io-client)['"]/);
      expect(c, f).not.toMatch(/\bfetch\s*\(/);
      expect(c, f).not.toMatch(/XMLHttpRequest|WebSocket\s*\(/);
    }
  });

  it('contains no Paytm address or credential', () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/paytmpayments\.(com|in)|securegw|securestage|paytm\.in|paytm\.com|https?:\/\//i);
      expect(code(text), f).not.toMatch(/MERCHANT_KEY|merchantKey|PAYTM_MID|PAYTM_TID|CHANNEL_ID/);
    }
  });

  it('defines no credential setting, and leaves the feature off by default', () => {
    const config = fs.readFileSync(path.resolve(__dirname, '../src/config.ts'), 'utf8');
    expect(config).not.toMatch(/PAYTM_(MID|TID|CHANNEL_ID|MERCHANT_KEY|BASE_URL)/);
    expect(config).toMatch(/PAYTM_ENABLED: z\.enum\(\['true', 'false'\]\)\.default\('false'\)/);
    const example = fs.readFileSync(path.resolve(__dirname, '../.env.example'), 'utf8');
    expect(example).toMatch(/^PAYTM_ENABLED=false$/m);
    expect(example).not.toMatch(/PAYTM_(MID|TID|CHANNEL_ID|MERCHANT_KEY)\s*=\s*\S/);
  });

  it('has no checksum implementation (the algorithm is unconfirmed, so it is not guessed)', () => {
    for (const { f, text } of sources) {
      expect(code(text), f).not.toMatch(/createHmac|createHash|createCipheriv|createSign|crypto\.subtle/);
    }
  });
});
