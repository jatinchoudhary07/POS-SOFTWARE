import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { menuItems } from '../src/db/schema';
import { requestId, setupTestApp } from './helpers';

describe('Table Combined Billing & Table Availability Rules', () => {
  it('associates dine-in orders with a stable table ID, while takeaway orders need no table', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;
    const table = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;

    // Dine-in order with tableId
    const dineIn = (
      await ctx.api
        .post('/api/orders')
        .send({
          clientRequestId: requestId(),
          orderType: 'DINE_IN',
          tableId: table.id,
          items: [{ menuItemId: tikka, quantity: 1 }],
        })
        .expect(201)
    ).body.order;

    expect(dineIn.tableId).toBe(table.id);
    expect(dineIn.tableNumber).toBe('T1');

    // Takeaway order without table
    const takeaway = (
      await ctx.api
        .post('/api/orders')
        .send({
          clientRequestId: requestId(),
          orderType: 'TAKEAWAY',
          items: [{ menuItemId: tikka, quantity: 1 }],
        })
        .expect(201)
    ).body.order;

    expect(takeaway.tableId).toBeNull();
    expect(takeaway.tableNumber).toBeNull();
  });

  it('rejects orders referencing inactive or nonexistent table IDs', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;

    const table = (await ctx.api.post('/api/tables').send({ name: 'T2' })).body.table;
    await ctx.api.patch(`/api/tables/${table.id}`).send({ isActive: false }).expect(200);

    // Inactive table
    await ctx.api
      .post('/api/orders')
      .send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: tikka, quantity: 1 }],
      })
      .expect(400);

    // Nonexistent table
    await ctx.api
      .post('/api/orders')
      .send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: 999999,
        items: [{ menuItemId: tikka, quantity: 1 }],
      })
      .expect(400);
  });

  it('supports multiple orders on the same table with server-derived running total and distinct kitchen tickets', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id; // 24000 paise
    const roti = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Tandoori Roti')).get()!.id; // 3000 paise

    const table = (await ctx.api.post('/api/tables').send({ name: 'T3', capacity: 4 })).body.table;

    // Initially AVAILABLE with 0 active orders and ₹0.00
    let overview = (await ctx.api.get('/api/tables/overview')).body.tables;
    let t3Tile = overview.find((t: any) => t.id === table.id);
    expect(t3Tile.status).toBe('AVAILABLE');
    expect(t3Tile.activeOrderCount).toBe(0);
    expect(t3Tile.runningTotalPaise).toBe(0);

    // Place Order 1: 1x Tikka (24000)
    const o1 = (
      await ctx.api
        .post('/api/orders')
        .send({
          clientRequestId: requestId(),
          orderType: 'DINE_IN',
          tableId: table.id,
          items: [{ menuItemId: tikka, quantity: 1 }],
        })
        .expect(201)
    ).body.order;

    // Table is now OCCUPIED with 1 order
    overview = (await ctx.api.get('/api/tables/overview')).body.tables;
    t3Tile = overview.find((t: any) => t.id === table.id);
    expect(t3Tile.status).toBe('OCCUPIED');
    expect(t3Tile.activeOrderCount).toBe(1);
    expect(t3Tile.runningTotalPaise).toBe(24000);

    // Place Order 2: 2x Roti (6000)
    const o2 = (
      await ctx.api
        .post('/api/orders')
        .send({
          clientRequestId: requestId(),
          orderType: 'DINE_IN',
          tableId: table.id,
          items: [{ menuItemId: roti, quantity: 2 }],
        })
        .expect(201)
    ).body.order;

    // The second order is added to the table's running order (one order per table until cleared)
    expect(o2.id).toBe(o1.id);
    expect(o2.items.map((i: any) => [i.itemName, i.quantity])).toEqual([['Paneer Tikka', 1], ['Tandoori Roti', 2]]);

    // Table running total covers everything: 24000 + 6000 = 30000 paise
    overview = (await ctx.api.get('/api/tables/overview')).body.tables;
    t3Tile = overview.find((t: any) => t.id === table.id);
    expect(t3Tile.status).toBe('OCCUPIED');
    expect(t3Tile.activeOrderCount).toBe(1);
    expect(t3Tile.runningTotalPaise).toBe(30000);

    // Kitchen shows ONE ticket for the table (with the table number), and NO prices or payment info
    const kitchenOrders = (await ctx.as('KITCHEN').get('/api/kitchen/orders').expect(200)).body.orders;
    const kTickets = kitchenOrders.filter((k: any) => k.tableNumber === 'T3');
    expect(kTickets.length).toBe(1);
    for (const ticket of kTickets) {
      expect(ticket.tableNumber).toBe('T3');
      expect(ticket.billTotalPaise).toBeUndefined();
      expect(ticket.subtotalPaise).toBeUndefined();
      expect(ticket.paymentStatus).toBeUndefined();
    }

    // Table details endpoint lists the running order
    const details = (await ctx.api.get(`/api/tables/${table.id}`).expect(200)).body;
    expect(details.table.status).toBe('OCCUPIED');
    expect(details.orders.length).toBe(1);
    expect(details.orders.map((o: any) => o.id)).toEqual([o1.id]);
    expect(details.runningTotalPaise).toBe(30000);
  });

  it('combines multiple unpaid orders into a single bill and settles with cash', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id; // 24000
    const roti = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Tandoori Roti')).get()!.id; // 3000

    const table = (await ctx.api.post('/api/tables').send({ name: 'T5' })).body.table;

    // Order 1: 1x Tikka (24000)
    const o1 = (
      await ctx.api.post('/api/orders').send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: tikka, quantity: 1 }],
      })
    ).body.order;

    // Order 2: 2x Roti (6000)
    const o2 = (
      await ctx.api.post('/api/orders').send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: roti, quantity: 2 }],
      })
    ).body.order;

    // Kitchen serves both orders
    await ctx.as('KITCHEN').patch(`/api/orders/${o1.id}/status`).send({ status: 'PREPARING' });
    await ctx.as('KITCHEN').patch(`/api/orders/${o1.id}/status`).send({ status: 'READY' });
    await ctx.as('RECEPTION').patch(`/api/orders/${o1.id}/status`).send({ status: 'COMPLETED' });

    // (o2 was added to o1, so serving o1 serves everything)

    // Everything served, but UNPAID -> table remains OCCUPIED!
    let tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.status).toBe('OCCUPIED');

    // Generate combined table bill with 10% discount (Superadmin)
    const checkout = (
      await ctx.api
        .post(`/api/tables/${table.id}/bill`)
        .send({
          discount: { type: 'PERCENT', bps: 1000, reason: 'Combo promo' },
        })
        .expect(200)
    ).body;

    expect(checkout.bill).toBeDefined();
    expect(checkout.bill.subtotalPaise).toBe(30000);
    expect(checkout.bill.discount.paise).toBe(3000); // 10% of 30000 = 3000
    expect(checkout.bill.totalPaise).toBe(27000);
    expect(checkout.orders.length).toBe(1);

    // Pay the combined bill with Cash
    const payKey = requestId();
    const payRes = await ctx.api
      .post(`/api/tables/${table.id}/payments`)
      .send({
        method: 'CASH',
        idempotencyKey: payKey,
        expectedTotalPaise: 27000,
        tenderedPaise: 30000,
      })
      .expect(201);

    expect(payRes.body.duplicate).toBe(false);
    expect(payRes.body.payment.status).toBe('SUCCEEDED');
    expect(payRes.body.payment.changePaise).toBe(3000);
    expect(payRes.body.checkout.bill.status).toBe('PAID');

    // Idempotent retry returns 200 duplicate: true
    const retryRes = await ctx.api
      .post(`/api/tables/${table.id}/payments`)
      .send({
        method: 'CASH',
        idempotencyKey: payKey,
        expectedTotalPaise: 27000,
        tenderedPaise: 30000,
      })
      .expect(200);
    expect(retryRes.body.duplicate).toBe(true);

    // Paid and served, but the table stays occupied (showing Served + Paid) until staff clear it
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile).toMatchObject({ status: 'OCCUPIED', tableStatus: 'PAID', kitchenStatus: 'COMPLETED', paymentState: 'PAID' });
    await ctx.api.post(`/api/tables/${table.id}/clear`).expect(200);
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.status).toBe('AVAILABLE');
    expect(tile.activeOrderCount).toBe(0);
    expect(tile.runningTotalPaise).toBe(0);
    expect(tile).toMatchObject({ kitchenStatus: null, paymentState: null });

    // Both individual orders are now PAID
    const o1Fresh = (await ctx.api.get(`/api/orders/${o1.id}`)).body.order;
    const o2Fresh = (await ctx.api.get(`/api/orders/${o2.id}`)).body.order;
    expect(o1Fresh.paymentStatus).toBe('PAID');
    expect(o2Fresh.paymentStatus).toBe('PAID');
  });

  it('excludes already-paid orders from future table bills and prevents double billing', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;
    const roti = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Tandoori Roti')).get()!.id;

    const table = (await ctx.api.post('/api/tables').send({ name: 'T6' })).body.table;

    // Order 1: Tikka
    const o1 = (
      await ctx.api.post('/api/orders').send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: tikka, quantity: 1 }],
      })
    ).body.order;

    // Order 1 billed and paid individually
    await ctx.api.post(`/api/orders/${o1.id}/bill`).send({});
    await ctx.api.post(`/api/orders/${o1.id}/payments`).send({
      method: 'CASH',
      idempotencyKey: requestId(),
      expectedTotalPaise: 24000,
      tenderedPaise: 24000,
    });

    // Mark Order 1 served
    await ctx.as('KITCHEN').patch(`/api/orders/${o1.id}/status`).send({ status: 'PREPARING' });
    await ctx.as('KITCHEN').patch(`/api/orders/${o1.id}/status`).send({ status: 'READY' });
    await ctx.as('RECEPTION').patch(`/api/orders/${o1.id}/status`).send({ status: 'COMPLETED' });

    // Later, same table places Order 2: 2x Roti (6000)
    const o2 = (
      await ctx.api.post('/api/orders').send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: roti, quantity: 2 }],
      })
    ).body.order;

    // Generating a bill for table T6 now ONLY covers unpaid Order 2 (Order 1 is excluded!)
    const billRes = (await ctx.api.post(`/api/tables/${table.id}/bill`).send({})).body;
    expect(billRes.orders.length).toBe(1);
    expect(billRes.orders[0].id).toBe(o2.id);
    expect(billRes.bill.subtotalPaise).toBe(6000);
    expect(billRes.bill.totalPaise).toBe(6000);
  });

  it('keeps table OCCUPIED if paid but kitchen orders remain active', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;
    const table = (await ctx.api.post('/api/tables').send({ name: 'T7' })).body.table;

    // Order placed: NEW in kitchen
    const o = (
      await ctx.api.post('/api/orders').send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: tikka, quantity: 1 }],
      })
    ).body.order;

    // Customer pays immediately at reception before food is served
    await ctx.api.post(`/api/orders/${o.id}/bill`).send({});
    await ctx.api.post(`/api/orders/${o.id}/payments`).send({
      method: 'CASH',
      idempotencyKey: requestId(),
      expectedTotalPaise: 24000,
      tenderedPaise: 24000,
    });

    // Order is PAID, but status is NEW in kitchen: customer is seated waiting for food!
    // Therefore table status MUST BE OCCUPIED!
    let tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.status).toBe('OCCUPIED');

    // Kitchen moves to PREPARING -> still OCCUPIED
    await ctx.as('KITCHEN').patch(`/api/orders/${o.id}/status`).send({ status: 'PREPARING' });
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.status).toBe('OCCUPIED');

    // Kitchen moves to READY -> still OCCUPIED
    await ctx.as('KITCHEN').patch(`/api/orders/${o.id}/status`).send({ status: 'READY' });
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.status).toBe('OCCUPIED');

    expect(tile).toMatchObject({ kitchenStatus: 'READY', paymentState: 'PAID' });

    // Reception serves the food (COMPLETED): it stays occupied as Served + Paid until cleared
    await ctx.as('RECEPTION').patch(`/api/orders/${o.id}/status`).send({ status: 'COMPLETED' });
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile).toMatchObject({ status: 'OCCUPIED', kitchenStatus: 'COMPLETED', paymentState: 'PAID' });
    await ctx.api.post(`/api/tables/${table.id}/clear`).expect(200);
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.status).toBe('AVAILABLE');

    // The next customer's order starts a fresh session
    await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: tikka, quantity: 1 }] }).expect(201);
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile).toMatchObject({ status: 'OCCUPIED', kitchenStatus: 'NEW', paymentState: 'UNPAID' });
  });

  it('correctly settles repeat dining sessions on the same table and clears table', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id; // 24000
    const roti = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Tandoori Roti')).get()!.id; // 3000
    const table = (await ctx.api.post('/api/tables').send({ name: 'T8' })).body.table;

    // Session 1: Order 1 placed, billed via table bill, and paid
    const o1 = (
      await ctx.api.post('/api/orders').send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: tikka, quantity: 1 }],
      })
    ).body.order;

    await ctx.api.post(`/api/tables/${table.id}/bill`).send({});
    await ctx.api.post(`/api/tables/${table.id}/payments`).send({
      method: 'CASH',
      idempotencyKey: requestId(),
      expectedTotalPaise: 24000,
      tenderedPaise: 24000,
    });

    // Session 2: New guests arrive, place Order 2
    const o2 = (
      await ctx.api.post('/api/orders').send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableId: table.id,
        items: [{ menuItemId: roti, quantity: 2 }],
      })
    ).body.order;

    // Table overview must show 1 active order for 6000 paise (not the old 24000 paise!)
    let tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.activeOrderCount).toBe(1);
    expect(tile.runningTotalPaise).toBe(6000);
    expect(tile.tableStatus).toBe('RUNNING_KOT');

    // Table checkout must return UNPAID Order 2, NOT the old paid bill
    const checkout = (await ctx.api.get(`/api/tables/${table.id}/checkout`).expect(200)).body;
    expect(checkout.paymentStatus).toBe('UNPAID');
    expect(checkout.orders.length).toBe(1);
    expect(checkout.orders[0].id).toBe(o2.id);

    // Bill & pay Session 2
    await ctx.api.post(`/api/tables/${table.id}/bill`).send({});
    await ctx.api.post(`/api/tables/${table.id}/payments`).send({
      method: 'CASH',
      idempotencyKey: requestId(),
      expectedTotalPaise: 6000,
      tenderedPaise: 6000,
    });

    // Table is now PAID (orange)
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.tableStatus).toBe('PAID');

    // The kitchen has not cooked these orders yet, so the table cannot be cleared.
    const busy = await ctx.api.post(`/api/tables/${table.id}/clear`).expect(409);
    expect(busy.body.error.code).toBe('KITCHEN_BUSY');
    for (const o of [o1, o2]) {
      for (const status of ['PREPARING', 'READY']) await ctx.api.patch(`/api/orders/${o.id}/status`).send({ status }).expect(200);
    }

    // Clear the table so it becomes available
    await ctx.api.post(`/api/tables/${table.id}/clear`).expect(200);
    tile = (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile.tableStatus).toBe('BLANK');
    expect(tile.status).toBe('AVAILABLE');
  });
});
