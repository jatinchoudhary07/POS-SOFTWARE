import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, defaultStaticDir } from '../src/app';
import { openDatabase, runMigrations } from '../src/db/client';
import { diningTables, menuItems, orders } from '../src/db/schema';
import { seed } from '../src/db/seed';
import { EventBus } from '../src/events';
import { PASSWORDS, requestId, setupTestApp, USERNAMES } from './helpers';
import { sampleMenu } from './fixtures/sampleMenu';

describe('Unified Single-Origin Hosting Deployment & SPA Integration', () => {
  it('serves the built frontend static assets and SPA routes on the same origin', async () => {
    const { db } = openDatabase(':memory:');
    runMigrations(db);
    seed(db, { menu: sampleMenu });
    const { app } = createApp({ db, staticDir: defaultStaticDir });

    // Root loads index.html
    const rootRes = await request(app).get('/').expect(200);
    expect(rootRes.headers['content-type']).toMatch(/text\/html/);
    expect(rootRes.text).toContain('<div id="root"></div>');

    // Deep SPA routes (/tables, /kitchen, /orders, /sales, /settings, /login, /pos) serve index.html
    for (const route of ['/tables', '/kitchen', '/orders', '/sales', '/settings', '/login', '/pos']) {
      const res = await request(app).get(route).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('<div id="root"></div>');
    }

    // Nested dynamic SPA routes (/checkout/1, /checkout/table/2) serve index.html
    const checkoutRes = await request(app).get('/checkout/1').expect(200);
    expect(checkoutRes.headers['content-type']).toMatch(/text\/html/);
    expect(checkoutRes.text).toContain('<div id="root"></div>');

    const tableCheckoutRes = await request(app).get('/checkout/table/2').expect(200);
    expect(tableCheckoutRes.headers['content-type']).toMatch(/text\/html/);
    expect(tableCheckoutRes.text).toContain('<div id="root"></div>');
  });

  it('ensures unknown API routes return JSON 404 and missing static assets return 404 (not HTML)', async () => {
    const { db } = openDatabase(':memory:');
    runMigrations(db);
    seed(db, { menu: sampleMenu });
    const { app } = createApp({ db, staticDir: defaultStaticDir });

    // Unknown API routes return proper JSON 404
    const apiRes = await request(app).get('/api/does-not-exist').expect(404);
    expect(apiRes.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Unknown API route' },
    });

    // Missing file assets with extensions return 404 (never HTML)
    await request(app).get('/assets/non-existent.js').expect(404);
    await request(app).get('/favicon.ico').expect(404);
  });

  it('allows same-origin table creation and order creation without BAD_ORIGIN errors', async () => {
    const ctx = setupTestApp();

    // 1. Superadmin creates a table via same-origin request
    const createRes = await ctx.api
      .post('/api/tables')
      .set('Host', 'pos.example.com')
      .set('Origin', 'https://pos.example.com')
      .send({ name: 'Terrace 1', capacity: 6 })
      .expect(201);

    expect(createRes.body.table.name).toBe('Terrace 1');
    const tableId = createRes.body.table.id as number;

    // 2. Reception lists tables and creates order for that table
    const reception = ctx.as('RECEPTION');
    const listRes = await reception
      .get('/api/tables')
      .set('Host', 'pos.example.com')
      .expect(200);
    expect(listRes.body.tables).toContain('Terrace 1');

    const tikkaItem = ctx.db.select().from(menuItems).all().find((i) => i.name === 'Paneer Tikka')
      ?? ctx.db.select().from(menuItems).all()[0];
    const tikka = tikkaItem.id;

    const orderRes = await reception
      .post('/api/orders')
      .set('Host', 'pos.example.com')
      .set('Origin', 'https://pos.example.com')
      .send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId,
        tableNumber: 'Terrace 1',
        items: [{ menuItemId: tikka, quantity: 2 }],
      })
      .expect(201);

    expect(orderRes.body.order.tableId).toBe(tableId);
    expect(orderRes.body.order.tableNumber).toBe('Terrace 1');

    // 3. Table overview reflects the occupied status and running total
    const overviewRes = await reception
      .get('/api/tables/overview')
      .set('Host', 'pos.example.com')
      .expect(200);

    const tile = overviewRes.body.tables.find((t: { id: number }) => t.id === tableId);
    expect(tile).toBeDefined();
    expect(tile.status).toBe('OCCUPIED');
    expect(tile.activeOrderCount).toBe(1);
    expect(tile.runningTotalPaise).toBe(orderRes.body.order.subtotalPaise);
  });

  it('supports reverse proxy headers when trustProxy is enabled', async () => {
    const ctx = setupTestApp({
      trustProxy: true,
      cookieSecure: 'auto',
    });

    // Behind a reverse proxy (e.g. Render / Cloudflare / Nginx) that terminates TLS:
    // X-Forwarded-Proto: https -> req.secure is true -> cookie gets Secure flag
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .set('Host', 'pos.example.com')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'pos.example.com')
      .send({ username: USERNAMES.SUPERADMIN, password: PASSWORDS.SUPERADMIN })
      .expect(200);

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('rejects foreign website origin while permitting legitimate same-origin requests', async () => {
    const ctx = setupTestApp();

    // Foreign origin is blocked with BAD_ORIGIN
    const blockedRes = await ctx.api
      .post('/api/tables')
      .set('Host', 'pos.example.com')
      .set('Origin', 'https://malicious-website.com')
      .send({ name: 'Hacked Table' })
      .expect(403);

    expect(blockedRes.body.error.code).toBe('BAD_ORIGIN');
    expect(blockedRes.body.error.message).toContain('Request from another website was blocked');

    // Legitimate same-origin request is allowed
    const allowedRes = await ctx.api
      .post('/api/tables')
      .set('Host', 'pos.example.com')
      .set('Origin', 'https://pos.example.com')
      .send({ name: 'Safe Table' })
      .expect(201);

    expect(allowedRes.body.table.name).toBe('Safe Table');
  });
});
