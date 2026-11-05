import { describe, expect, it } from 'vitest';
import { requestId, setupTestApp } from './helpers';

describe('menu management (Superadmin)', () => {
  it('adds a category and an item, which then show on the ordering menu', async () => {
    const ctx = setupTestApp();
    const cat = await ctx.api.post('/api/menu/categories').send({ name: 'Specials' });
    expect(cat.status).toBe(201);
    const item = await ctx.api.post('/api/menu/items').send({ categoryId: cat.body.category.id, name: 'Brownie', pricePaise: 12000, isVeg: true });
    expect(item.status).toBe(201);
    expect(item.body.item).toMatchObject({ name: 'Brownie', pricePaise: 12000, isAvailable: true });

    const menu = (await ctx.as('RECEPTION').get('/api/menu')).body.categories;
    expect(menu.find((c: { name: string }) => c.name === 'Specials').items).toHaveLength(1);
  });

  it('renames, reprices, moves and deletes an item without touching old orders', async () => {
    const ctx = setupTestApp();
    const menu = (await ctx.api.get('/api/menu/manage')).body.categories;
    const item = menu[0].items[0];
    const other = menu[1];
    const order = (await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: item.id, quantity: 1 }] })).body.order;

    const patched = await ctx.api.patch(`/api/menu/items/${item.id}`).send({ name: 'Renamed', pricePaise: 99900, categoryId: other.id, isVeg: false });
    expect(patched.status).toBe(200);
    expect(patched.body.item).toMatchObject({ name: 'Renamed', pricePaise: 99900, categoryId: other.id, isVeg: false });

    expect((await ctx.api.delete(`/api/menu/items/${item.id}`)).status).toBe(200);
    const kept = (await ctx.api.get(`/api/orders/${order.id}`)).body.order;
    expect(kept.items[0]).toMatchObject({ itemName: item.name, unitPricePaise: item.pricePaise });
  });

  it('refuses duplicates, empty-category rules and bad input', async () => {
    const ctx = setupTestApp();
    const menu = (await ctx.api.get('/api/menu/manage')).body.categories;
    expect((await ctx.api.post('/api/menu/categories').send({ name: menu[0].name })).status).toBe(409);
    expect((await ctx.api.post('/api/menu/items').send({ categoryId: menu[0].id, name: menu[0].items[0].name, pricePaise: 100 })).status).toBe(409);
    expect((await ctx.api.post('/api/menu/items').send({ categoryId: menu[0].id, name: 'X', pricePaise: -1 })).status).toBe(400);
    expect((await ctx.api.post('/api/menu/items').send({ categoryId: 9999, name: 'X', pricePaise: 100 })).status).toBe(404);
    expect((await ctx.api.delete(`/api/menu/categories/${menu[0].id}`)).status).toBe(409);

    const empty = (await ctx.api.post('/api/menu/categories').send({ name: 'Empty' })).body.category;
    expect((await ctx.api.delete(`/api/menu/categories/${empty.id}`)).status).toBe(200);
  });

  it('hiding a category removes it from the ordering menu but keeps it in the editor', async () => {
    const ctx = setupTestApp();
    const cat = (await ctx.api.get('/api/menu/manage')).body.categories[0];
    await ctx.api.patch(`/api/menu/categories/${cat.id}`).send({ isActive: false });
    expect((await ctx.api.get('/api/menu')).body.categories.some((c: { id: number }) => c.id === cat.id)).toBe(false);
    expect((await ctx.api.get('/api/menu/manage')).body.categories.some((c: { id: number }) => c.id === cat.id)).toBe(true);
  });

  it('only the Superadmin may edit the menu', async () => {
    const ctx = setupTestApp();
    expect((await ctx.as('RECEPTION').get('/api/menu/manage')).status).toBe(403);
    expect((await ctx.as('RECEPTION').post('/api/menu/categories').send({ name: 'Nope' })).status).toBe(403);
    expect((await ctx.as('KITCHEN').post('/api/menu/items').send({})).status).toBe(403);
    expect((await ctx.anon.get('/api/menu/manage')).status).toBe(401);
  });
});

describe('dining tables', () => {
  it('saves an ordered list that reception can read', async () => {
    const ctx = setupTestApp();
    expect((await ctx.as('RECEPTION').get('/api/tables')).body.tables).toEqual([]);
    const saved = await ctx.api.put('/api/tables').send({ tables: ['T1', 'T2', 'Patio'] });
    expect(saved.body.tables).toEqual(['T1', 'T2', 'Patio']);
    expect((await ctx.as('RECEPTION').get('/api/tables')).body.tables).toEqual(['T1', 'T2', 'Patio']);
    expect((await ctx.api.put('/api/tables').send({ tables: ['B', 'A'] })).body.tables).toEqual(['B', 'A']);
  });

  it('rejects duplicates, long names and non-Superadmin edits', async () => {
    const ctx = setupTestApp();
    expect((await ctx.api.put('/api/tables').send({ tables: ['T1', 't1'] })).status).toBe(400);
    expect((await ctx.api.put('/api/tables').send({ tables: ['x'.repeat(11)] })).status).toBe(400);
    expect((await ctx.as('RECEPTION').put('/api/tables').send({ tables: ['T1'] })).status).toBe(403);
    expect((await ctx.as('KITCHEN').get('/api/tables')).status).toBe(403);
  });
});

describe('menu ordering', () => {
  it('saves a dragged order for items and categories, shown on the order screen', async () => {
    const ctx = setupTestApp();
    const cats = (await ctx.api.get('/api/menu/manage')).body.categories;
    const ids = cats[0].items.map((i: { id: number }) => i.id).reverse();
    expect((await ctx.api.put(`/api/menu/categories/${cats[0].id}/items/order`).send({ ids })).status).toBe(200);
    const after = (await ctx.as('RECEPTION').get('/api/menu')).body.categories;
    expect(after.find((c: { id: number }) => c.id === cats[0].id).items.map((i: { id: number }) => i.id)).toEqual(ids);

    const catIds = cats.map((c: { id: number }) => c.id).reverse();
    expect((await ctx.api.put('/api/menu/categories/order').send({ ids: catIds })).status).toBe(200);
    expect((await ctx.api.get('/api/menu')).body.categories.map((c: { id: number }) => c.id)).toEqual(catIds);
  });

  it('only the Superadmin may reorder, and duplicates are refused', async () => {
    const ctx = setupTestApp();
    expect((await ctx.as('RECEPTION').put('/api/menu/categories/order').send({ ids: [1] })).status).toBe(403);
    expect((await ctx.api.put('/api/menu/categories/order').send({ ids: [1, 1] })).status).toBe(400);
  });
});
