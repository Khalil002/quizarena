-- Finished matches, written by the archive worker from live Redis state.
-- Inserts are idempotent (primary keys), so a redelivered job is harmless.

CREATE TABLE matches (
    id           uuid PRIMARY KEY,
    quiz_id      uuid REFERENCES quizzes (id) ON DELETE SET NULL,
    quiz_title   text NOT NULL,
    host_id      uuid NOT NULL REFERENCES users (id),
    code         text NOT NULL,
    player_count integer NOT NULL,
    finished_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match_players (
    match_id      uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    display_name  text NOT NULL,
    score         integer NOT NULL CHECK (score >= 0),
    correct_count integer NOT NULL CHECK (correct_count >= 0),
    rank          integer NOT NULL CHECK (rank >= 1),
    PRIMARY KEY (match_id, user_id)
);
CREATE INDEX match_players_user_idx ON match_players (user_id);
