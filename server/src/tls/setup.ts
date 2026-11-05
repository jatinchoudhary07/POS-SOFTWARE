/**
 * Optional HTTPS for the local network. On the reception PC:
 *
 *   npm run tls:setup -- 192.168.1.20            (the reception PC's fixed LAN address)
 *
 * Creates, in C:\Users\<you>\RestaurantPOS\tls (or TLS_DIR):
 *   restaurant-pos-ca.crt  install this on BOTH PCs as a trusted root (see the setup guide)
 *   server.crt, server.key used by the server (keep server.key private)
 * Then add the two printed lines to server/.env and restart the server.
 */
import os from 'node:os';
import path from 'node:path';
import { createLocalCertificates } from './certificates';

const args = process.argv.slice(2);
const ips = args.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
const hostnames = args.filter((a) => !/^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('-'));
if (!ips.length) {
  console.error('Usage: npm run tls:setup -- <reception PC LAN IP> [more IPs] [hostname]');
  console.error('Example: npm run tls:setup -- 192.168.1.20');
  process.exit(1);
}
const outDir = process.env.TLS_DIR ? path.resolve(process.env.TLS_DIR) : path.join(os.homedir(), 'RestaurantPOS', 'tls');

try {
  const r = await createLocalCertificates({ ips, hostnames, outDir });
  console.log(`Certificates created in ${r.dir}`);
  console.log(`  Valid for: ${r.sans.join(', ')}  (until ${r.validUntil.toDateString()})`);
  console.log('  The certificate authority key was NOT saved, so it cannot be misused.');
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Add these two lines to server/.env:`);
  console.log(`       TLS_CERT_FILE=${r.certFile}`);
  console.log(`       TLS_KEY_FILE=${r.keyFile}`);
  console.log(`  2. Install ${r.caCertFile} as a trusted root on BOTH PCs (see docs/WINDOWS-SETUP.md).`);
  console.log(`  3. Restart the server and open https://${ips[0]}:<PORT> (kitchen: https://${ips[0]}:<PORT>/kitchen).`);
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
}
