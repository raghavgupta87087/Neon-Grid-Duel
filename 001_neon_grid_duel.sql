-- Neon Grid Duel: PostgreSQL schema and trusted game actions.
-- Run this migration in Supabase SQL Editor before setting frontend env vars.

create extension if not exists pgcrypto;

create table if not exists public.neon_rooms (
  code text primary key check (code ~ '^[A-Z0-9]{4,8}$'),
  host_id text not null,
  guest_id text,
  host_name text not null default 'Player X',
  guest_name text,
  board jsonb not null default '["","","","","","","","",""]'::jsonb,
  current_turn text not null default 'X' check (current_turn in ('X','O')),
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  winner text check (winner in ('X','O') or winner is null),
  winning_line jsonb not null default '[]'::jsonb,
  x_wins integer not null default 0 check (x_wins >= 0),
  o_wins integer not null default 0 check (o_wins >= 0),
  draws integer not null default 0 check (draws >= 0),
  round integer not null default 1 check (round >= 1),
  rematch_x boolean not null default false,
  rematch_o boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.neon_matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.neon_rooms(code) on delete cascade,
  round integer not null,
  winner text check (winner in ('X','O') or winner is null),
  is_draw boolean not null default false,
  finished_at timestamptz not null default now(),
  unique (room_code, round)
);

alter table public.neon_rooms enable row level security;
alter table public.neon_matches enable row level security;

-- Clients must use the RPCs below; direct table access is denied to anon/authenticated.
revoke all on public.neon_rooms from anon, authenticated;
revoke all on public.neon_matches from anon, authenticated;

-- Room codes are intended to be shareable, so get/join RPCs are SECURITY DEFINER.
-- All game mutations are serialized by row locks in the RPCs.

create or replace function public.neon_outcome(p_board jsonb)
returns jsonb
language plpgsql immutable
as $$
declare
  b text[];
  ln int[];
  lines int[][] := array[
    array[0,1,2], array[3,4,5], array[6,7,8],
    array[0,3,6], array[1,4,7], array[2,5,8],
    array[0,4,8], array[2,4,6]
  ];
  i int;
  a int;
begin
  for i in 0..8 loop
    b[i] := coalesce(p_board->>i, '');
  end loop;
  foreach ln slice 1 in array lines loop
    if b[ln[1]] in ('X','O') and b[ln[1]] = b[ln[2]] and b[ln[2]] = b[ln[3]] then
      return jsonb_build_object('winner', b[ln[1]], 'line', jsonb_build_array(ln[1] - 1, ln[2] - 1, ln[3] - 1), 'draw', false);
    end if;
  end loop;
  for i in 0..8 loop
    if coalesce(b[i], '') = '' then
      return jsonb_build_object('winner', null, 'line', '[]'::jsonb, 'draw', false);
    end if;
  end loop;
  return jsonb_build_object('winner', null, 'line', '[]'::jsonb, 'draw', true);
end;
$$;

create or replace function public.create_neon_room(p_code text, p_player_id text, p_player_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r public.neon_rooms;
begin
  if length(p_code) not between 4 and 8 or p_code !~ '^[A-Z0-9]+$' then
    raise exception 'Invalid room code.';
  end if;
  insert into public.neon_rooms(code, host_id, host_name)
  values (p_code, left(p_player_id, 100), left(coalesce(nullif(trim(p_player_name), ''), 'Player'), 18))
  returning * into r;
  return to_jsonb(r);
exception when unique_violation then
  raise exception 'Room code collision. Please create a new room.';
end;
$$;

create or replace function public.get_neon_room(p_code text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r public.neon_rooms;
begin
  select * into r from public.neon_rooms where code = upper(p_code);
  if not found then raise exception 'Room not found.'; end if;
  return to_jsonb(r);
end;
$$;

create or replace function public.join_neon_room(p_code text, p_player_id text, p_player_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r public.neon_rooms;
begin
  select * into r from public.neon_rooms where code = upper(p_code) for update;
  if not found then raise exception 'Room not found. Check the code.'; end if;
  if r.host_id = left(p_player_id, 100) then return to_jsonb(r); end if;
  if r.guest_id = left(p_player_id, 100) then return to_jsonb(r); end if;
  if r.guest_id is not null then raise exception 'That room is full.'; end if;
  update public.neon_rooms set guest_id = left(p_player_id, 100),
    guest_name = left(coalesce(nullif(trim(p_player_name), ''), 'Player'), 18),
    status = 'playing', updated_at = now()
  where code = upper(p_code) returning * into r;
  return to_jsonb(r);
end;
$$;

create or replace function public.play_neon_move(p_code text, p_player_id text, p_cell integer)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r public.neon_rooms; b jsonb; outcome jsonb; next_turn text; w text; d boolean; line jsonb;
begin
  if p_cell < 0 or p_cell > 8 then raise exception 'Invalid cell.'; end if;
  select * into r from public.neon_rooms where code = upper(p_code) for update;
  if not found then raise exception 'Room not found.'; end if;
  if r.status <> 'playing' or r.guest_id is null then raise exception 'The match is not ready for a move.'; end if;
  if (r.current_turn = 'X' and r.host_id <> left(p_player_id, 100))
    or (r.current_turn = 'O' and r.guest_id <> left(p_player_id, 100)) then
    raise exception 'It is not your turn.';
  end if;
  if coalesce(r.board->>p_cell, '') <> '' then raise exception 'That cell is already occupied.'; end if;
  b := jsonb_set(r.board, array[p_cell::text], to_jsonb(r.current_turn), false);
  outcome := public.neon_outcome(b);
  w := outcome->>'winner'; d := coalesce((outcome->>'draw')::boolean, false); line := outcome->'line';
  next_turn := case when r.current_turn = 'X' then 'O' else 'X' end;
  update public.neon_rooms set board = b, current_turn = next_turn,
    status = case when w is not null or d then 'finished' else 'playing' end,
    winner = w, winning_line = coalesce(line, '[]'::jsonb),
    x_wins = x_wins + case when w = 'X' then 1 else 0 end,
    o_wins = o_wins + case when w = 'O' then 1 else 0 end,
    draws = draws + case when d then 1 else 0 end,
    updated_at = now()
  where code = upper(p_code) returning * into r;
  if r.status = 'finished' then
    insert into public.neon_matches(room_code, round, winner, is_draw)
    values (r.code, r.round, w, d) on conflict (room_code, round) do nothing;
  end if;
  return to_jsonb(r);
end;
$$;

create or replace function public.request_neon_rematch(p_code text, p_player_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r public.neon_rooms;
begin
  select * into r from public.neon_rooms where code = upper(p_code) for update;
  if not found then raise exception 'Room not found.'; end if;
  if left(p_player_id, 100) not in (r.host_id, r.guest_id) then raise exception 'You are not a player in this room.'; end if;
  if r.status <> 'finished' then raise exception 'Finish the current round before requesting a rematch.'; end if;
  update public.neon_rooms set
    rematch_x = rematch_x or (host_id = left(p_player_id, 100)),
    rematch_o = rematch_o or (guest_id = left(p_player_id, 100)),
    updated_at = now()
  where code = upper(p_code) returning * into r;
  if r.rematch_x and r.rematch_o then
    update public.neon_rooms set board = '["","","","","","","","",""]'::jsonb,
      current_turn = 'X', status = 'playing', winner = null, winning_line = '[]'::jsonb,
      round = round + 1, rematch_x = false, rematch_o = false, updated_at = now()
    where code = upper(p_code) returning * into r;
  end if;
  return to_jsonb(r);
end;
$$;

revoke all on function public.neon_outcome(jsonb) from public, anon, authenticated;
revoke all on function public.create_neon_room(text,text,text) from public;
revoke all on function public.get_neon_room(text) from public;
revoke all on function public.join_neon_room(text,text,text) from public;
revoke all on function public.play_neon_move(text,text,integer) from public;
revoke all on function public.request_neon_rematch(text,text) from public;
grant execute on function public.create_neon_room(text,text,text) to anon, authenticated;
grant execute on function public.get_neon_room(text) to anon, authenticated;
grant execute on function public.join_neon_room(text,text,text) to anon, authenticated;
grant execute on function public.play_neon_move(text,text,integer) to anon, authenticated;
grant execute on function public.request_neon_rematch(text,text) to anon, authenticated;

-- Send room-scoped realtime broadcasts without granting clients direct table reads.
create or replace function public.broadcast_neon_room_update()
returns trigger
language plpgsql security definer set search_path = public, realtime
as $$
begin
  perform realtime.broadcast_changes(
    'room:' || NEW.code,
    TG_OP,
    'room_update',
    TG_TABLE_NAME,
    TG_TABLE_SCHEMA,
    NEW,
    OLD
  );
  return NEW;
end;
$$;

drop trigger if exists neon_room_broadcast on public.neon_rooms;
create trigger neon_room_broadcast
after insert or update on public.neon_rooms
for each row execute function public.broadcast_neon_room_update();

revoke all on function public.broadcast_neon_room_update() from public, anon, authenticated;
