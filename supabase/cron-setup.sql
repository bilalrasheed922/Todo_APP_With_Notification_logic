-- Enable pg_cron, pg_net, and Vault extensions first.
-- Store SUPABASE_SERVICE_ROLE_KEY in Vault; never paste it into this file.
select cron.schedule('process-focus-reminders-every-5-minutes','*/5 * * * *', $$
  select net.http_post(
    url := 'https://szyhdkkfhaytdwueqzrf.supabase.co/functions/v1/process-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{}'::jsonb
  );
$$);
