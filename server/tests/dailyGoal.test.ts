import { describe, expect, it } from 'vitest';
import { setupTestApp } from './helpers';

describe('the daily sales goal is shared by every device', () => {
  it('starts at ₹5,000 and is the same for every signed-in staff login', async () => {
    const ctx = setupTestApp();
    for (const who of [ctx.api, ctx.as('RECEPTION')]) {
      expect((await who.get('/api/settings/daily-goal').expect(200)).body).toEqual({ dailyGoalPaise: 500000 });
    }
  });

  it('only the Superadmin can change it, and the new goal shows on every other device', async () => {
    const ctx = setupTestApp();
    const reception = ctx.as('RECEPTION');
    await reception.put('/api/settings/daily-goal').send({ dailyGoalPaise: 1500000 }).expect(403);
    await ctx.as('KITCHEN').put('/api/settings/daily-goal').send({ dailyGoalPaise: 1500000 }).expect(403);
    await ctx.anon.put('/api/settings/daily-goal').send({ dailyGoalPaise: 1500000 }).expect(401);
    expect((await reception.get('/api/settings/daily-goal')).body.dailyGoalPaise).toBe(500000); // nothing changed

    expect((await ctx.api.put('/api/settings/daily-goal').send({ dailyGoalPaise: 1500000 }).expect(200)).body).toEqual({ dailyGoalPaise: 1500000 });
    expect((await reception.get('/api/settings/daily-goal')).body.dailyGoalPaise).toBe(1500000); // another device
    expect((await ctx.api.get('/api/settings/daily-goal')).body.dailyGoalPaise).toBe(1500000);
  });

  it('refuses nonsense goals', async () => {
    const ctx = setupTestApp();
    for (const bad of [{ dailyGoalPaise: 0 }, { dailyGoalPaise: -500 }, { dailyGoalPaise: 12.5 }, { dailyGoalPaise: '5000' }, { dailyGoalPaise: 1e12 }, {}, { dailyGoalPaise: 100000, extra: 1 }]) {
      await ctx.api.put('/api/settings/daily-goal').send(bad).expect(400);
    }
    expect((await ctx.api.get('/api/settings/daily-goal')).body.dailyGoalPaise).toBe(500000);
  });

  it('does not disturb the restaurant details, which are saved separately, in either order', async () => {
    const ctx = setupTestApp();
    await ctx.api.put('/api/settings/daily-goal').send({ dailyGoalPaise: 2000000 }).expect(200); // before settings were ever saved
    const saved = (await ctx.api.put('/api/settings').send({ restaurantName: 'Two Hearts', addressLine: null, phone: null, taxId: null, receiptFooter: null, roundToRupee: false, taxes: [] }).expect(200)).body.settings;
    expect(saved).toMatchObject({ restaurantName: 'Two Hearts', configured: true });
    expect((await ctx.api.get('/api/settings/daily-goal')).body.dailyGoalPaise).toBe(2000000); // saving the details keeps the goal
    await ctx.api.put('/api/settings/daily-goal').send({ dailyGoalPaise: 800000 }).expect(200);
    expect((await ctx.api.get('/api/settings')).body.settings.restaurantName).toBe('Two Hearts'); // changing the goal keeps the details
  });
});
