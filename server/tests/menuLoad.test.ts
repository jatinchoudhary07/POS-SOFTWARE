import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadMenu, validateMenu } from '../src/db/loadMenu';
import { menuCategories, menuItems, orderItems, orders, restaurantSettings } from '../src/db/schema';
import { cafeDetails, seedMenu } from '../src/db/seedData';
import { setupTestApp } from './helpers';

const itemCount = seedMenu.reduce((n, c) => n + c.items.length, 0);
const priceOf = (ctx: ReturnType<typeof setupTestApp>, name: string) =>
  ctx.db.select().from(menuItems).where(eq(menuItems.name, name)).get()?.pricePaise;

describe('Two Hearts Cafe menu', () => {
  it('has no duplicate names, empty names or bad prices', () => {
    expect(validateMenu(seedMenu)).toEqual([]);
    expect(itemCount).toBeGreaterThan(150);
  });

  it('turns each size into its own item with the price from the card', () => {
    const items = seedMenu.flatMap((c) => c.items);
    const price = (name: string) => items.find((i) => i.name === name)?.pricePaise;
    expect(price('Tomato Pizza (Medium)')).toBe(7900);
    expect(price('Two Hearts Special Pizza (Large)')).toBe(34900);
    expect(price('Veg Chowmein (Half)')).toBe(4000);
    expect(price('Veg Chowmein (Full)')).toBe(8000);
    expect(price('Kaju Shake')).toBe(10000);
    expect(price('Kaju Shake + Ice Cream')).toBe(11900);
    expect(price('Pizza Party')).toBe(35900);
  });
});

describe('npm run menu:load', () => {
  it('replaces the old menu, keeps past orders unchanged and fills in the cafe details', async () => {
    const ctx = setupTestApp();
    const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!;
    const naan = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Butter Naan')).get()!;
    const res = await ctx.api
      .post('/api/orders')
      .send({ clientRequestId: 'menu-load-1', orderType: 'TAKEAWAY', items: [{ menuItemId: tikka.id, quantity: 2 }, { menuItemId: naan.id, quantity: 1 }] })
      .expect(201);
    const before = ctx.db.select().from(orderItems).all();

    const r = loadMenu(ctx.db);

    // Sample-menu categories are gone; the cafe's are there in card order.
    const cats = ctx.db.select({ name: menuCategories.name }).from(menuCategories).orderBy(menuCategories.sortOrder).all();
    expect(cats.map((c) => c.name)).toEqual(seedMenu.map((c) => c.name));
    expect(ctx.db.select().from(menuItems).all()).toHaveLength(itemCount);
    expect(priceOf(ctx, 'Butter Naan')).toBeUndefined();
    // "Paneer Tikka" moved from Starters to Chaap and is now sold in two sizes.
    expect(priceOf(ctx, 'Paneer Tikka (Full)')).toBe(24000);
    expect(r.removedCategories).toBe(6);

    // The past order keeps its names, prices and total; only the link to the deleted item is cleared.
    const after = ctx.db.select().from(orderItems).all();
    expect(after.map(({ menuItemId: _, ...rest }) => rest)).toEqual(before.map(({ menuItemId: _, ...rest }) => rest));
    expect(ctx.db.select().from(orders).where(eq(orders.id, res.body.order.id)).get()!.subtotalPaise).toBe(53000);

    expect(ctx.db.select().from(restaurantSettings).get()).toMatchObject(cafeDetails);
    const menu = await ctx.api.get('/api/menu').expect(200);
    expect(menu.body.categories[0].name).toBe('Pizza');
    const settings = await ctx.api.get('/api/settings').expect(200);
    expect(settings.body.settings.restaurantName).toBe('Two Hearts Cafe');
  });

  it('can run again safely: same menu, prices restored, unavailable items and a typed address kept', async () => {
    const ctx = setupTestApp();
    loadMenu(ctx.db);
    const ids = ctx.db.select({ id: menuItems.id }).from(menuItems).all();
    const maggi = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Plain Maggi')).get()!;
    const momos = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Tandoori Momos (Full)')).get()!;
    await ctx.api.patch(`/api/menu/items/${maggi.id}`).send({ pricePaise: 1 }).expect(200);
    await ctx.api.patch(`/api/menu/items/${momos.id}`).send({ isAvailable: false }).expect(200);
    await ctx.api.put('/api/settings').send({ restaurantName: 'X', addressLine: 'Main Road, Tijara', roundToRupee: true, taxes: [{ name: 'GST', rateBps: 500 }] }).expect(200);

    const r = loadMenu(ctx.db);

    expect(r).toEqual({ added: 0, updated: itemCount, removed: 0, removedCategories: 0 });
    expect(ctx.db.select({ id: menuItems.id }).from(menuItems).all()).toEqual(ids);
    expect(priceOf(ctx, 'Plain Maggi')).toBe(5000);
    expect(ctx.db.select().from(menuItems).where(eq(menuItems.id, momos.id)).get()!.isAvailable).toBe(false);
    const settings = (await ctx.api.get('/api/settings').expect(200)).body.settings;
    expect(settings).toMatchObject({ restaurantName: 'Two Hearts Cafe', addressLine: 'Main Road, Tijara', roundToRupee: true });
    expect(settings.taxes).toEqual([{ name: 'GST', rateBps: 500 }]);
  });
});
