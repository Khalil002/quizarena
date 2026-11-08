-- Players, quizzes and their questions. Shared by every backend; applied once by Flyway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL,
    display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 24),
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE quizzes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quizzes_owner_idx ON quizzes (owner_id);

CREATE TABLE questions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quiz_id        uuid NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
    position       integer NOT NULL CHECK (position >= 0),
    prompt         text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 300),
    options        text[] NOT NULL CHECK (array_length(options, 1) BETWEEN 2 AND 4),
    correct_index  integer NOT NULL,
    time_limit_sec integer NOT NULL CHECK (time_limit_sec BETWEEN 5 AND 120),
    CONSTRAINT correct_index_in_range CHECK (correct_index >= 0 AND correct_index < array_length(options, 1)),
    CONSTRAINT one_question_per_position UNIQUE (quiz_id, position)
);

-- Demo admin (password: admin1234). Change it before exposing the app.
INSERT INTO users (id, email, display_name, password_hash, role) VALUES
    ('00000000-0000-0000-0000-00000000a001', 'admin@quizarena.local', 'Quizmaster',
     '$2a$10$R.zyHeoOV2B30kSJKC5h/OsuCmZq2x0Q0hG1ZaL18kc/re3Q1s9wa', 'admin');

-- A starter quiz so a fresh install has something to play.
INSERT INTO quizzes (id, owner_id, title) VALUES
    ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000a001', 'Backend Trivia');

INSERT INTO questions (quiz_id, position, prompt, options, correct_index, time_limit_sec) VALUES
    ('00000000-0000-0000-0000-00000000b001', 0, 'Which HTTP status code means "Too Many Requests"?',
     ARRAY['403', '409', '429', '503'], 2, 20),
    ('00000000-0000-0000-0000-00000000b001', 1, 'What does the C in ACID stand for?',
     ARRAY['Concurrency', 'Consistency', 'Commit', 'Cache'], 1, 20),
    ('00000000-0000-0000-0000-00000000b001', 2, 'Which Redis structure keeps members ordered by score?',
     ARRAY['List', 'Set', 'Hash', 'Sorted set'], 3, 20),
    ('00000000-0000-0000-0000-00000000b001', 3, 'SELECT ... FOR UPDATE SKIP LOCKED is mostly used to build...',
     ARRAY['Job queues', 'Full-text search', 'Materialized views', 'Backups'], 0, 20),
    ('00000000-0000-0000-0000-00000000b001', 4, 'Which header makes a POST safe to retry?',
     ARRAY['If-Match', 'Idempotency-Key', 'Cache-Control', 'Retry-After'], 1, 20);
