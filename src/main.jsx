import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatLocalDateTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '';
const toLocalDateTimeInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const seedTasks = [
  { id: 'demo-1', title: 'Plan the week ahead', notes: 'Set aside 20 minutes to map out the important bits.', status: 'active', priority: 'high', due_date: new Date().toISOString().slice(0, 10), created_at: new Date().toISOString() },
  { id: 'demo-2', title: 'Reply to design feedback', notes: '', status: 'active', priority: 'medium', due_date: null, created_at: new Date().toISOString() },
  { id: 'demo-3', title: 'Book a dentist appointment', notes: '', status: 'postponed', priority: 'low', due_date: null, created_at: new Date().toISOString() },
  { id: 'demo-4', title: 'Read 10 pages', notes: '', status: 'completed', priority: 'low', due_date: null, created_at: new Date().toISOString() },
];

function App() {
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  const [tasks, setTasks] = useState(seedTasks);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(Boolean(supabase));
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [preferences, setPreferences] = useState({ email_reminders: true, in_app_reminders: true, reminder_1_hour: true, reminder_30_minutes: true, timezone: userTimezone });

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) { loadTasks(); loadNotifications(); loadPreferences(); }
  }, [session]);

  useEffect(() => {
    if (!session || !supabase) return;
    const channel = supabase.channel('focus-notifications').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${session.user.id}` }, payload => setNotifications(current => [payload.new, ...current].slice(0, 12))).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session]);

  async function loadTasks() {
    const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (!error) setTasks(data || []);
  }

  async function loadNotifications() {
    if (!supabase) return;
    const { data } = await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(12);
    if (data) setNotifications(data);
  }

  async function loadPreferences() {
    if (!supabase) return;
    const { data } = await supabase.from('notification_preferences').select('*').maybeSingle();
    if (data) setPreferences(data);
    else await supabase.from('notification_preferences').insert({ user_id: session.user.id, timezone: userTimezone });
  }

  async function savePreferences(next) {
    setPreferences(next);
    if (supabase) await supabase.from('notification_preferences').upsert({ ...next, user_id: session.user.id, updated_at: new Date().toISOString() });
    setToast('Reminder settings saved.');
  }

  async function markNotificationRead(notification) {
    if (supabase) await supabase.from('notifications').update({ is_read: true }).eq('id', notification.id);
    setNotifications(current => current.map(item => item.id === notification.id ? { ...item, is_read: true } : item));
  }

  async function markAllNotificationsRead() {
    if (supabase) await supabase.from('notifications').update({ is_read: true }).eq('user_id', session.user.id).eq('is_read', false);
    setNotifications(current => current.map(item => ({ ...item, is_read: true })));
  }

  async function authenticate(email, password, name) {
    if (!supabase) { setSession({ user: { email, user_metadata: { full_name: name || 'Demo User' } } }); return; }
    const result = authMode === 'login'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: window.location.origin } });
    if (result.error) throw result.error;
    if (authMode === 'signup' && !result.data.session) return { needsConfirmation: true };
    setToast('Welcome back.');
    return { needsConfirmation: false };
  }

  async function saveTask(taskData) {
    const normalizedTask = { ...taskData, due_at: taskData.due_at ? new Date(taskData.due_at).toISOString() : null, due_date: taskData.due_at ? taskData.due_at.slice(0, 10) : null };
    if (session && supabase) {
      const payload = { ...normalizedTask, user_id: session.user.id };
      if (editingTask) await supabase.from('tasks').update(payload).eq('id', editingTask.id);
      else await supabase.from('tasks').insert(payload);
      await loadTasks();
    } else {
      setTasks(current => editingTask ? current.map(t => t.id === editingTask.id ? { ...t, ...normalizedTask } : t) : [{ ...normalizedTask, id: crypto.randomUUID(), created_at: new Date().toISOString() }, ...current]);
    }
    setShowComposer(false); setEditingTask(null); setToast(editingTask ? 'Task updated.' : 'Task added.');
  }

  async function updateStatus(task, status) {
    if (session && supabase) { await supabase.from('tasks').update({ status }).eq('id', task.id); await loadTasks(); }
    else setTasks(current => current.map(t => t.id === task.id ? { ...t, status } : t));
    setToast(status === 'completed' ? 'Nice work — task complete.' : 'Task moved to postponed.');
  }

  async function deleteTask(task) {
    if (session && supabase) { await supabase.from('tasks').delete().eq('id', task.id); await loadTasks(); }
    else setTasks(current => current.filter(t => t.id !== task.id));
    setToast('Task deleted.');
  }

  const visibleTasks = useMemo(() => tasks.filter(task => (filter === 'all' || task.status === filter) && task.title.toLowerCase().includes(query.toLowerCase())), [tasks, filter, query]);
  const counts = { all: tasks.length, active: tasks.filter(t => t.status === 'active').length, completed: tasks.filter(t => t.status === 'completed').length, postponed: tasks.filter(t => t.status === 'postponed').length };
  const displayName = session?.user?.user_metadata?.full_name || session?.user?.email?.split('@')[0] || 'there';

  if (loading) return <div className="loading-screen"><div className="brand-mark">F</div><span>Getting things ready…</span></div>;
  if (!session) return <AuthScreen mode={authMode} setMode={setAuthMode} onSubmit={authenticate} />;

  return <div className="app-shell">
    <aside className="sidebar p-4 d-flex flex-column">
      <div className="brand d-flex align-items-center gap-2"><span className="brand-mark">F</span><span>focus<span className="brand-dot">.</span></span></div>
      <div className="sidebar-label">Workspace</div>
      <nav className="nav flex-column gap-1">
        <button className="nav-link active" onClick={() => setFilter('all')}><i className="bi bi-grid-1x2-fill" /> Overview <span className="nav-count">{counts.all}</span></button>
        <button className="nav-link" onClick={() => setFilter('active')}><i className="bi bi-circle" /> My tasks <span className="nav-count">{counts.active}</span></button>
        <button className="nav-link" onClick={() => setFilter('completed')}><i className="bi bi-check2-circle" /> Completed</button>
        <button className="nav-link" onClick={() => setFilter('postponed')}><i className="bi bi-clock-history" /> Postponed <span className="nav-count">{counts.postponed}</span></button>
      </nav>
      <div className="sidebar-tip mt-auto"><i className="bi bi-stars" /><strong>A little progress<br />is still progress.</strong><small>Keep your focus gentle today.</small></div>
      <div className="account position-relative mt-4" onClick={() => setProfileOpen(!profileOpen)}><div className="avatar">{displayName[0].toUpperCase()}</div><div className="account-copy"><strong>{displayName}</strong><small>{supabase ? 'Personal workspace' : 'Preview workspace'}</small></div><i className="bi bi-three-dots ms-auto" />{profileOpen && <button className="signout" onClick={() => supabase ? supabase.auth.signOut() : setSession(null)}>Sign out</button>}</div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>Good morning, {displayName.split(' ')[0]} <span>✦</span></h1></div><div className="top-actions"><div className="search-wrap"><i className="bi bi-search" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tasks" /></div><button className="icon-button notification-trigger" onClick={() => setShowNotifications(!showNotifications)}><i className="bi bi-bell" />{notifications.some(item => !item.is_read) && <span />}</button><button className="icon-button" onClick={() => setShowSettings(true)} title="Reminder settings"><i className="bi bi-sliders" /></button><button className="primary-button" onClick={() => { setEditingTask(null); setShowComposer(true); }}><i className="bi bi-plus-lg" /> New task</button></div></header>
      {showNotifications && <NotificationPanel notifications={notifications} onRead={markNotificationRead} onReadAll={markAllNotificationsRead} onClose={() => setShowNotifications(false)} />}
      <section className="hero-row"><div><h2>{filter === 'all' ? 'Your overview' : filter.charAt(0).toUpperCase() + filter.slice(1)}</h2><p>{counts.active ? `You have ${counts.active} things on your plate. One step at a time.` : 'Your plate is clear. Enjoy the moment.'}</p></div><div className="progress-card"><div className="progress-ring"><strong>{tasks.length ? Math.round(counts.completed / tasks.length * 100) : 0}%</strong></div><div><small>Daily progress</small><strong>{counts.completed} of {tasks.length} completed</strong></div></div></section>
      <section className="stats-row"><Stat label="All tasks" value={counts.all} icon="bi-grid" color="purple" /><Stat label="In progress" value={counts.active} icon="bi-lightning-charge" color="orange" /><Stat label="Completed" value={counts.completed} icon="bi-check2" color="green" /><Stat label="Postponed" value={counts.postponed} icon="bi-clock" color="blue" /></section>
      <div className="task-toolbar"><h3>{filter === 'all' ? 'All tasks' : `${filter} tasks`} <span>{visibleTasks.length}</span></h3><div className="view-toggle"><button className="selected"><i className="bi bi-list-ul" /></button><button><i className="bi bi-grid" /></button></div></div>
      <section className="task-list">{visibleTasks.length ? visibleTasks.map(task => <TaskCard key={task.id} task={task} onStatus={updateStatus} onEdit={() => { setEditingTask(task); setShowComposer(true); }} onDelete={deleteTask} />) : <div className="empty-state"><div>✦</div><h3>Nothing here yet</h3><p>Make a little room for something wonderful.</p><button className="primary-button" onClick={() => setShowComposer(true)}>Create a task</button></div>}</section>
    </main>
    {showComposer && <Composer task={editingTask} onClose={() => { setShowComposer(false); setEditingTask(null); }} onSave={saveTask} />}
    {showSettings && <SettingsPanel preferences={preferences} onSave={savePreferences} onClose={() => setShowSettings(false)} />}
    {toast && <div className="toast-note" onAnimationEnd={() => setToast('')}>{toast}</div>}
  </div>;
}

function Stat({ label, value, icon, color }) { return <div className="stat-card"><div className={`stat-icon ${color}`}><i className={`bi ${icon}`} /></div><div><small>{label}</small><strong>{value}</strong></div></div>; }

function TaskCard({ task, onStatus, onEdit, onDelete }) { const due = task.due_at || (task.due_date ? `${task.due_date}T00:00:00` : null); return <article className={`task-card ${task.status}`}><button className={`check-button ${task.status === 'completed' ? 'checked' : ''}`} onClick={() => onStatus(task, task.status === 'completed' ? 'active' : 'completed')}>{task.status === 'completed' && <i className="bi bi-check-lg" />}</button><div className="task-body"><div className="d-flex align-items-center gap-2"><h4>{task.title}</h4><span className={`priority ${task.priority}`}>{task.priority}</span></div>{task.notes && <p>{task.notes}</p>}<div className="task-meta">{due && <span><i className="bi bi-calendar3" /> {formatLocalDateTime(due)}</span>}<span className={`status-text ${task.status}`}><i className={`bi ${task.status === 'postponed' ? 'bi-clock' : task.status === 'completed' ? 'bi-check-circle' : 'bi-circle-fill'}`} /> {task.status}</span></div></div><div className="task-actions"><button onClick={onEdit}><i className="bi bi-pencil" /></button><button onClick={() => task.status !== 'postponed' ? onStatus(task, 'postponed') : onStatus(task, 'active')} title="Postpone"><i className="bi bi-clock" /></button><button onClick={() => onDelete(task)}><i className="bi bi-trash3" /></button></div></article>; }

function Composer({ task, onClose, onSave }) { const [form, setForm] = useState(task ? { ...task, due_at: toLocalDateTimeInput(task.due_at || task.due_date) } : { title: '', notes: '', priority: 'medium', due_at: '', status: 'active' }); const update = (key, value) => setForm({ ...form, [key]: value }); return <div className="modal-backdrop-custom"><div className="composer"><div className="composer-head"><div><span className="eyebrow">{task ? 'Edit task' : 'New task'}</span><h2>{task ? 'Make it even better.' : 'What’s on your mind?'}</h2></div><button onClick={onClose}><i className="bi bi-x-lg" /></button></div><label>Task title<input autoFocus value={form.title} onChange={e => update('title', e.target.value)} placeholder="e.g. Finish the project proposal" /></label><label>Notes <span>optional</span><textarea value={form.notes} onChange={e => update('notes', e.target.value)} placeholder="Add a little context…" rows="3" /></label><div className="row g-3"><div className="col-6"><label>Priority<select value={form.priority} onChange={e => update('priority', e.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div><div className="col-6"><label>Due date &amp; time <span>optional</span><input type="datetime-local" value={form.due_at || ''} onChange={e => update('due_at', e.target.value)} /></label></div></div><p className="timezone-hint"><i className="bi bi-globe2" /> Stored in UTC · shown in your local time ({userTimezone})</p><div className="composer-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!form.title.trim()} onClick={() => onSave({ ...form, title: form.title.trim() })}>{task ? 'Save changes' : 'Add task'} <i className="bi bi-arrow-up-right" /></button></div></div></div>; }

function AuthScreen({ mode, setMode, onSubmit }) { const [form, setForm] = useState({ email: '', password: '', name: '' }); const [error, setError] = useState(''); const [success, setSuccess] = useState(''); async function submit(e) { e.preventDefault(); setError(''); setSuccess(''); try { const result = await onSubmit(form.email, form.password, form.name); if (result?.needsConfirmation) setSuccess('Account created. Check your inbox and click the confirmation link before signing in.'); } catch (err) { setError(err.message || 'Something went wrong. Please try again.'); } } return <div className="auth-page"><div className="auth-art"><div className="auth-brand"><span className="brand-mark">F</span> focus<span className="brand-dot">.</span></div><div className="art-copy"><span className="eyebrow">A calmer way to get things done</span><h1>Make space for<br /><em>what matters.</em></h1><p>Capture your thoughts, find your rhythm, and make meaningful progress — one task at a time.</p><div className="quote-card"><div className="quote-stars">✦ ✦ ✦</div><p>“The secret of getting ahead is getting started.”</p><small>— Mark Twain</small></div></div><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /></div><div className="auth-panel"><div className="auth-form"><span className="mobile-brand"><span className="brand-mark">F</span> focus<span className="brand-dot">.</span></span><span className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Start your journey'}</span><h2>{mode === 'login' ? 'Sign in to focus.' : 'Create your account.'}</h2><p className="auth-subtitle">{mode === 'login' ? 'Pick up right where you left off.' : 'A little more focus goes a long way.'}</p>{error && <div className="error-message">{error}</div>}{success && <div className="success-message"><i className="bi bi-check-circle" /> {success}</div>}<form onSubmit={submit}>{mode === 'signup' && <label>Your name<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="How should we call you?" /></label>}<label>Email address<input required type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" /></label><label>Password<input required minLength="6" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="At least 6 characters" /></label><button className="primary-button w-100 justify-content-center" type="submit">{mode === 'login' ? 'Sign in' : 'Create account'} <i className="bi bi-arrow-up-right" /></button></form><div className="auth-switch">{mode === 'login' ? 'New here?' : 'Already have an account?'} <button onClick={() => { setError(''); setSuccess(''); setMode(mode === 'login' ? 'signup' : 'login'); }}>{mode === 'login' ? 'Create an account' : 'Sign in instead'}</button></div>{!supabase && <div className="preview-note"><i className="bi bi-eye" /> Preview mode — connect Supabase to make accounts persistent.</div>}</div></div></div>; }

function NotificationPanel({ notifications, onRead, onReadAll, onClose }) { return <div className="notification-panel"><div className="panel-heading"><div><span className="eyebrow">Inbox</span><h3>Notifications</h3></div><button onClick={onClose}><i className="bi bi-x-lg" /></button></div><div className="panel-actions"><span>{notifications.filter(item => !item.is_read).length} unread</span><button onClick={onReadAll}>Mark all read</button></div>{notifications.length ? notifications.map(item => <button className={`notification-item ${item.is_read ? 'read' : ''}`} key={item.id} onClick={() => onRead(item)}><span className="notification-icon"><i className="bi bi-clock-history" /></span><span><strong>{item.title}</strong><small>{item.message}</small><em>{formatLocalDateTime(item.created_at)}</em></span></button>) : <div className="panel-empty"><i className="bi bi-check2-circle" /><p>You’re all caught up.</p></div>}</div>; }
function SettingsPanel({ preferences, onSave, onClose }) { const [form, setForm] = useState(preferences); const toggle = key => setForm({ ...form, [key]: !form[key] }); return <div className="modal-backdrop-custom"><div className="composer settings-panel"><div className="composer-head"><div><span className="eyebrow">Preferences</span><h2>Reminder settings</h2></div><button onClick={onClose}><i className="bi bi-x-lg" /></button></div><p className="settings-copy">Choose how Focus should remind you. Changes apply to new and rescheduled tasks.</p><SettingToggle label="Email reminders" hint="Receive reminders in your inbox" checked={form.email_reminders} onChange={() => toggle('email_reminders')} /><SettingToggle label="In-app reminders" hint="Show reminders in your notification bell" checked={form.in_app_reminders} onChange={() => toggle('in_app_reminders')} /><div className="settings-divider" /><span className="eyebrow">Reminder timing</span><SettingToggle label="1 hour before" hint="A gentle heads-up" checked={form.reminder_1_hour} onChange={() => toggle('reminder_1_hour')} /><SettingToggle label="30 minutes before" hint="A closer-to-due nudge" checked={form.reminder_30_minutes} onChange={() => toggle('reminder_30_minutes')} /><label>Timezone<select value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })}><option value={userTimezone}>{userTimezone} (your browser)</option><option value="UTC">UTC</option></select></label><div className="composer-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => { onSave(form); onClose(); }}>Save settings</button></div></div></div>; }
function SettingToggle({ label, hint, checked, onChange }) { return <label className="setting-toggle"><span><strong>{label}</strong><small>{hint}</small></span><input type="checkbox" checked={checked} onChange={onChange} /><i /></label>; }

createRoot(document.getElementById('root')).render(<App />);
