// Required by @peculiar/x509 (its dependency-injection container needs Reflect metadata).
import 'reflect-metadata';
import { randomBytes, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as x509 from '@peculiar/x509';

/**
 * HTTPS for a private LAN without buying a certificate:
 *   1. create a small certificate authority ("Restaurant POS Local CA")
 *   2. use it to sign ONE server certificate for the reception PC's LAN address(es)
 *   3. throw the CA's private key away — it is never written to disk
 * Both PCs then trust the CA certificate (installed once). Because the CA key no longer exists, nobody
 * can use that trusted CA to issue certificates for other websites. The trade-off: if the reception
 * PC's IP address changes, run the setup again and install the new CA certificate on both PCs.
 */
export interface CertificateResult {
  dir: string;
  caCertFile: string;
  certFile: string;
  keyFile: string;
  validUntil: Date;
  sans: string[];
}

const SERVER_VALID_DAYS = 825;
const crypto = webcrypto as unknown as Crypto;
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };

/** Positive, random 16-byte serial number (hex). */
const serial = () => '01' + randomBytes(15).toString('hex');

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

export async function createLocalCertificates(opts: { ips: string[]; hostnames?: string[]; outDir: string; now?: Date }): Promise<CertificateResult> {
  const ips = [...new Set(opts.ips)];
  for (const ip of ips) if (!net.isIPv4(ip)) throw new Error(`Not an IPv4 address: ${ip}`);
  if (!ips.length) throw new Error('Give at least one LAN IP address of the reception PC');
  const hostnames = [...new Set(['localhost', ...(opts.hostnames ?? [])])];
  for (const h of hostnames) if (!/^[A-Za-z0-9.-]{1,253}$/.test(h)) throw new Error(`Not a valid host name: ${h}`);
  const allIps = [...new Set([...ips, '127.0.0.1'])];
  const now = opts.now ?? new Date();
  const notBefore = new Date(now.getTime() - 60_000);

  // --- CA (private key stays in memory only) ---
  const caKeys = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const caName = `CN=Restaurant POS Local CA (${ips[0]}), O=Restaurant POS (this restaurant only)`;
  const ca = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: serial(),
      name: caName,
      notBefore,
      notAfter: new Date(now.getTime() + (SERVER_VALID_DAYS + 30) * 86_400_000),
      signingAlgorithm: ALG,
      keys: caKeys,
      extensions: [
        // pathLength 0: can only sign end-entity certificates.
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey, false, crypto),
      ],
    },
    crypto,
  );

  // --- Server certificate for the LAN address(es) ---
  const keys = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const notAfter = new Date(now.getTime() + SERVER_VALID_DAYS * 86_400_000);
  const cert = await x509.X509CertificateGenerator.create(
    {
      serialNumber: serial(),
      subject: `CN=${ips[0]}`,
      issuer: ca.subject,
      notBefore,
      notAfter,
      signingAlgorithm: ALG,
      publicKey: keys.publicKey,
      signingKey: caKeys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([
          ...hostnames.map((value) => ({ type: 'dns' as const, value })),
          ...allIps.map((value) => ({ type: 'ip' as const, value })),
        ]),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false, crypto),
        await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey, false, crypto),
      ],
    },
    crypto,
  );

  fs.mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
  const caCertFile = path.join(opts.outDir, 'restaurant-pos-ca.crt');
  const certFile = path.join(opts.outDir, 'server.crt');
  const keyFile = path.join(opts.outDir, 'server.key');
  fs.writeFileSync(caCertFile, ca.toString('pem') + '\n');
  // The server presents its certificate followed by the CA (full chain).
  fs.writeFileSync(certFile, cert.toString('pem') + '\n' + ca.toString('pem') + '\n');
  fs.writeFileSync(keyFile, pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', keys.privateKey)), { mode: 0o600 });

  return { dir: opts.outDir, caCertFile, certFile, keyFile, validUntil: notAfter, sans: [...hostnames, ...allIps] };
}
