import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { menuItems } from '../src/db/schema';
import { requestId, setupTestApp } from './helpers';

const setup = () => {
  const ctx = setupTestApp();
  const find = (name: string) => ctx.db.select().from(menuItems).where(eq(menuItems.name, name)).get()!.id;
  const tikka = find('Paneer Tikka'); // 24000
  const roti = find('Tandoori Roti'); // 3000
  const R = ctx.as('RECEPTION');
  const K = ctx.as('KITCHEN');
  const table = async (name: string) => (await ctx.api.post('/api/tables').send({ name })).body.table.id as number;
  const place = async (body: Record<string, unknown>) => (await R.post('/api/orders').send({ clientRequestId: requestId(), ...body }).expect(201)).body;
  return { ctx, tikka, roti, R, K, place, table };
};

describe('packing some dishes of a dine-in order', () => {
  it('adds packed dishes to the running table order: one bill, the packed lines marked', async () => {
    const { R, tikka, roti, place, table } = setup();
    const t = await table('T4');
    const first = await place({ orderType: 'DINE_IN', tableId: t, items: [{ menuItemId: tikka, quantity: 1 }] });
    const more = await place({ orderType: 'DINE_IN', tableId: t, items: [{ menuItemId: roti, quantity: 2, packed: true }] });
    expect(more.merged).toBe(true);
    expect(more.order.id).toBe(first.order.id);
    expect(more.order.items.map((i: any) => [i.itemName, i.quantity, i.packed])).toEqual([['Paneer Tikka', 1, false], ['Tandoori Roti', 2, true]]);
    expect(more.order.subtotalPaise).toBe(24000 + 2 * 3000); // one bill for everything
    const bill = (await R.post(`/api/orders/${more.order.id}/bill`).send({}).expect(200)).body.bill;
    expect(bill.subtotalPaise).toBe(30000);
  });

  it('keeps a packed line apart from an eat-in line of the same dish, and adds up repeated packed lines', async () => {
    const { tikka, place, table } = setup();
    const t = await table('T2');
    await place({ orderType: 'DINE_IN', tableId: t, items: [{ menuItemId: tikka, quantity: 1 }] });
    const one = await place({ orderType: 'DINE_IN', tableId: t, items: [{ menuItemId: tikka, quantity: 1, packed: true }, { menuItemId: tikka, quantity: 1, packed: true }] });
    expect(one.order.items.map((i: any) => [i.quantity, i.packed])).toEqual([[1, false], [2, true]]);
    // one more packed one before the kitchen takes it: joins the packed line, not the eat-in line
    const two = await place({ orderType: 'DINE_IN', tableId: t, items: [{ menuItemId: tikka, quantity: 1, packed: true }] });
    expect(two.order.items.map((i: any) => [i.quantity, i.packed])).toEqual([[1, false], [3, true]]);
    expect(two.order.subtotalPaise).toBe(4 * 24000);
  });

  it('shows the kitchen which dishes to pack', async () => {
    const { K, tikka, roti, place } = setup();
    await place({ orderType: 'DINE_IN', tableNumber: '7', items: [{ menuItemId: tikka, quantity: 1 }, { menuItemId: roti, quantity: 1, packed: true }] });
    const [ticket] = (await K.get('/api/kitchen/orders')).body.orders;
    expect(ticket.items.map((i: any) => [i.itemName, i.packed])).toEqual([['Paneer Tikka', false], ['Tandoori Roti', true]]);
  });

  it('ignores "packed" on a packing (takeaway) order: it is all packed already', async () => {
    const { tikka, place } = setup();
    const { order } = await place({ orderType: 'TAKEAWAY', items: [{ menuItemId: tikka, quantity: 1, packed: true }] });
    expect(order.items[0].packed).toBe(false);
  });

  it('keeps the packed marks when the order is edited before the kitchen starts it', async () => {
    const { R, tikka, roti, place } = setup();
    const { order } = await place({ orderType: 'DINE_IN', tableNumber: '9', items: [{ menuItemId: tikka, quantity: 1 }, { menuItemId: roti, quantity: 2, packed: true }] });
    const res = await R.put(`/api/orders/${order.id}/items`)
      .send({ items: [{ menuItemId: tikka, quantity: 2 }, { menuItemId: roti, quantity: 3, packed: true }] })
      .expect(200);
    expect(res.body.order.items.map((i: any) => [i.itemName, i.quantity, i.packed])).toEqual([['Paneer Tikka', 2, false], ['Tandoori Roti', 3, true]]);
    // an edit that does not mention "packed" makes the dish an ordinary eat-in dish
    const plain = await R.put(`/api/orders/${order.id}/items`).send({ items: [{ menuItemId: roti, quantity: 1 }] }).expect(200);
    expect(plain.body.order.items.map((i: any) => i.packed)).toEqual([false]);
  });
});
