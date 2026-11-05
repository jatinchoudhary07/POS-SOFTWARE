import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { diningTables, menuItems, orders } from '../src/db/schema';
import { requestId, setupTestApp } from './helpers';

describe('Table Management (Settings & Lifecycle)', () => {
  it('creates tables with unique names, optional capacity, and default active status', async () => {
    const ctx = setupTestApp();

    const res = await ctx.api
      .post('/api/tables')
      .send({ name: 'T1', capacity: 4 })
      .expect(201);

    expect(res.body.table).toMatchObject({
      name: 'T1',
      capacity: 4,
      isActive: true,
    });
    expect(res.body.table.id).toBeDefined();

    // Verify in database
    const inDb = ctx.db.select().from(diningTables).where(eq(diningTables.id, res.body.table.id)).get();
    expect(inDb?.name).toBe('T1');
    expect(inDb?.capacity).toBe(4);
    expect(inDb?.isActive).toBe(true);
  });

  it('rejects duplicate active table names (case-insensitive and trimmed)', async () => {
    const ctx = setupTestApp();

    await ctx.api.post('/api/tables').send({ name: 'Patio 1' }).expect(201);

    // Exact duplicate
    const dupRes = await ctx.api.post('/api/tables').send({ name: 'Patio 1' }).expect(400);
    expect(dupRes.body.error.code).toBe('DUPLICATE_TABLE_NAME');

    // Case-insensitive duplicate
    const caseDup = await ctx.api.post('/api/tables').send({ name: '  patio 1  ' }).expect(400);
    expect(caseDup.body.error.code).toBe('DUPLICATE_TABLE_NAME');
  });

  it('rejects invalid table names (empty or too long)', async () => {
    const ctx = setupTestApp();

    await ctx.api.post('/api/tables').send({ name: '' }).expect(400);
    await ctx.api.post('/api/tables').send({ name: '   ' }).expect(400);
    await ctx.api.post('/api/tables').send({ name: 'A'.repeat(51) }).expect(400);
  });

  it('renames a table and prevents collision with existing active table names', async () => {
    const ctx = setupTestApp();

    const t1 = (await ctx.api.post('/api/tables').send({ name: 'Table 1' })).body.table;
    const t2 = (await ctx.api.post('/api/tables').send({ name: 'Table 2' })).body.table;

    // Renaming to Table 2 is rejected
    await ctx.api.patch(`/api/tables/${t1.id}`).send({ name: 'table 2' }).expect(400);

    // Renaming to new unique name succeeds
    const updated = (await ctx.api.patch(`/api/tables/${t1.id}`).send({ name: 'Table 10', capacity: 6 }).expect(200)).body.table;
    expect(updated.name).toBe('Table 10');
    expect(updated.capacity).toBe(6);
  });

  it('preserves historical orders when a table is renamed or deactivated', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;

    // Create table and take an order
    const table = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const order = (
      await ctx.api
        .post('/api/orders')
        .send({
          clientRequestId: requestId(),
          orderType: 'DINE_IN',
          tableId: table.id,
          tableNumber: table.name,
          items: [{ menuItemId: tikka, quantity: 2 }],
        })
        .expect(201)
    ).body.order;

    expect(order.tableId).toBe(table.id);
    expect(order.tableNumber).toBe('T1');

    // Settle order so table can be deactivated
    await ctx.api.post(`/api/orders/${order.id}/bill`).send({});
    await ctx.api.post(`/api/orders/${order.id}/payments`).send({
      method: 'CASH',
      idempotencyKey: requestId(),
      expectedTotalPaise: 48000,
      tenderedPaise: 50000,
    });

    // Rename table
    await ctx.api.patch(`/api/tables/${table.id}`).send({ name: 'T1-Renamed' }).expect(200);

    // Order still exists and retains tableId and tableNumber
    const orderAfterRename = (await ctx.api.get(`/api/orders/${order.id}`).expect(200)).body.order;
    expect(orderAfterRename.tableId).toBe(table.id);
    expect(orderAfterRename.tableNumber).toBe('T1');

    // Deactivate table
    await ctx.api.patch(`/api/tables/${table.id}`).send({ isActive: false }).expect(200);

    // Order still exists and is untouched
    const orderAfterDeact = (await ctx.api.get(`/api/orders/${order.id}`).expect(200)).body.order;
    expect(orderAfterDeact.tableId).toBe(table.id);
    expect(orderAfterDeact.id).toBe(order.id);
  });

  it('prevents deactivation of table with active unsettled orders unless force=true', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;

    const table = (await ctx.api.post('/api/tables').send({ name: 'T3' })).body.table;

    // Place unsettled order
    await ctx.api.post('/api/orders').send({
      clientRequestId: requestId(),
      orderType: 'DINE_IN',
      tableId: table.id,
      items: [{ menuItemId: tikka, quantity: 1 }],
    });

    // Attempting normal deactivation returns 409
    const blocked = await ctx.api.patch(`/api/tables/${table.id}`).send({ isActive: false }).expect(409);
    expect(blocked.body.error.code).toBe('TABLE_HAS_UNSETTLED_ORDERS');

    // Force deactivation with explicit confirm succeeds
    const forced = await ctx.api.patch(`/api/tables/${table.id}`).send({ isActive: false, force: true }).expect(200);
    expect(forced.body.table.isActive).toBe(false);
  });

  it('enforces role permissions: only Superadmin can create/modify tables; Reception can view overview', async () => {
    const ctx = setupTestApp();

    // Anonymous receives 401
    await ctx.anon.get('/api/tables').expect(401);
    await ctx.anon.post('/api/tables').send({ name: 'T4' }).expect(401);

    // Kitchen receives 403 on tables management
    await ctx.as('KITCHEN').get('/api/tables').expect(403);
    await ctx.as('KITCHEN').post('/api/tables').send({ name: 'T4' }).expect(403);

    // Reception can read tables overview/tiles
    await ctx.as('RECEPTION').get('/api/tables/overview').expect(200);
    // Reception cannot create or modify tables
    await ctx.as('RECEPTION').post('/api/tables').send({ name: 'T4' }).expect(403);

    // Superadmin can create tables
    await ctx.as('SUPERADMIN').post('/api/tables').send({ name: 'T4' }).expect(201);
  });
});
