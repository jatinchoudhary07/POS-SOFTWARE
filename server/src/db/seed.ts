import { pathToFileURL } from 'node:url';
import { config } from '../config';
import { openDatabase, runMigrations, type DB } from './client';
import { bills, menuCategories, menuItems, orderItems, orders, payments } from './schema';
import { seedMenu, type SeedCategory } from './seedData';

/**
 * Inserts the cafe menu (see seedData.ts). Skips if a menu already exists, so it never
 * duplicates or overwrites a menu you have edited. Use --reset to wipe all
 * orders, bills, payments and the menu and start fresh. Restaurant settings
 * and tax rates (configuration) are kept.
 */
export function seed(db: DB, { reset = false, menu = seedMenu }: { reset?: boolean; menu?: SeedCategory[] } = {}): { seeded: boolean } {
  return db.transaction((tx) => {
    if (reset) {
      // Children first: payments -> bills -> order items -> orders (foreign keys).
      tx.delete(payments).run();
      tx.delete(bills).run();
      tx.delete(orderItems).run();
      tx.delete(orders).run();
      tx.delete(menuItems).run();
      tx.delete(menuCategories).run();
    } else if (tx.select({ id: menuCategories.id }).from(menuCategories).limit(1).get()) {
      return { seeded: false };
    }

    menu.forEach((cat, ci) => {
      const { id } = tx
        .insert(menuCategories)
        .values({ name: cat.name, sortOrder: ci })
        .returning({ id: menuCategories.id })
        .get();
      tx.insert(menuItems)
        .values(
          cat.items.map((item, ii) => ({
            categoryId: id,
            name: item.name,
            description: item.description ?? null,
            pricePaise: item.pricePaise,
            isVeg: item.isVeg ?? true,
            isAvailable: item.isAvailable ?? true,
            sortOrder: ii,
          })),
        )
        .run();
    });
    return { seeded: true };
  });
}

// Run as a script: `npm run db:seed` or `npm run db:reset`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const reset = process.argv.includes('--reset');
  const { db, sqlite } = openDatabase(config.databasePath);
  if (reset && sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'orders'").get()) {
    // Never wipe data without a copy: back up first, and stop if that fails.
    const { createBackupService } = await import('../backup/backupService');
    const file = await createBackupService({ sqlite, ...config.backup }).backupNow('before-reset');
    console.log(`Backup of the current data saved first: ${file!.path}`);
  }
  runMigrations(db);
  const { seeded } = seed(db, { reset });
  sqlite.close();
  console.log(
    seeded
      ? `Menu ${reset ? 're-' : ''}seeded into ${config.databasePath}`
      : 'Menu already exists — nothing changed. Use `npm run db:reset` to wipe and re-seed.',
  );
}
