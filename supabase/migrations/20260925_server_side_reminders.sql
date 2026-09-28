-- Server-side reminders, notifications, and per-user delivery preferences.
-- Run after the original supabase/schema.sql migration.
alter table public.tasks add column if not exists due_at timestamptz;
create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_reminders boolean not null default true, in_app_reminders boolean not null default true,
  reminder_1_hour boolean not null default true, reminder_30_minutes boolean not null default true,
  timezone text not null default 'UTC', updated_at timestamptz not null default now()
);
create table if not exists public.task_reminders (
  id uuid primary key default gen_random_uuid(), task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_type text not null check (reminder_type in ('one_hour','thirty_minutes')),
  scheduled_for timestamptz not null, status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  sent_at timestamptz, attempts integer not null default 0, next_attempt_at timestamptz not null default now(), error_message text, created_at timestamptz not null default now(),
  unique (task_id, reminder_type, scheduled_for)
);
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade, type text not null default 'reminder', reminder_scheduled_for timestamptz,
  title text not null, message text not null, is_read boolean not null default false, created_at timestamptz not null default now(),
  unique (task_id, type, reminder_scheduled_for)
);
create index if not exists task_reminders_due_idx on public.task_reminders(status, next_attempt_at, scheduled_for);
create index if not exists task_reminders_user_idx on public.task_reminders(user_id);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications(user_id, is_read) where is_read = false;

alter table public.notification_preferences enable row level security;
alter table public.task_reminders enable row level security;
alter table public.notifications enable row level security;
drop policy if exists "Users can view their own notification preferences" on public.notification_preferences;
drop policy if exists "Users can update their own notification preferences" on public.notification_preferences;
drop policy if exists "Users can insert their own notification preferences" on public.notification_preferences;
create policy "Users can view their own notification preferences" on public.notification_preferences for select using (auth.uid() = user_id);
create policy "Users can update their own notification preferences" on public.notification_preferences for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can insert their own notification preferences" on public.notification_preferences for insert with check (auth.uid() = user_id);
drop policy if exists "Users can view their own reminders" on public.task_reminders;
create policy "Users can view their own reminders" on public.task_reminders for select using (auth.uid() = user_id);
drop policy if exists "Users can view their own notifications" on public.notifications;
drop policy if exists "Users can update their own notifications" on public.notifications;
create policy "Users can view their own notifications" on public.notifications for select using (auth.uid() = user_id);
create policy "Users can update their own notifications" on public.notifications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke insert, update, delete on public.task_reminders from anon, authenticated;
revoke insert on public.notifications from anon, authenticated;

create or replace function public.refresh_task_reminders(p_task_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare t public.tasks%rowtype; pref public.notification_preferences%rowtype;
begin
  select * into t from public.tasks where id = p_task_id; if not found then return; end if;
  select * into pref from public.notification_preferences where user_id = t.user_id;
  if not found then insert into public.notification_preferences(user_id) values (t.user_id) on conflict do nothing; select * into pref from public.notification_preferences where user_id = t.user_id; end if;
  delete from public.task_reminders where task_id = t.id and status in ('pending','processing','failed');
  if t.status = 'completed' or t.due_at is null or t.due_at <= now() then return; end if;
  if pref.reminder_1_hour then insert into public.task_reminders(task_id,user_id,reminder_type,scheduled_for) values(t.id,t.user_id,'one_hour',t.due_at-interval '1 hour') on conflict (task_id,reminder_type,scheduled_for) do nothing; end if;
  if pref.reminder_30_minutes then insert into public.task_reminders(task_id,user_id,reminder_type,scheduled_for) values(t.id,t.user_id,'thirty_minutes',t.due_at-interval '30 minutes') on conflict (task_id,reminder_type,scheduled_for) do nothing; end if;
end; $$;
revoke execute on function public.refresh_task_reminders(uuid) from public, anon, authenticated;
create or replace function public.refresh_user_task_reminders() returns trigger language plpgsql security definer set search_path = public as $$ declare task_row record; begin for task_row in select id from public.tasks where user_id = new.user_id loop perform public.refresh_task_reminders(task_row.id); end loop; return new; end; $$;
revoke execute on function public.refresh_user_task_reminders() from public, anon, authenticated;
create or replace function public.refresh_task_reminders_trigger() returns trigger language plpgsql security definer set search_path = public as $$ begin perform public.refresh_task_reminders(new.id); return new; end; $$;
revoke execute on function public.refresh_task_reminders_trigger() from public, anon, authenticated;
drop trigger if exists tasks_refresh_reminders on public.tasks;
create trigger tasks_refresh_reminders after insert or update of due_at, status on public.tasks for each row execute function public.refresh_task_reminders_trigger();
drop trigger if exists preferences_refresh_reminders on public.notification_preferences;
create trigger preferences_refresh_reminders after insert or update of reminder_1_hour, reminder_30_minutes on public.notification_preferences for each row execute function public.refresh_user_task_reminders();

create or replace function public.claim_due_task_reminders(p_limit integer default 100) returns setof public.task_reminders language plpgsql security definer set search_path = public as $$ begin return query with candidates as (select id from public.task_reminders where status in ('pending','failed') and scheduled_for <= now() and next_attempt_at <= now() and attempts < 8 order by scheduled_for for update skip locked limit p_limit) update public.task_reminders r set status='processing', attempts=r.attempts+1, error_message=null from candidates c where r.id=c.id returning r.*; end; $$;
create or replace function public.mark_task_reminder_failed(p_id uuid, p_error text) returns void language sql security definer set search_path = public as $$ update public.task_reminders set status='failed', error_message=left(p_error,1000), next_attempt_at=now()+least(interval '1 hour',interval '5 minutes'*power(2,attempts)) where id=p_id; $$;
create or replace function public.mark_task_reminder_sent(p_id uuid) returns void language sql security definer set search_path = public as $$ update public.task_reminders set status='sent', sent_at=now() where id=p_id; $$;
revoke execute on function public.claim_due_task_reminders(integer) from public, anon, authenticated;
revoke execute on function public.mark_task_reminder_failed(uuid,text) from public, anon, authenticated;
revoke execute on function public.mark_task_reminder_sent(uuid) from public, anon, authenticated;
grant execute on function public.claim_due_task_reminders(integer) to service_role;
grant execute on function public.mark_task_reminder_failed(uuid,text) to service_role;
grant execute on function public.mark_task_reminder_sent(uuid) to service_role;
create or replace function public.create_default_notification_preferences() returns trigger language plpgsql security definer set search_path = public as $$ begin insert into public.notification_preferences(user_id) values(new.id) on conflict do nothing; return new; end; $$;
revoke execute on function public.create_default_notification_preferences() from public, anon, authenticated;
drop trigger if exists on_auth_user_created_preferences on auth.users;
create trigger on_auth_user_created_preferences after insert on auth.users for each row execute function public.create_default_notification_preferences();
