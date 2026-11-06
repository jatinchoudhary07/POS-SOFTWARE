import { ArrowUpToLine, ChevronRight, Eye, EyeOff, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { ManagedCategory, MenuItem } from '../api/types';
import { parseRupeesToPaise, paiseToInput } from '../lib/amounts';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { useSortable } from '../lib/useSortable';
import { BottomSheet } from './ui/BottomSheet';
import { Button } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';
import { useToast } from './ui/Toast';

interface ItemForm {
  name: string;
  price: string; // as typed, in rupees
  isVeg: boolean;
  description: string;
  categoryId: number;
}

const emptyForm = (categoryId: number): ItemForm => ({ name: '', price: '', isVeg: true, description: '', categoryId });
const formOf = (i: MenuItem): ItemForm => ({ name: i.name, price: paiseToInput(i.pricePaise), isVeg: i.isVeg, description: i.description ?? '', categoryId: i.categoryId });

function VegDot({ veg }: { veg: boolean }) {
  return (
    <span
      title={veg ? 'Veg' : 'Non-veg'}
      className={cx('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border-2', veg ? 'border-success' : 'border-danger')}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', veg ? 'bg-success' : 'bg-danger')} />
    </span>
  );
}

/** Add / edit / remove categories and items. Changes apply to new orders only; old bills keep their own copy. */
export function MenuManager() {
  const toast = useToast();
  const [cats, setCats] = useState<ManagedCategory[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const [newCat, setNewCat] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  // Item form: 'new' = adding, a number = editing that item, null = closed.
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [form, setForm] = useState<ItemForm>(emptyForm(0));
  // Two-step delete: the first click arms it, the second confirms.
  const [armed, setArmed] = useState<string | null>(null);

  /** Saves a new order (the ids of the categories, or of the open category's items) and keeps the screen in step. */
  async function saveOrder(kind: 'item' | 'cat', ids: number[]) {
    if (!cats) return;
    const before = cats;
    const sorted = <T extends { id: number }>(list: T[]): T[] => {
      const by = new Map(list.map((x) => [x.id, x]));
      const wanted = ids.flatMap((id) => (by.has(id) ? [by.get(id)!] : []));
      return [...wanted, ...list.filter((x) => !ids.includes(x.id))];
    };
    const owner = kind === 'item' ? cats.find((c) => c.id === selected) : null;
    if (kind === 'item' && !owner) return;
    setCats(kind === 'cat' ? sorted(cats) : cats.map((c) => (c.id === owner!.id ? { ...c, items: sorted(c.items) } : c)));
    try {
      if (kind === 'cat') await api.reorderCategories(ids);
      else await api.reorderItems(owner!.id, ids);
    } catch (e) {
      setCats(before);
      toast({ tone: 'error', title: 'Could not save the new order', description: e instanceof ApiError ? e.message : undefined });
    }
  }
  /** Puts one item first in the open category. */
  const moveToTop = (itemId: number) => {
    const open = cats?.find((c) => c.id === selected);
    if (open) void saveOrder('item', [itemId, ...open.items.map((i) => i.id).filter((id) => id !== itemId)]);
  };

  async function load() {
    try {
      const c = await api.getManagedMenu();
      setCats(c);
      setSelected((cur) => (c.some((x) => x.id === cur) ? cur : (c[0]?.id ?? null)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the menu');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const cat = cats?.find((c) => c.id === selected) ?? null;
  const shownItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return (cats ?? []).flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q));
    return cat?.items ?? [];
  }, [cats, cat, query]);
  const editingItem = typeof editing === 'number' ? (cats?.flatMap((c) => c.items).find((i) => i.id === editing) ?? null) : null;
  const categoryName = (id: number) => cats?.find((c) => c.id === id)?.name ?? '';

  // Hold and drag to reorder: categories along the top, items inside the open category (not while searching).
  const catIds = useMemo(() => (cats ?? []).map((c) => c.id), [cats]);
  const itemIds = useMemo(() => (query.trim() ? [] : (cat?.items ?? []).map((i) => i.id)), [cat, query]);
  const catSort = useSortable({ ids: catIds, onReorder: (ids) => void saveOrder('cat', ids), disabled: busy });
  const itemSort = useSortable({ ids: itemIds, onReorder: (ids) => void saveOrder('item', ids), disabled: busy || !!query.trim() });
  const orderedCats = catSort.order.flatMap((id) => cats?.find((c) => c.id === id) ?? []);
  const orderedItems = query.trim() ? shownItems : itemSort.order.flatMap((id) => shownItems.find((i) => i.id === id) ?? []);

  /** Runs one change, reloads the list, and reports problems from the server in a toast. */
  async function run(action: () => Promise<unknown>, done?: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      await load();
      if (done) toast({ tone: 'success', title: done });
      return true;
    } catch (e) {
      toast({ tone: 'error', title: 'Could not save', description: e instanceof ApiError ? e.message : undefined });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    const name = newCat.trim();
    if (!name) return;
    const ok = await run(async () => {
      const c = await api.createCategory(name);
      setSelected(c.id);
    }, `Category “${name}” added`);
    if (ok) setNewCat('');
  }

  async function renameCategory(e: FormEvent) {
    e.preventDefault();
    if (!cat || renaming === null) return;
    if (await run(() => api.updateCategory(cat.id, { name: renaming.trim() }), 'Category renamed')) setRenaming(null);
  }

  function startItem(item: MenuItem | null) {
    setArmed(null);
    if (item) {
      setEditing(item.id);
      setForm(formOf(item));
    } else if (cat) {
      setEditing('new');
      setForm(emptyForm(cat.id));
    }
  }

  async function saveItem(e: FormEvent) {
    e.preventDefault();
    const pricePaise = parseRupeesToPaise(form.price);
    if (!form.name.trim()) return toast({ tone: 'error', title: 'Enter a name for the item' });
    if (pricePaise === null) return toast({ tone: 'error', title: 'Enter a price like 120 or 120.50' });
    const body = { name: form.name.trim(), pricePaise, isVeg: form.isVeg, description: form.description.trim() || null };
    const ok = await run(
      () => (editing === 'new' ? api.createMenuItem({ ...body, categoryId: form.categoryId }) : api.updateMenuItem(editing as number, { ...body, categoryId: form.categoryId })),
      editing === 'new' ? `“${body.name}” added` : 'Item saved',
    );
    if (ok) setEditing(null);
  }

  if (!cats) {
    return (
      <p className="flex items-center justify-center gap-2 py-16 text-ink-2">
        {error ?? (
          <>
            <Loader2 size={18} className="animate-spin" aria-hidden /> Loading menu…
          </>
        )}
      </p>
    );
  }

  const itemForm = (
    <form onSubmit={(e) => void saveItem(e)} className="space-y-3 pt-1">
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <label className="block">
          <span className={labelClass}>Item name</span>
          <input autoFocus required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={cx(inputClass, 'h-11')} />
        </label>
        <label className="block">
          <span className={labelClass}>Price (₹)</span>
          <input required inputMode="decimal" placeholder="120" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={cx(inputClass, 'h-11')} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>Category</span>
          <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) })} className={cx(inputClass, 'h-11')}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>Description (optional)</span>
          <input maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={cx(inputClass, 'h-11')} />
        </label>
      </div>
      <label className="flex items-center gap-3 text-[15px]">
        <input type="checkbox" checked={form.isVeg} onChange={(e) => setForm({ ...form, isVeg: e.target.checked })} className="h-5 w-5 accent-[var(--color-accent)]" />
        Vegetarian
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="plain" onClick={() => setEditing(null)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy} disabled={busy}>
          {editing === 'new' ? 'Add item' : 'Save item'}
        </Button>
      </div>
    </form>
  );

  return (
    <div className="space-y-4 w-full min-w-0 max-w-full">
      <section className="space-y-3 rounded-card bg-surface p-4 sm:p-5 shadow-card w-full min-w-0 max-w-full" aria-label="Categories">
        <h3 className="font-semibold">Categories</h3>
        <div ref={catSort.containerRef} className="no-scrollbar flex w-full min-w-0 max-w-full gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
          {orderedCats.map((c) => (
            <button
              key={c.id}
              type="button"
              {...catSort.itemProps(c.id)}
              title="Hold and drag to change the order"
              onClick={() => {
                setSelected(c.id);
                setQuery('');
                setEditing(null);
                setRenaming(null);
                setArmed(null);
              }}
              className={cx(
                catSort.itemProps(c.id).className,
                'h-8 sm:h-9 shrink-0 rounded-full px-3 sm:px-3.5 text-xs sm:text-sm font-medium whitespace-nowrap transition-colors',
                c.id === selected && !query ? 'bg-accent text-white' : 'bg-fill text-ink-2 hover:text-ink',
                !c.isActive && 'opacity-60',
                catSort.draggingId === c.id && 'ring-2 ring-accent',
              )}
            >
              {c.name} <span className="opacity-70">· {c.items.length}</span>
              {!c.isActive && ' (hidden)'}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => void addCategory(e)} className="flex gap-2 w-full">
          <input aria-label="New category name" placeholder="New category, e.g. Desserts" maxLength={60} value={newCat} onChange={(e) => setNewCat(e.target.value)} className={cx(inputClass, 'h-10 sm:h-11 min-w-0 flex-1')} />
          <Button type="submit" variant="secondary" icon={Plus} disabled={busy || !newCat.trim()} className="shrink-0">
            Add
          </Button>
        </form>
      </section>

      <section className="space-y-3 rounded-card bg-surface p-5 shadow-card" aria-label="Items">
        {cat && (
          <div className="space-y-3">
            {renaming !== null ? (
              <form onSubmit={(e) => void renameCategory(e)} className="flex gap-2">
                <input autoFocus aria-label="Category name" maxLength={60} value={renaming} onChange={(e) => setRenaming(e.target.value)} className={cx(inputClass, 'h-11')} />
                <Button type="submit" variant="primary" disabled={busy || !renaming.trim()}>
                  Save
                </Button>
                <Button variant="plain" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="mr-auto font-semibold">
                  {cat.name}
                  {!cat.isActive && <span className="ml-2 text-xs font-medium text-warning">Hidden from the order screen</span>}
                </h3>
                <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setRenaming(cat.name)}>
                  Rename
                </Button>
                <Button size="sm" variant="secondary" icon={cat.isActive ? EyeOff : Eye} disabled={busy} onClick={() => void run(() => api.updateCategory(cat.id, { isActive: !cat.isActive }), cat.isActive ? 'Category hidden' : 'Category shown')}>
                  {cat.isActive ? 'Hide' : 'Show'}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={Trash2}
                  disabled={busy}
                  onClick={() => {
                    if (armed !== `c${cat.id}`) return setArmed(`c${cat.id}`);
                    setArmed(null);
                    void run(() => api.deleteCategory(cat.id), 'Category deleted');
                  }}
                >
                  {armed === `c${cat.id}` ? 'Tap again to delete' : 'Delete'}
                </Button>
              </div>
            )}
            {cat.items.length > 0 && armed === `c${cat.id}` && <p className="text-sm text-ink-2">A category can only be deleted when it has no items. Hide it instead to keep the items.</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input type="search" aria-label="Search all items" placeholder="Search all items…" value={query} onChange={(e) => setQuery(e.target.value)} className={cx(inputClass, 'h-11 min-w-0 flex-1')} />
          <Button variant="primary" icon={Plus} disabled={!cat || editing === 'new'} onClick={() => startItem(null)}>
            Add item
          </Button>
        </div>

        {shownItems.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-2">{query ? 'No item matches.' : cat ? 'No items in this category yet.' : 'Add a category to start.'}</p>
        ) : (
          <ul ref={itemSort.containerRef} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {orderedItems.map((item, i) => (
              <li key={item.id} {...itemSort.itemProps(item.id)} className={cx('min-w-0', itemSort.itemProps(item.id).className)}>
                <button
                  type="button"
                  onClick={() => startItem(item)}
                  style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                  className={cx(
                    'animate-card-rise group flex h-full min-h-[132px] w-full flex-col rounded-[22px] bg-subtle p-3.5 text-left ring-1 ring-line transition-[background-color,box-shadow,transform] duration-200 hover:bg-surface hover:shadow-raised active:scale-[0.97]',
                    itemSort.draggingId === item.id && 'bg-surface ring-2 ring-accent',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <VegDot veg={item.isVeg} />
                    {!item.isAvailable && <span className="rounded-full bg-warning-tint px-2 py-0.5 text-[10px] font-bold text-warning">Sold out</span>}
                  </span>
                  <span className={cx('mt-2.5 line-clamp-2 text-[15px] leading-snug font-semibold', !item.isAvailable && 'text-ink-3')}>{item.name}</span>
                  {(item.description || query) && (
                    <span className="mt-1 line-clamp-2 text-xs text-ink-2">
                      {query && `${categoryName(item.categoryId)}${item.description ? ' · ' : ''}`}
                      {item.description}
                    </span>
                  )}
                  <span className="mt-auto flex items-center justify-between pt-3">
                    <span className="text-base font-bold tabular-nums">{formatPaise(item.pricePaise)}</span>
                    <ChevronRight size={16} className="text-ink-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-ink-2">Tap an item to edit it. To reorder, press and hold a card (or a category) for a moment, then drag it; the screen scrolls by itself near the top and bottom edge. Or use Move to top inside; the order screen follows this order. Changes apply to new orders. Bills and orders already made keep the name and price they were sold at.</p>
      </section>

      {editing !== null && (
        <BottomSheet
          key={String(editing)}
          title={editing === 'new' ? `New item in ${cat?.name ?? ''}` : (editingItem?.name ?? 'Item')}
          onClose={() => {
            setEditing(null);
            setArmed(null);
          }}
        >
          {editingItem && (
            <div className="mb-4 grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => api.updateMenuItem(editingItem.id, { isAvailable: !editingItem.isAvailable }))}
                className={cx(
                  'flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-xs font-semibold transition-all active:scale-95 disabled:opacity-50',
                  editingItem.isAvailable ? 'bg-success-tint text-success-hover' : 'bg-warning-tint text-warning',
                )}
              >
                {editingItem.isAvailable ? <Eye size={18} /> : <EyeOff size={18} />}
                {editingItem.isAvailable ? 'Available' : 'Sold out'}
              </button>
              <button
                type="button"
                disabled={busy || !!query || shownItems[0]?.id === editingItem.id}
                onClick={() => moveToTop(editingItem.id)}
                className="flex flex-col items-center gap-1 rounded-2xl bg-fill px-2 py-3 text-xs font-semibold text-ink-2 transition-all active:scale-95 disabled:opacity-40"
              >
                <ArrowUpToLine size={18} />
                Move to top
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (armed !== `i${editingItem.id}`) return setArmed(`i${editingItem.id}`);
                  setArmed(null);
                  void run(() => api.deleteMenuItem(editingItem.id), `“${editingItem.name}” deleted`).then((ok) => ok && setEditing(null));
                }}
                className={cx(
                  'flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-xs font-semibold transition-all active:scale-95 disabled:opacity-50',
                  armed === `i${editingItem.id}` ? 'bg-danger text-white' : 'bg-danger-tint text-danger',
                )}
              >
                <Trash2 size={18} />
                {armed === `i${editingItem.id}` ? 'Tap to confirm' : 'Delete'}
              </button>
            </div>
          )}
          {itemForm}
        </BottomSheet>
      )}
    </div>
  );
}
