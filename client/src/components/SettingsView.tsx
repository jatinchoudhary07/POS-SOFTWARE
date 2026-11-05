import {
  ChefHat,
  CircleAlert,
  ChevronRight,
  CircleCheck,
  ConciergeBell,
  DatabaseBackup,
  Info,
  KeyRound,
  LayoutGrid,
  Loader2,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  UtensilsCrossed,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { BackupInfo, LoginAccount, Role, Settings, TableTileDTO } from '../api/types';
import { formatBps, parsePercentToBps } from '../lib/amounts';
import { cx } from '../lib/cx';
import { useUser } from '../state/Auth';
import { ROLE_LABELS } from '../state/permissions';
import { MenuManager } from './MenuManager';
import { BottomSheet } from './ui/BottomSheet';
import { Button, IconButton } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';
import { useToast } from './ui/Toast';

type Tab = 'menu' | 'tables' | 'billing' | 'logins' | 'backups';

interface TaxRow {
  name: string;
  rate: string; // as typed, e.g. "2.5"
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-2">{hint}</span>}
    </label>
  );
}

const ROLE_ICONS: Record<Role, typeof ShieldCheck> = { SUPERADMIN: ShieldCheck, RECEPTION: ConciergeBell, KITCHEN: ChefHat };
const ROLE_TONES: Record<Role, string> = {
  SUPERADMIN: 'bg-orange-100 text-orange-600',
  RECEPTION: 'bg-sky-100 text-sky-600',
  KITCHEN: 'bg-emerald-100 text-emerald-600',
};
const ROLE_ACCESS: Record<Role, string> = {
  SUPERADMIN: 'Full access: settings, refunds, reports and logins',
  RECEPTION: 'Orders, checkout, payments, receipts and today’s sales',
  KITCHEN: 'Kitchen display only, no prices',
};
const ROLE_HINTS: Record<Role, string> = {
  SUPERADMIN: 'Everything, including settings, refunds and these logins. At least 6 characters — longer is safer.',
  RECEPTION: 'Orders, checkout, payments, receipts and today’s sales. At least 6 characters (a PIN is fine).',
  KITCHEN: 'Kitchen display only. At least 6 characters (a PIN is fine).',
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Automatic backups: status, recent files and a manual "Back up now". */
function BackupsSection() {
  const toast = useToast();
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.getBackups().then(setInfo).catch(() => setInfo({ enabled: false }));
  useEffect(() => {
    void load();
  }, []);

  async function backupNow() {
    setBusy(true);
    try {
      const r = await api.backupNow();
      toast({ tone: 'success', title: 'Backup saved', description: r.file?.name });
    } catch (e) {
      toast({ tone: 'error', title: 'Backup failed', description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setBusy(false);
      void load();
    }
  }

  const st = info?.status;
  const stale = st?.lastSuccess && Date.now() - Date.parse(st.lastSuccess.at) > Math.max(2, st.intervalHours * 3) * 3600_000;
  return (
    <section className="space-y-3 rounded-card bg-surface p-5 shadow-card" aria-label="Backups">
      <div className="flex items-center gap-3">
        <h3 className="font-semibold">Backups</h3>
        <Button size="sm" variant="secondary" icon={DatabaseBackup} loading={busy} disabled={busy || !info?.enabled} onClick={() => void backupNow()} className="ml-auto">
          Back up now
        </Button>
      </div>
      {!info ? (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
        </p>
      ) : !info.enabled || !st ? (
        <p className="text-sm text-danger">Automatic backups are not running on this server.</p>
      ) : (
        <>
          {st.lastError && (!st.lastSuccess || st.lastError.at > st.lastSuccess.at) ? (
            <p role="alert" className="flex gap-2 rounded-control bg-danger-tint p-3 text-sm text-danger">
              <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <strong>The last backup failed</strong> ({when(st.lastError.at)}): {st.lastError.message}
              </span>
            </p>
          ) : st.lastSuccess ? (
            <p className={cx('flex gap-2 rounded-control p-3 text-sm', stale ? 'bg-warning-tint text-warning' : 'bg-success-tint text-success')}>
              <CircleCheck size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                Last backup {when(st.lastSuccess.at)} ({Math.ceil(st.lastSuccess.sizeBytes / 1024)} KB, checked).
                {stale && ' That is a while ago — check that the server is running normally.'}
              </span>
            </p>
          ) : (
            <p className="text-sm text-ink-2">No backup has been made since the server started.</p>
          )}
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-ink-2">Folder (on the reception PC)</dt>
            <dd className="font-mono text-[13px] break-all">{st.dir}</dd>
            <dt className="text-ink-2">Schedule</dt>
            <dd>
              Every {st.intervalHours} h when something changed, at start-up, before Superadmin changes and at shutdown
            </dd>
            <dt className="text-ink-2">Kept</dt>
            <dd>
              Everything from the last 48 h, then one per day for {st.keepDays} days (never fewer than {st.minKeep}). {st.count} backups now.
            </dd>
          </dl>
          {info.files && info.files.length > 0 && (
            <ul className="divide-y divide-line rounded-control bg-subtle text-sm">
              {info.files.slice(0, 5).map((f) => (
                <li key={f.name} className="flex justify-between gap-3 px-3 py-2">
                  <span className="truncate font-mono text-[13px]">{f.name}</span>
                  <span className="shrink-0 text-ink-2 tabular-nums">{Math.ceil(f.sizeBytes / 1024)} KB</span>
                </li>
              ))}
            </ul>
          )}
          <p className="flex gap-2 text-sm text-ink-2">
            <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
            Backups on this PC don’t help if the PC is stolen or its disk fails. Copy the folder to a USB drive (ideally encrypted) at
            least weekly and keep it somewhere else — see “Backups” in the setup guide.
          </p>
        </>
      )}
    </section>
  );
}

/** The three logins. Changing one signs it out on every screen. */
function LoginsSection() {
  const toast = useToast();
  const me = useUser();
  const [accounts, setAccounts] = useState<LoginAccount[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState<Role>('RECEPTION');
  const [isActive, setIsActive] = useState(true);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    api.listAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  const sheetAccount = typeof editing === 'number' ? (accounts?.find((a) => a.id === editing) ?? null) : null;
  const sheetOpen = adding || sheetAccount !== null;

  function reset(a: LoginAccount | null) {
    setUsername(a?.username ?? '');
    setPassword('');
    setConfirm('');
    setCurrent('');
    setError(null);
    setRole(a?.role ?? 'RECEPTION');
    setIsActive(a?.isActive ?? true);
    setArmed(false);
  }

  function openExisting(a: LoginAccount) {
    reset(a);
    setAdding(false);
    setEditing(a.id);
  }

  function openNew() {
    reset(null);
    setEditing(null);
    setAdding(true);
  }

  function closeSheet() {
    setAdding(false);
    setEditing(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('The new passwords do not match');
    setBusy(true);
    setError(null);
    try {
      if (sheetAccount) {
        const body: Parameters<typeof api.updateAccount>[1] = { currentPassword: current };
        if (username.trim() && username.trim() !== sheetAccount.username) body.username = username.trim();
        if (password) body.password = password;
        if (role !== sheetAccount.role) body.role = role;
        if (isActive !== sheetAccount.isActive) body.isActive = isActive;
        if (Object.keys(body).length === 1) return setError('Nothing to change');
        const r = await api.updateAccount(sheetAccount.id, body);
        setAccounts(r.accounts);
        toast({ tone: 'success', title: `${r.account.username} saved`, description: 'Screens using this login were signed out.' });
      } else {
        if (!password) return setError('Enter a password for the new login');
        const r = await api.createAccount({ role, username: username.trim(), password, currentPassword: current });
        setAccounts(r.accounts);
        toast({ tone: 'success', title: `${r.account.username} added`, description: `New ${ROLE_LABELS[r.account.role]} login.` });
      }
      closeSheet();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: LoginAccount) {
    if (!armed) return setArmed(true);
    if (!current) return setError('Enter your current password to confirm');
    setBusy(true);
    setError(null);
    try {
      setAccounts((await api.deleteAccount(a.id, current)).accounts);
      toast({ tone: 'success', title: `${a.username} deleted` });
      closeSheet();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  }

  const counts = (r: Role) => accounts?.filter((a) => a.role === r).length ?? 0;

  return (
    <section className="space-y-4 rounded-card bg-surface p-4 shadow-card sm:p-5" aria-label="Logins">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold">My team</h3>
          <p className="text-sm text-ink-2">
            {accounts ? `${accounts.length} logins · ${counts('SUPERADMIN')} Superadmin · ${counts('RECEPTION')} Reception · ${counts('KITCHEN')} Kitchen` : 'Loading…'}
          </p>
        </div>
        <Button variant="primary" icon={Plus} onClick={openNew} disabled={!accounts}>
          Add login
        </Button>
      </div>

      {!accounts ? (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a, i) => {
            const Icon = ROLE_ICONS[a.role];
            return (
              <li key={a.id} className="animate-card-rise min-w-0" style={{ animationDelay: `${Math.min(i, 10) * 55}ms` }}>
                <button
                  type="button"
                  onClick={() => openExisting(a)}
                  className={cx(
                    'group flex h-full w-full flex-col rounded-[24px] bg-subtle p-4 text-left ring-1 ring-line transition-all duration-200 hover:-translate-y-0.5 hover:bg-surface hover:shadow-raised active:scale-[0.98]',
                    !a.isActive && 'opacity-60',
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className={cx('flex h-12 w-12 items-center justify-center rounded-2xl transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105', ROLE_TONES[a.role])}>
                      <Icon size={22} aria-hidden />
                    </span>
                    <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-bold', a.isActive ? 'bg-success-tint text-success-hover' : 'bg-fill text-ink-3')}>
                      {a.isActive ? 'Active' : 'Turned off'}
                    </span>
                  </span>
                  <span className="mt-3 flex items-center gap-2">
                    <span className="min-w-0 truncate text-base font-bold tracking-tight">{a.username}</span>
                    {a.id === me.id && <span className="shrink-0 rounded-full bg-accent-tint px-2 py-0.5 text-[10px] font-bold text-accent">You</span>}
                  </span>
                  <span className="mt-0.5 text-sm font-medium text-ink-2">{ROLE_LABELS[a.role]}</span>
                  <span className="mt-2 line-clamp-2 text-xs text-ink-3">{ROLE_ACCESS[a.role]}</span>
                  <span className="mt-auto flex items-center justify-between pt-3 text-xs font-semibold text-accent">
                    Manage
                    <ChevronRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {sheetOpen && (
        <BottomSheet key={sheetAccount?.id ?? 'new'} title={sheetAccount ? sheetAccount.username : 'Add a login'} onClose={closeSheet}>
          <form onSubmit={(e) => void save(e)} className="space-y-3 pt-1">
            <div>
              <span className={labelClass}>Role</span>
              <div role="radiogroup" aria-label="Role" className="grid grid-cols-3 gap-2">
                {(['SUPERADMIN', 'RECEPTION', 'KITCHEN'] as const).map((r) => {
                  const RIcon = ROLE_ICONS[r];
                  const on = role === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={sheetAccount?.id === me.id && r !== sheetAccount.role}
                      onClick={() => setRole(r)}
                      className={cx(
                        'flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-xs font-semibold ring-1 transition-all active:scale-95 disabled:opacity-40',
                        on ? 'bg-accent-tint text-accent ring-accent' : 'bg-subtle text-ink-2 ring-line hover:text-ink',
                      )}
                    >
                      <RIcon size={18} aria-hidden />
                      {ROLE_LABELS[r]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-ink-2">{ROLE_HINTS[role]}</p>
            </div>

            {sheetAccount && sheetAccount.id !== me.id && (
              <button
                type="button"
                onClick={() => setIsActive((v) => !v)}
                className={cx('flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition-all active:scale-[0.98]', isActive ? 'bg-success-tint' : 'bg-fill')}
              >
                <span>
                  <span className="block text-sm font-semibold">{isActive ? 'Active' : 'Turned off'}</span>
                  <span className="block text-xs text-ink-2">{isActive ? 'Can sign in.' : 'Cannot sign in until turned back on.'}</span>
                </span>
                <span className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', isActive ? 'bg-success' : 'bg-line-strong')} aria-hidden>
                  <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', isActive ? 'left-[22px]' : 'left-0.5')} />
                </span>
              </button>
            )}

            <Field label="Username (name, email or mobile)">
              <input autoFocus={!sheetAccount} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className={cx(inputClass, 'h-11')} />
            </Field>
            <Field label={sheetAccount ? 'New password (leave empty to keep)' : 'Password'}>
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={cx(inputClass, 'h-11')} />
            </Field>
            <Field label="Repeat password">
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={cx(inputClass, 'h-11')} />
            </Field>
            <Field label="Your current password (to confirm)">
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={cx(inputClass, 'h-11')} />
            </Field>
            {error && (
              <p role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-sm font-medium text-danger">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              {sheetAccount && sheetAccount.id !== me.id && (
                <Button size="sm" variant={armed ? 'danger' : 'plain'} icon={Trash2} disabled={busy} onClick={() => void remove(sheetAccount)} className={armed ? '' : 'text-danger'}>
                  {armed ? 'Tap again to delete' : 'Delete'}
                </Button>
              )}
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="plain" onClick={closeSheet}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" type="submit" loading={busy} disabled={busy || !current || (!sheetAccount && !username.trim())}>
                  {sheetAccount ? 'Save' : 'Add login'}
                </Button>
              </span>
            </div>
          </form>
        </BottomSheet>
      )}
    </section>
  );
}

function TablesManagerSection() {
  const toast = useToast();
  const [tables, setTables] = useState<TableTileDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newCapacity, setNewCapacity] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editCapacity, setEditCapacity] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getTableOverview();
      setTables(res);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not load tables', description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const cap = newCapacity ? parseInt(newCapacity, 10) : null;
      await api.createTable({ name, capacity: Number.isFinite(cap) && cap! > 0 ? cap : null });
      toast({ tone: 'success', title: `Table "${name}" created` });
      setNewName('');
      setNewCapacity('');
      setAdding(false);
      void load();
    } catch (e) {
      toast({ tone: 'error', title: 'Could not create table', description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdate(id: number) {
    const name = editName.trim();
    if (!name) return;
    setSavingEdit(true);
    try {
      const cap = editCapacity ? parseInt(editCapacity, 10) : null;
      await api.updateTable(id, { name, capacity: Number.isFinite(cap) && cap! > 0 ? cap : null });
      toast({ tone: 'success', title: 'Table updated' });
      setEditingId(null);
      void load();
    } catch (e) {
      toast({ tone: 'error', title: 'Could not update table', description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleToggleActive(t: TableTileDTO, force = false) {
    setDeactivatingId(t.id);
    try {
      await api.updateTable(t.id, { isActive: !t.isActive, force });
      toast({ tone: 'success', title: `Table "${t.name}" ${t.isActive ? 'deactivated' : 'activated'}` });
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TABLE_HAS_UNSETTLED_ORDERS') {
        const confirmed = window.confirm(
          `Table "${t.name}" has active unsettled orders (${t.activeOrderCount} unpaid). Deactivating will hide it from future orders, but keep existing orders. Force deactivate?`,
        );
        if (confirmed) {
          void handleToggleActive(t, true);
        }
      } else {
        toast({ tone: 'error', title: 'Failed to update table', description: e instanceof ApiError ? e.message : undefined });
      }
    } finally {
      setDeactivatingId(null);
    }
  }

  const sheetOpen = adding || editingId !== null;
  const editingTable = editingId !== null ? (tables.find((t) => t.id === editingId) ?? null) : null;
  const closeSheet = () => {
    setAdding(false);
    setEditingId(null);
  };
  const activeCount = tables.filter((t) => t.isActive).length;

  return (
    <div className="space-y-4">
      <section className="rounded-card bg-surface p-4 shadow-card sm:p-5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-ink">Tables</h3>
            <p className="text-sm text-ink-2">
              {tables.length} total · {activeCount} active
            </p>
          </div>
          <IconButton icon={RefreshCw} variant="secondary" aria-label="Refresh tables" onClick={() => void load()} disabled={loading} className={loading ? 'animate-spin' : ''} />
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => {
              setNewName('');
              setNewCapacity('');
              setAdding(true);
            }}
          >
            Add table
          </Button>
        </div>

        {loading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-ink-2">
            <Loader2 size={18} className="animate-spin text-accent" /> Loading tables...
          </div>
        ) : tables.length === 0 ? (
          <div className="mt-4 rounded-[22px] border border-dashed border-line p-8 text-center text-sm text-ink-2">No tables yet. Tap “Add table” to create your first one.</div>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {tables.map((t, i) => (
              <li key={t.id} className="animate-card-rise min-w-0" style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(t.id);
                    setEditName(t.name);
                    setEditCapacity(t.capacity ? String(t.capacity) : '');
                  }}
                  className={cx(
                    'group flex h-full min-h-[128px] w-full flex-col rounded-[22px] bg-subtle p-3.5 text-left ring-1 ring-line transition-all duration-200 hover:-translate-y-0.5 hover:bg-surface hover:shadow-raised active:scale-[0.97]',
                    !t.isActive && 'opacity-60',
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-tint text-accent transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105">
                      <LayoutGrid size={20} aria-hidden />
                    </span>
                    <span className={cx('rounded-full px-2 py-0.5 text-[10px] font-bold', t.isActive ? 'bg-success-tint text-success-hover' : 'bg-fill text-ink-3')}>
                      {t.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </span>
                  <span className="mt-2.5 truncate text-lg font-bold tracking-tight">{t.name}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-2 text-xs text-ink-2">
                    <span className="inline-flex items-center gap-1">
                      <Users size={13} aria-hidden /> {t.capacity ? `${t.capacity} seats` : 'No seat count'}
                    </span>
                    {t.status === 'OCCUPIED' && (
                      <span className="rounded-full bg-warning-tint px-2 py-0.5 text-[10px] font-bold text-warning">{t.activeOrderCount} unpaid</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sheetOpen && (
        <BottomSheet key={editingId ?? 'new'} title={editingTable ? `Table ${editingTable.name}` : 'Add a table'} onClose={closeSheet}>
          {editingTable && (
            <button
              type="button"
              disabled={deactivatingId === editingTable.id}
              onClick={() => void handleToggleActive(editingTable)}
              className={cx(
                'mb-4 flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition-all active:scale-[0.98] disabled:opacity-60',
                editingTable.isActive ? 'bg-success-tint' : 'bg-fill',
              )}
            >
              <span>
                <span className="block text-sm font-semibold">{editingTable.isActive ? 'Active' : 'Inactive'}</span>
                <span className="block text-xs text-ink-2">{editingTable.isActive ? 'Shown on the order screen. Tap to deactivate.' : 'Hidden from new orders. Tap to activate.'}</span>
              </span>
              {deactivatingId === editingTable.id ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <span className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', editingTable.isActive ? 'bg-success' : 'bg-line-strong')} aria-hidden>
                  <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', editingTable.isActive ? 'left-[22px]' : 'left-0.5')} />
                </span>
              )}
            </button>
          )}
          <form
            onSubmit={(e) => {
              if (editingTable) {
                e.preventDefault();
                void handleUpdate(editingTable.id);
              } else void handleCreate(e);
            }}
            className="space-y-3 pt-1"
          >
            <label className="block">
              <span className={labelClass}>Table name / number</span>
              <input
                autoFocus
                required
                maxLength={20}
                placeholder="e.g. T1 or Patio 1"
                value={editingTable ? editName : newName}
                onChange={(e) => (editingTable ? setEditName(e.target.value) : setNewName(e.target.value))}
                className={cx(inputClass, 'h-11')}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Seats (optional)</span>
              <input
                type="number"
                min={1}
                max={100}
                placeholder="e.g. 4"
                value={editingTable ? editCapacity : newCapacity}
                onChange={(e) => (editingTable ? setEditCapacity(e.target.value) : setNewCapacity(e.target.value))}
                className={cx(inputClass, 'h-11')}
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="plain" onClick={closeSheet}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" icon={editingTable ? undefined : Plus} loading={editingTable ? savingEdit : creating} disabled={!(editingTable ? editName : newName).trim() || creating || savingEdit}>
                {editingTable ? 'Save changes' : 'Add table'}
              </Button>
            </div>
          </form>
        </BottomSheet>
      )}
    </div>
  );
}

export function SettingsView() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<Omit<Settings, 'taxes' | 'configured'> | null>(null);
  const [taxes, setTaxes] = useState<TaxRow[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('menu');
  const [errors, setErrors] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        const { taxes: t, configured: _c, ...rest } = s;
        setForm(rest);
        setTaxes(t.map((x) => ({ name: x.name, rate: formatBps(x.rateBps).replace('%', '') })));
      })
      .catch((e) => setErrors(e instanceof ApiError ? e.message : 'Could not load settings'));
    api.getTables().then((r) => setTables(r.tables)).catch(() => undefined);
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const parsed = taxes.map((t) => ({ name: t.name.trim(), rateBps: parsePercentToBps(t.rate) }));
    const bad = parsed.find((t) => !t.name || t.rateBps === null);
    if (bad) return setErrors('Every tax line needs a name and a rate like 2.5 (max 2 decimals).');
    const names = tables.map((t) => t.trim()).filter(Boolean);
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return setErrors('Each table needs a different name.');
    setSaving(true);
    setErrors(null);
    try {
      setTables(await api.saveTables(names));
      const s = await api.saveSettings({ ...form, taxes: parsed.map((t) => ({ name: t.name, rateBps: t.rateBps! })) });
      setSettings(s);
      toast({ tone: 'success', title: 'Settings saved', description: 'New bills and orders use these settings. Paid bills are not changed.' });
    } catch (err) {
      setErrors(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const set = <K extends keyof NonNullable<typeof form>>(k: K, v: NonNullable<typeof form>[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const sections = [
    { value: 'menu' as const, label: 'Menu', hint: 'Items, prices, categories', icon: UtensilsCrossed },
    { value: 'tables' as const, label: 'Tables & Floor Plan', hint: 'Dining tables, seating & status', icon: LayoutGrid },
    { value: 'billing' as const, label: 'Receipt & taxes', hint: 'Bill details and taxes', icon: ReceiptText },
    { value: 'logins' as const, label: 'Logins', hint: 'Usernames and passwords', icon: KeyRound },
    { value: 'backups' as const, label: 'Backups', hint: 'Data safety', icon: DatabaseBackup },
  ];

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-x-hidden md:flex-row">
      {/* Left: the settings sections (a tab strip on phones). */}
      <aside className="w-full shrink-0 border-b border-line bg-surface md:w-64 md:overflow-y-auto md:border-r md:border-b-0 lg:w-72">
        <h2 className="px-4 pt-3.5 pb-2 text-lg font-semibold tracking-tight sm:text-xl md:px-5 md:pt-5 md:pb-3">Settings</h2>
        <nav aria-label="Settings sections" className="no-scrollbar flex w-full min-w-0 max-w-full gap-1.5 overflow-x-auto px-3.5 pb-2.5 md:flex-col md:overflow-visible md:pb-5">
          {sections.map((sec) => {
            const Icon = sec.icon;
            const active = sec.value === tab;
            return (
              <button
                key={sec.value}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setTab(sec.value)}
                className={cx(
                  'flex shrink-0 items-center gap-2.5 rounded-control px-3 py-2 text-left transition-colors sm:gap-3 sm:py-2.5 md:w-full',
                  active ? 'bg-accent-tint text-accent-hover' : 'text-ink-2 hover:bg-fill hover:text-ink',
                )}
              >
                <Icon size={18} className="shrink-0" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold whitespace-nowrap sm:text-[15px] md:whitespace-normal">{sec.label}</span>
                  <span className="hidden text-xs opacity-80 md:block">{sec.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Right: the chosen section, using the full width beside the sidebar. */}
      <div className="min-h-0 min-w-0 w-full max-w-full flex-1 overflow-y-auto overflow-x-hidden">
        <div className="w-full max-w-full px-3.5 py-4 pb-24 sm:px-4 md:pb-8 lg:px-6 xl:px-8">
          <h3 className="mb-4 text-lg font-semibold tracking-tight">{sections.find((x) => x.value === tab)?.label}</h3>
      {tab === 'menu' ? (
        <div className="animate-enter">
          <MenuManager />
        </div>
      ) : tab === 'tables' ? (
        <div className="animate-enter">
          <TablesManagerSection />
        </div>
      ) : tab === 'logins' ? (
        <div className="animate-enter">
          <LoginsSection />
        </div>
      ) : tab === 'backups' ? (
        <div className="animate-enter">
          <BackupsSection />
        </div>
      ) : !form ? (
        <p className="flex items-center justify-center gap-2 py-20 text-ink-2">
          {errors ?? (
            <>
              <Loader2 size={18} className="animate-spin" aria-hidden /> Loading…
            </>
          )}
        </p>
      ) : (
        <div className="animate-enter space-y-4">
        <form onSubmit={save} className="space-y-4">
          <section className="space-y-4 rounded-card bg-surface p-5 shadow-card">
            <h3 className="font-semibold">Receipt details</h3>
            <Field label="Restaurant name">
              <input required maxLength={80} value={form.restaurantName} onChange={(e) => set('restaurantName', e.target.value)} className={cx(inputClass, 'h-11')} />
            </Field>
            <Field label="Address">
              <input maxLength={160} value={form.addressLine ?? ''} onChange={(e) => set('addressLine', e.target.value)} className={cx(inputClass, 'h-11')} />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Phone">
                <input maxLength={40} value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} className={cx(inputClass, 'h-11')} />
              </Field>
              <Field label="GSTIN / tax ID (optional)" hint="Printed as entered. Not validated by this app.">
                <input maxLength={40} value={form.taxId ?? ''} onChange={(e) => set('taxId', e.target.value)} className={cx(inputClass, 'h-11')} />
              </Field>
            </div>
            <Field label="Receipt footer">
              <input maxLength={160} value={form.receiptFooter ?? ''} onChange={(e) => set('receiptFooter', e.target.value)} placeholder="Thank you! Visit again." className={cx(inputClass, 'h-11')} />
            </Field>
          </section>

          <section className="space-y-4 rounded-card bg-surface p-5 shadow-card">
            <h3 className="font-semibold">Taxes</h3>
            <p className="flex gap-2 rounded-control bg-accent-tint p-3 text-sm text-accent-hover">
              <Info size={18} className="mt-0.5 shrink-0" aria-hidden />
              Enter the tax rates that apply to your business — this app does not decide them and does not make your bills tax-compliant.
              Taxes are added on top of menu prices after any discount, each line rounded to the nearest paisa (half up).
            </p>
            {taxes.length === 0 && <p className="text-sm text-ink-2">No taxes: bills show the subtotal as the total.</p>}
            {taxes.map((t, i) => (
              <div key={i} className="flex items-end gap-2">
                <Field label={i === 0 ? 'Name' : ''}>
                  <input
                    aria-label={`Tax ${i + 1} name`}
                    value={t.name}
                    maxLength={30}
                    placeholder="e.g. CGST"
                    onChange={(e) => setTaxes((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                    className={cx(inputClass, 'h-11')}
                  />
                </Field>
                <Field label={i === 0 ? 'Rate %' : ''}>
                  <input
                    aria-label={`Tax ${i + 1} rate in percent`}
                    value={t.rate}
                    inputMode="decimal"
                    placeholder="2.5"
                    onChange={(e) => setTaxes((rows) => rows.map((r, j) => (j === i ? { ...r, rate: e.target.value } : r)))}
                    className={cx(inputClass, 'h-11 w-28')}
                  />
                </Field>
                <IconButton icon={Trash2} variant="plain" aria-label={`Remove tax ${i + 1}`} onClick={() => setTaxes((rows) => rows.filter((_, j) => j !== i))} />
              </div>
            ))}
            {taxes.length < 5 && (
              <Button size="sm" variant="secondary" icon={Plus} onClick={() => setTaxes((rows) => [...rows, { name: '', rate: '' }])}>
                Add tax line
              </Button>
            )}
            <label className="flex items-start gap-3 pt-2 text-[15px]">
              <input type="checkbox" checked={form.roundToRupee} onChange={(e) => set('roundToRupee', e.target.checked)} className="mt-0.5 h-5 w-5 accent-[var(--color-accent)]" />
              <span>
                Round bill totals to the nearest rupee
                <span className="block text-sm text-ink-2">Adds a “Round off” line (−₹0.49 to +₹0.50).</span>
              </span>
            </label>
          </section>

          <section className="space-y-4 rounded-card bg-surface p-5 shadow-card">
            <h3 className="font-semibold">Tables</h3>
            <p className="text-sm text-ink-2">
              The tables your dining room has. When there are any, taking a dine-in order shows a table list instead of a blank box. Old orders keep the table they were taken with.
            </p>
            {tables.length === 0 && <p className="text-sm text-ink-2">No tables set up: staff type the table number by hand.</p>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {tables.map((t, i) => (
                <div key={i} className="flex items-center gap-1">
                  <input
                    aria-label={`Table ${i + 1} name`}
                    value={t}
                    maxLength={10}
                    onChange={(e) => setTables((rows) => rows.map((r, j) => (j === i ? e.target.value : r)))}
                    className={cx(inputClass, 'h-11 min-w-0')}
                  />
                  <IconButton icon={Trash2} variant="plain" aria-label={`Remove table ${t || i + 1}`} onClick={() => setTables((rows) => rows.filter((_, j) => j !== i))} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={Plus} disabled={tables.length >= 100} onClick={() => setTables((rows) => [...rows, String(rows.length + 1)])}>
                Add table
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={tables.length >= 100}
                onClick={() => {
                  const n = Number(window.prompt('How many tables? They are named 1, 2, 3…', '10'));
                  if (Number.isInteger(n) && n >= 1 && n <= 100) setTables(Array.from({ length: n }, (_, i) => String(i + 1)));
                }}
              >
                Number them 1…N
              </Button>
            </div>
          </section>

          {errors && <p className="text-sm font-medium text-danger">{errors}</p>}
          <div className="flex items-center justify-end gap-3">
            {settings && !settings.configured && <span className="text-sm text-ink-2">Not saved yet — defaults in use.</span>}
            <Button type="submit" size="lg" variant="primary" loading={saving}>
              Save settings
            </Button>
          </div>
        </form>
        </div>
      )}
        </div>
      </div>
    </div>
  );
}
