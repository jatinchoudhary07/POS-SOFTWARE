import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { and, eq, notInArray } from 'drizzle-orm';
import { config } from '../config';
import { openDatabase, runMigrations, type DB } from './client';
import { menuCategories, menuItems, restaurantSettings } from './schema';
import { cafeDetails, seedMenu, type SeedCategory } from './seedData';

export interface LoadMenuResult {
  added: number;
  updated: number;
  removed: number;
  removedCategories: number;
}

/**
 * Makes the menu in the database exactly `menu` (default: the Two Hearts Cafe menu) and puts the
 * cafe details on receipts. Orders, bills, payments, logins and tax rates are not touched.
 *
 * - Items are matched by category + name: existing ones get the new price; new ones are added.
 * - Items and categories not in `menu` are removed. Old orders keep their item names and
 *   prices (they are copied onto each order), so past bills and sales totals do not change.
 * - An item someone marked "unavailable" stays unavailable.
 * - Cafe address is only filled in if it is empty, so an address typed in Settings is kept.
 */
export function loadMenu(db: DB, { menu = seedMenu, details = cafeDetails } = {}): LoadMenuResult {
  return db.transaction((tx) => {
    const result: LoadMenuResult = { added: 0, updated: 0, removed: 0, removedCategories: 0 };
    const keepCategoryIds: number[] = [];

    menu.forEach((cat, ci) => {
      const existing = tx.select().from(menuCategories).where(eq(menuCategories.name, cat.name)).get();
      const categoryId = existing
        ? (tx.update(menuCategories).set({ sortOrder: ci, isActive: true }).where(eq(menuCategories.id, existing.id)).run(), existing.id)
        : tx.insert(menuCategories).values({ name: cat.name, sortOrder: ci }).returning({ id: menuCategories.id }).get().id;
      keepCategoryIds.push(categoryId);

      const keepItemIds: number[] = [];
      cat.items.forEach((item, ii) => {
        const values = {
          pricePaise: item.pricePaise,
          description: item.description ?? null,
          isVeg: item.isVeg ?? true,
          sortOrder: ii,
        };
        const row = tx
          .select({ id: menuItems.id })
          .from(menuItems)
          .where(and(eq(menuItems.categoryId, categoryId), eq(menuItems.name, item.name)))
          .get();
        if (row) {
          tx.update(menuItems).set(values).where(eq(menuItems.id, row.id)).run();
          keepItemIds.push(row.id);
          result.updated++;
        } else {
          const { id } = tx
            .insert(menuItems)
            .values({ ...values, categoryId, name: item.name, isAvailable: item.isAvailable ?? true })
            .returning({ id: menuItems.id })
            .get();
          keepItemIds.push(id);
          result.added++;
        }
      });
      result.removed += tx
        .delete(menuItems)
        .where(and(eq(menuItems.categoryId, categoryId), notInArray(menuItems.id, keepItemIds)))
        .run().changes;
    });

    // Categories that are not on the new menu: remove their items, then the category.
    const oldCategories = tx.select({ id: menuCategories.id }).from(menuCategories).where(notInArray(menuCategories.id, keepCategoryIds)).all();
    for (const { id } of oldCategories) {
      result.removed += tx.delete(menuItems).where(eq(menuItems.categoryId, id)).run().changes;
      tx.delete(menuCategories).where(eq(menuCategories.id, id)).run();
      result.removedCategories++;
    }

    const settings = tx.select().from(restaurantSettings).where(eq(restaurantSettings.id, 1)).get();
    if (settings) {
      tx.update(restaurantSettings)
        .set({
          restaurantName: details.restaurantName,
          receiptFooter: details.receiptFooter,
          addressLine: settings.addressLine || details.addressLine,
        })
        .where(eq(restaurantSettings.id, 1))
        .run();
    } else {
      tx.insert(restaurantSettings).values({ id: 1, ...details }).run();
    }
    return result;
  });
}

/** Checks a menu for mistakes before it is written: empty names, duplicates, bad prices. */
export function validateMenu(menu: SeedCategory[]): string[] {
  const problems: string[] = [];
  const categories = new Set<string>();
  for (const cat of menu) {
    if (categories.has(cat.name)) problems.push(`Category "${cat.name}" appears twice`);
    categories.add(cat.name);
    const names = new Set<string>();
    for (const item of cat.items) {
      if (!item.name.trim() || item.name.length > 80) problems.push(`Bad item name "${item.name}" in ${cat.name}`);
      if (names.has(item.name)) problems.push(`"${item.name}" appears twice in ${cat.name}`);
      if (!Number.isInteger(item.pricePaise) || item.pricePaise <= 0) problems.push(`Bad price for "${item.name}"`);
      names.add(item.name);
    }
  }
  return problems;
}

// Run as a script: `npm run menu:load`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = validateMenu(seedMenu);
  if (problems.length) {
    console.error(`The menu in server/src/db/seedData.ts has problems — nothing was changed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const existed = fs.existsSync(config.databasePath);
  const { db, sqlite } = openDatabase(config.databasePath);
  if (existed && sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'orders'").get()) {
    // Never change data without a copy: back up first, and stop if that fails.
    const { createBackupService } = await import('../backup/backupService');
    try {
      const file = await createBackupService({ sqlite, ...config.backup }).backupNow('before-menu-load');
      console.log(`Backup of the current data saved first: ${file!.path}`);
    } catch (e) {
      console.error(`Backup failed, so the menu was NOT changed: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  runMigrations(db);
  const r = loadMenu(db);
  sqlite.close();
  const items = seedMenu.reduce((n, c) => n + c.items.length, 0);
  console.log(`${cafeDetails.restaurantName} menu loaded: ${seedMenu.length} categories, ${items} items.`);
  console.log(`  ${r.added} added, ${r.updated} updated, ${r.removed} old items and ${r.removedCategories} old categories removed.`);
  console.log('  Past orders and bills are unchanged. If the POS is open, reload its screens (F5).');
}
