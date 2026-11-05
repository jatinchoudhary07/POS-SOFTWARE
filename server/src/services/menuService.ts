import { and, asc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { menuCategories, menuItems } from '../db/schema';
import { AppError, notFound } from '../lib/errors';

export interface MenuItemDTO {
  id: number;
  categoryId: number;
  name: string;
  description: string | null;
  pricePaise: number;
  isAvailable: boolean;
  isVeg: boolean;
}

export interface MenuCategoryDTO {
  id: number;
  name: string;
  items: MenuItemDTO[];
}

/** Category as seen by the menu editor: includes hidden categories. */
export interface ManagedCategoryDTO extends MenuCategoryDTO {
  isActive: boolean;
}

export interface ItemChanges {
  name?: string;
  description?: string | null;
  pricePaise?: number;
  isAvailable?: boolean;
  isVeg?: boolean;
  categoryId?: number;
}

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint/i.test(e.message);

const toItemDTO = (i: typeof menuItems.$inferSelect): MenuItemDTO => ({
  id: i.id,
  categoryId: i.categoryId,
  name: i.name,
  description: i.description,
  pricePaise: i.pricePaise,
  isAvailable: i.isAvailable,
  isVeg: i.isVeg,
});

export function createMenuService(db: DB) {
  return {
    /** Active categories with all their items (including unavailable ones, shown greyed out). */
    getMenu(): MenuCategoryDTO[] {
      const categories = db.query.menuCategories.findMany({
        where: eq(menuCategories.isActive, true),
        orderBy: [asc(menuCategories.sortOrder), asc(menuCategories.name)],
        with: {
          items: { orderBy: [asc(menuItems.sortOrder), asc(menuItems.name)] },
        },
      }).sync();
      return categories.map((c) => ({ id: c.id, name: c.name, items: c.items.map(toItemDTO) }));
    },

    /** Every category (hidden ones too) with every item, for the Superadmin menu editor. */
    getManagedMenu(): ManagedCategoryDTO[] {
      const categories = db.query.menuCategories.findMany({
        orderBy: [asc(menuCategories.sortOrder), asc(menuCategories.name)],
        with: { items: { orderBy: [asc(menuItems.sortOrder), asc(menuItems.name)] } },
      }).sync();
      return categories.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, items: c.items.map(toItemDTO) }));
    },

    createCategory(name: string): ManagedCategoryDTO {
      try {
        const max = db.select({ m: sql<number>`coalesce(max(${menuCategories.sortOrder}), 0)` }).from(menuCategories).get()?.m ?? 0;
        const c = db.insert(menuCategories).values({ name, sortOrder: max + 1 }).returning().get();
        return { id: c.id, name: c.name, isActive: c.isActive, items: [] };
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `There is already a category called “${name}”`);
        throw e;
      }
    },

    updateCategory(id: number, changes: { name?: string; isActive?: boolean }) {
      try {
        const c = db.update(menuCategories).set(changes).where(eq(menuCategories.id, id)).returning().get();
        if (!c) throw notFound(`Category ${id} not found`);
        return { id: c.id, name: c.name, isActive: c.isActive };
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `There is already a category called “${changes.name}”`);
        throw e;
      }
    },

    /** Only an empty category can be deleted; otherwise hide it (isActive = false). */
    deleteCategory(id: number): void {
      const count = db.select({ n: sql<number>`count(*)` }).from(menuItems).where(eq(menuItems.categoryId, id)).get()?.n ?? 0;
      if (count > 0) throw new AppError(409, 'CATEGORY_NOT_EMPTY', 'This category still has items. Delete them first, or hide the category instead.');
      const gone = db.delete(menuCategories).where(eq(menuCategories.id, id)).returning().get();
      if (!gone) throw notFound(`Category ${id} not found`);
    },

    createItem(input: { categoryId: number; name: string; description?: string | null; pricePaise: number; isVeg: boolean }): MenuItemDTO {
      const cat = db.select().from(menuCategories).where(eq(menuCategories.id, input.categoryId)).get();
      if (!cat) throw notFound(`Category ${input.categoryId} not found`);
      try {
        const max = db.select({ m: sql<number>`coalesce(max(${menuItems.sortOrder}), 0)` }).from(menuItems).where(eq(menuItems.categoryId, input.categoryId)).get()?.m ?? 0;
        return toItemDTO(db.insert(menuItems).values({ ...input, sortOrder: max + 1 }).returning().get());
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', `“${input.name}” already exists in ${cat.name}`);
        throw e;
      }
    },

    updateItem(id: number, changes: ItemChanges): MenuItemDTO {
      try {
        const updated = db.update(menuItems).set(changes).where(eq(menuItems.id, id)).returning().get();
        if (!updated) throw notFound(`Menu item ${id} not found`);
        return toItemDTO(updated);
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'DUPLICATE', 'That category already has an item with this name');
        if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) throw notFound(`Category ${changes.categoryId} not found`);
        throw e;
      }
    },

    /** Saves a drag-and-drop order: position in the list becomes the display order. */
    reorderCategories(ids: number[]): void {
      db.transaction((tx) => {
        ids.forEach((id, i) => tx.update(menuCategories).set({ sortOrder: i }).where(eq(menuCategories.id, id)).run());
      });
    },

    reorderItems(categoryId: number, ids: number[]): void {
      db.transaction((tx) => {
        ids.forEach((id, i) =>
          tx.update(menuItems).set({ sortOrder: i }).where(and(eq(menuItems.id, id), eq(menuItems.categoryId, categoryId))).run(),
        );
      });
    },

    /** Old orders keep their own copy of the name and price, so deleting is safe. */
    deleteItem(id: number): void {
      const gone = db.delete(menuItems).where(eq(menuItems.id, id)).returning().get();
      if (!gone) throw notFound(`Menu item ${id} not found`);
    },
  };
}

export type MenuService = ReturnType<typeof createMenuService>;
