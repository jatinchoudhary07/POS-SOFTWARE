import {
  ChefHat,
  ChevronRight,
  UserPlus,
  EyeOff,
  Eye,
  CircleCheck,
  CircleAlert,
  ConciergeBell,
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
import type { LoginAccount, Role, Settings, TableTileDTO } from '../api/types';
import { formatBps, parsePercentToBps } from '../lib/amounts';
import { cx } from '../lib/cx';
import { useUser } from '../state/Auth';
import { ROLE_LABELS } from '../state/permissions';
import { MenuManager } from './MenuManager';
import { BottomSheet } from './ui/BottomSheet';
import { Button, IconButton } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';
import { useToast } from './ui/Toast';

type Tab = 'menu' | 'tables' | 'billing' | 'logins';

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
const ROLE_HINTS: Record<Role, string> = {
  SUPERADMIN: 'Everything, including settings, refunds and these logins. At least 6 characters — longer is safer.',
  RECEPTION: 'Orders, checkout, payments, receipts and today’s sales. At least 6 characters (a PIN is fine).',
  KITCHEN: 'Kitchen display only. At least 6 characters (a PIN is fine).',
};

const ROLE_ORDER: Role[] = ['SUPERADMIN', 'RECEPTION', 'KITCHEN'];
const ROLE_GROUP_TITLES: Record<Role, string> = { SUPERADMIN: 'Owners', RECEPTION: 'Reception', KITCHEN: 'Kitchen' };
const MIN_PASSWORD = 6;

/** Password box with a show/hide button. */
function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete = 'new-password',
  autoFocus,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(inputClass, 'h-12 pr-12', invalid && 'shadow-[0_0_0_2px_var(--color-danger)]')}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute top-1/2 right-1.5 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-fill hover:text-ink"
      >
        {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
    </span>
  );
}

/** Round badge with the person's first letter, coloured by role. */
function Avatar({ account, size = 'md' }: { account: Pick<LoginAccount, 'username' | 'role'>; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex shrink-0 items-center justify-center rounded-full font-extrabold uppercase',
        size === 'lg' ? 'h-14 w-14 text-xl' : 'h-11 w-11 text-base',
        ROLE_TONES[account.role],
      )}
    >
      {account.username.trim().charAt(0) || '?'}
    </span>
  );
}

function RolePicker({ value, onChange, lockedTo }: { value: Role; onChange: (r: Role) => void; lockedTo?: Role }) {
  return (
    <div>
      <span className={labelClass}>Role</span>
      <div role="radiogroup" aria-label="Role" className="grid grid-cols-3 gap-2">
        {ROLE_ORDER.map((r) => {
          const RIcon = ROLE_ICONS[r];
          const on = value === r;
          return (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={lockedTo !== undefined && r !== lockedTo}
              onClick={() => onChange(r)}
              className={cx(
                'flex flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-xs font-semibold ring-1 transition-all active:scale-95 disabled:opacity-40',
                on ? 'bg-accent-tint text-accent ring-2 ring-accent' : 'bg-subtle text-ink-2 ring-line hover:text-ink',
              )}
            >
              <RIcon size={20} aria-hidden />
              {ROLE_LABELS[r]}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-2">{ROLE_HINTS[value]}</p>
    </div>
  );
}

/** New password + repeat, with a live "do they match" line. Returns whether the pair is acceptable. */
function PasswordPair({
  password,
  confirm,
  onPassword,
  onConfirm,
  optional,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  optional?: boolean;
}) {
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && password !== confirm;
  return (
    <>
      <Field label={optional ? 'New password (leave empty to keep the current one)' : 'Password'}>
        <PasswordInput value={password} onChange={onPassword} placeholder={`At least ${MIN_PASSWORD} characters`} invalid={tooShort} />
        {tooShort && <span className="mt-1 block text-xs font-medium text-danger">Use at least {MIN_PASSWORD} characters.</span>}
      </Field>
      <Field label="Confirm password">
        <PasswordInput value={confirm} onChange={onConfirm} placeholder="Type it again" invalid={mismatch} />
        {mismatch ? (
          <span className="mt-1 flex items-center gap-1 text-xs font-medium text-danger">
            <CircleAlert size={13} aria-hidden /> The passwords do not match.
          </span>
        ) : password.length >= MIN_PASSWORD && confirm === password ? (
          <span className="mt-1 flex items-center gap-1 text-xs font-medium text-success-hover">
            <CircleCheck size={13} aria-hidden /> Passwords match.
          </span>
        ) : null}
      </Field>
    </>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="flex items-start gap-2 rounded-2xl bg-danger-tint px-3.5 py-2.5 text-sm font-medium text-danger">
      <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {message}
    </p>
  ) : null;
}

/** Adds a login. No owner password is needed: just who it is and the password they will use. */
function AddLoginSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (accounts: LoginAccount[], added: LoginAccount) => void }) {
  const [role, setRole] = useState<Role>('RECEPTION');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = !busy && username.trim().length >= 3 && password.length >= MIN_PASSWORD && password === confirm;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createAccount({ role, username: username.trim(), password });
      onAdded(r.accounts, r.account);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the login');
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet title="Add a login" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4 pt-1">
        <RolePicker value={role} onChange={setRole} />
        <Field label="Username (name, email or mobile number)">
          <input
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="e.g. rahul or 9876543210"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={cx(inputClass, 'h-12')}
          />
        </Field>
        <PasswordPair password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
        <ErrorLine message={error} />
        <Button type="submit" size="lg" variant="primary" icon={UserPlus} loading={busy} disabled={!canSubmit} className="w-full">
          Add login
        </Button>
      </form>
    </BottomSheet>
  );
}

/** Edit a login (asks for the owner's own password when saving a change) or delete it (red icon, then confirm). */
function ManageLoginSheet({
  account,
  isMe,
  onClose,
  onChanged,
}: {
  account: LoginAccount;
  isMe: boolean;
  onClose: () => void;
  onChanged: (accounts: LoginAccount[], message: { title: string; description?: string }) => void;
}) {
  const [mode, setMode] = useState<'edit' | 'delete'>('edit');
  const [role, setRole] = useState<Role>(account.role);
  const [isActive, setIsActive] = useState(account.isActive);
  const [username, setUsername] = useState(account.username);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [current, setCurrent] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usernameChanged = username.trim() !== '' && username.trim() !== account.username;
  const dirty = usernameChanged || password.length > 0 || role !== account.role || isActive !== account.isActive;
  const passwordOk = password.length === 0 || (password.length >= MIN_PASSWORD && password === confirm);
  const canSave = !busy && dirty && passwordOk && current.length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const body: Parameters<typeof api.updateAccount>[1] = { currentPassword: current };
      if (usernameChanged) body.username = username.trim();
      if (password) body.password = password;
      if (role !== account.role) body.role = role;
      if (isActive !== account.isActive) body.isActive = isActive;
      const r = await api.updateAccount(account.id, body);
      onChanged(r.accounts, { title: `${r.account.username} saved`, description: 'Screens using this login were signed out.' });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (busy || !deletePassword) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.deleteAccount(account.id, deletePassword);
      onChanged(r.accounts, { title: `${account.username} deleted` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'delete') {
    return (
      <BottomSheet title="Delete login" onClose={onClose}>
        <form onSubmit={(e) => void remove(e)} className="space-y-4 pt-1 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-danger-tint text-danger">
            <Trash2 size={28} aria-hidden />
          </span>
          <div>
            <h4 className="text-xl font-extrabold tracking-tight">Delete “{account.username}”?</h4>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
              This {ROLE_LABELS[account.role]} login will be signed out right away and can never sign in again. This cannot be undone.
            </p>
          </div>
          <div className="text-left">
            <Field label="Enter your password to confirm">
              <PasswordInput value={deletePassword} onChange={setDeletePassword} autoComplete="current-password" autoFocus placeholder="Your own password" />
            </Field>
          </div>
          <ErrorLine message={error} />
          <button
            type="submit"
            disabled={busy || !deletePassword}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-control bg-danger font-semibold text-white shadow-control transition-all hover:brightness-95 active:scale-[0.98] disabled:bg-fill-strong disabled:text-ink-3 disabled:shadow-none"
          >
            {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Trash2 size={18} aria-hidden />} Delete login
          </button>
          <Button size="lg" variant="plain" className="w-full" onClick={() => { setMode('edit'); setError(null); setDeletePassword(''); }}>
            Keep this login
          </Button>
        </form>
      </BottomSheet>
    );
  }

  return (
    <BottomSheet title="Manage login" onClose={onClose}>
      <form onSubmit={(e) => void save(e)} className="space-y-4 pt-1">
        <div className="flex items-center gap-3">
          <Avatar account={account} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="truncate text-lg font-extrabold tracking-tight">{account.username}</span>
              {isMe && <span className="shrink-0 rounded-full bg-accent-tint px-2 py-0.5 text-[10px] font-bold text-accent">You</span>}
            </p>
            <p className="text-sm font-medium text-ink-2">
              {ROLE_LABELS[account.role]} · {account.isActive ? 'Active' : 'Turned off'}
            </p>
          </div>
          {!isMe && (
            <button
              type="button"
              aria-label={`Delete ${account.username}`}
              title="Delete this login"
              onClick={() => {
                setMode('delete');
                setError(null);
              }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-danger-tint text-danger transition-all hover:bg-danger hover:text-white active:scale-90"
            >
              <Trash2 size={20} aria-hidden />
            </button>
          )}
        </div>

        <RolePicker value={role} onChange={setRole} lockedTo={isMe ? account.role : undefined} />

        {!isMe && (
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

        <Field label="Username (name, email or mobile number)">
          <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} className={cx(inputClass, 'h-12')} />
        </Field>
        <PasswordPair password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} optional />

        {dirty && (
          <div className="animate-enter rounded-2xl bg-subtle p-3.5 ring-1 ring-line">
            <Field label="Your password, to save these changes">
              <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" placeholder="Your own password" />
            </Field>
          </div>
        )}
        <ErrorLine message={error} />
        <div className="flex gap-2">
          <Button size="lg" variant="plain" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="lg" variant="primary" loading={busy} disabled={!canSave} className="flex-[2]">
            Save changes
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

/** The team: everyone who can sign in. Tap a person to change or delete their login. */
function LoginsSection() {
  const toast = useToast();
  const me = useUser();
  const [accounts, setAccounts] = useState<LoginAccount[] | null>(null);
  const [sheet, setSheet] = useState<{ kind: 'add' } | { kind: 'manage'; id: number } | null>(null);

  useEffect(() => {
    api.listAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  const managed = sheet?.kind === 'manage' ? (accounts?.find((a) => a.id === sheet.id) ?? null) : null;
  const total = accounts?.length ?? 0;

  return (
    <section className="space-y-5" aria-label="Logins">
      {/* header */}
      <div className="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-[#ff9a5a] via-[#ff7a45] to-[#f43f5e] p-5 text-white shadow-raised">
        <span aria-hidden className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
        <div className="relative flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/20 ring-1 ring-white/30 backdrop-blur">
            <Users size={24} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-xl font-extrabold tracking-tight">Team logins</h3>
            <p className="text-sm font-medium text-white/85">{accounts ? `${total} ${total === 1 ? 'person' : 'people'} can sign in` : 'Loading…'}</p>
          </div>
        </div>
        <Button
          size="lg"
          icon={UserPlus}
          onClick={() => setSheet({ kind: 'add' })}
          disabled={!accounts}
          className="relative mt-4 w-full bg-white text-[#e8345f] shadow-control hover:bg-white/90"
        >
          Add login
        </Button>
      </div>

      {!accounts ? (
        <p className="flex items-center justify-center gap-2 py-6 text-sm text-ink-2">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
        </p>
      ) : (
        ROLE_ORDER.map((role) => {
          const group = accounts.filter((a) => a.role === role);
          if (group.length === 0) return null;
          return (
            <div key={role} className="space-y-2">
              <h4 className="flex items-center gap-2 px-1 text-xs font-bold tracking-wider text-ink-2 uppercase">
                {ROLE_GROUP_TITLES[role]}
                <span className="rounded-full bg-fill px-2 py-0.5 text-[11px] tabular-nums">{group.length}</span>
              </h4>
              <ul className="grid gap-2.5 lg:grid-cols-2">
                {group.map((a, i) => (
                  <li key={a.id} className="animate-card-rise min-w-0" style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}>
                    <button
                      type="button"
                      onClick={() => setSheet({ kind: 'manage', id: a.id })}
                      className={cx(
                        'group flex w-full items-center gap-3.5 rounded-2xl bg-surface p-3.5 text-left shadow-card ring-1 ring-line transition-all duration-200 hover:-translate-y-0.5 hover:shadow-raised active:scale-[0.99]',
                        !a.isActive && 'opacity-60',
                      )}
                    >
                      <Avatar account={a} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-bold tracking-tight">{a.username}</span>
                          {a.id === me.id && <span className="shrink-0 rounded-full bg-accent-tint px-2 py-0.5 text-[10px] font-bold text-accent">You</span>}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-ink-2">
                          <span className={cx('h-1.5 w-1.5 rounded-full', a.isActive ? 'bg-success' : 'bg-ink-3')} aria-hidden />
                          {a.isActive ? 'Active' : 'Turned off'} · {ROLE_LABELS[a.role]}
                        </span>
                      </span>
                      <ChevronRight size={18} className="shrink-0 text-ink-3 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}

      {sheet?.kind === 'add' && (
        <AddLoginSheet
          onClose={() => setSheet(null)}
          onAdded={(list, added) => {
            setAccounts(list);
            toast({ tone: 'success', title: `${added.username} added`, description: `New ${ROLE_LABELS[added.role]} login. They can sign in now.` });
          }}
        />
      )}
      {managed && (
        <ManageLoginSheet
          key={managed.id}
          account={managed}
          isMe={managed.id === me.id}
          onClose={() => setSheet(null)}
          onChanged={(list, message) => {
            setAccounts(list);
            toast({ tone: 'success', ...message });
          }}
        />
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
