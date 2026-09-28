-- Run this in Supabase SQL Editor.
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 240),
  notes text default '',
  status text not null default 'active' check (status in ('active', 'completed', 'postponed')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tasks enable row level security;
create policy "Users can view their own tasks" on public.tasks for select using (auth.uid() = user_id);
create policy "Users can create their own tasks" on public.tasks for insert with check (auth.uid() = user_id);
create policy "Users can update their own tasks" on public.tasks for update using (auth.uid() = user_id);
create policy "Users can delete their own tasks" on public.tasks for delete using (auth.uid() = user_id);

create index if not exists tasks_user_id_status_idx on public.tasks(user_id, status);
