import { Router } from 'express';
import { requireRole } from '../lib/auth';
import type { MenuService } from '../services/menuService';
import {
  createCategorySchema,
  createMenuItemSchema,
  idParamSchema,
  reorderSchema,
  updateCategorySchema,
  updateMenuItemSchema,
} from '../validation';

export function menuRouter(menu: MenuService): Router {
  const router = Router();

  router.get('/', requireRole('SUPERADMIN', 'RECEPTION'), (_req, res) => {
    res.json({ categories: menu.getMenu() });
  });

  // Menu editing is configuration, not a cashier action: Superadmin only.
  router.get('/manage', requireRole('SUPERADMIN'), (_req, res) => {
    res.json({ categories: menu.getManagedMenu() });
  });

  router.post('/categories', requireRole('SUPERADMIN'), (req, res) => {
    const { name } = createCategorySchema.parse(req.body);
    res.status(201).json({ category: menu.createCategory(name) });
  });

  router.put('/categories/order', requireRole('SUPERADMIN'), (req, res) => {
    menu.reorderCategories(reorderSchema.parse(req.body).ids);
    res.json({ ok: true });
  });

  router.put('/categories/:id/items/order', requireRole('SUPERADMIN'), (req, res) => {
    menu.reorderItems(idParamSchema.parse(req.params.id), reorderSchema.parse(req.body).ids);
    res.json({ ok: true });
  });

  router.patch('/categories/:id', requireRole('SUPERADMIN'), (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    res.json({ category: menu.updateCategory(id, updateCategorySchema.parse(req.body)) });
  });

  router.delete('/categories/:id', requireRole('SUPERADMIN'), (req, res) => {
    menu.deleteCategory(idParamSchema.parse(req.params.id));
    res.json({ ok: true });
  });

  router.post('/items', requireRole('SUPERADMIN'), (req, res) => {
    res.status(201).json({ item: menu.createItem(createMenuItemSchema.parse(req.body)) });
  });

  router.patch('/items/:id', requireRole('SUPERADMIN'), (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    const changes = updateMenuItemSchema.parse(req.body);
    res.json({ item: menu.updateItem(id, changes) });
  });

  router.delete('/items/:id', requireRole('SUPERADMIN'), (req, res) => {
    menu.deleteItem(idParamSchema.parse(req.params.id));
    res.json({ ok: true });
  });

  return router;
}
