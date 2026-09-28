import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const resendKey = Deno.env.get('RESEND_API_KEY');
const fromEmail = Deno.env.get('REMINDER_FROM_EMAIL') || 'Focus <onboarding@resend.dev>';
const headers = { 'Content-Type': 'application/json' };
const label = (type: string) => type === 'one_hour' ? '1 hour' : '30 minutes';
const formatDue = (value: string, timezone: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || 'UTC' }).format(new Date(value));
async function sendEmail(to: string, task: any, reminder: any, timezone: string) {
  if (!resendKey) throw new Error('RESEND_API_KEY is not configured');
  const due = formatDue(task.due_at, timezone);
  const message = `Reminder: Your task '${task.title}' is due at ${due}. Please complete it before the deadline and remember to mark it as completed.`;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `task-reminder-${reminder.id}` }, body: JSON.stringify({ from: fromEmail, to: [to], subject: `${label(reminder.reminder_type)} reminder: ${task.title}`, text: message }) });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}: ${await response.text()}`);
}
Deno.serve(async () => {
  const { data: reminders, error } = await supabase.rpc('claim_due_task_reminders', { p_limit: 100 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  let processed = 0;
  for (const reminder of reminders || []) try {
    const [{ data: task }, { data: preferences }, { data: authUser }] = await Promise.all([
      supabase.from('tasks').select('id,user_id,title,due_at,status').eq('id', reminder.task_id).single(),
      supabase.from('notification_preferences').select('*').eq('user_id', reminder.user_id).single(),
      supabase.auth.admin.getUserById(reminder.user_id),
    ]);
    if (!task || task.status === 'completed' || !task.due_at || new Date(task.due_at).getTime() <= Date.now()) { await supabase.from('task_reminders').update({ status: 'cancelled', error_message: 'Task no longer qualifies' }).eq('id', reminder.id); continue; }
    const pref = preferences || { email_reminders: true, in_app_reminders: true, timezone: 'UTC' };
    const due = formatDue(task.due_at, pref.timezone);
    const title = `${label(reminder.reminder_type)} reminder`;
    const message = `Your task '${task.title}' is due at ${due}. Please complete it before the deadline and remember to mark it as completed.`;
    if (pref.in_app_reminders) await supabase.from('notifications').upsert({ user_id: reminder.user_id, task_id: task.id, type: 'reminder', reminder_scheduled_for: reminder.scheduled_for, title, message }, { onConflict: 'task_id,type,reminder_scheduled_for', ignoreDuplicates: true });
    if (pref.email_reminders && authUser?.user?.email) await sendEmail(authUser.user.email, task, reminder, pref.timezone);
    await supabase.rpc('mark_task_reminder_sent', { p_id: reminder.id }); processed++;
  } catch (err) { await supabase.rpc('mark_task_reminder_failed', { p_id: reminder.id, p_error: err instanceof Error ? err.message : String(err) }); }
  return new Response(JSON.stringify({ processed, claimed: reminders?.length || 0 }), { headers });
});
