package dev.quizarena.quizzes;

import dev.quizarena.config.Rules;
import java.sql.Array;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class QuizRepository {
    private final JdbcClient db;

    public QuizRepository(JdbcClient db) {
        this.db = db;
    }

    public Optional<Quiz> find(String id) {
        if (!Rules.isUuid(id)) return Optional.empty();
        UUID quizId = UUID.fromString(id);
        record Head(UUID id, String title, UUID ownerId, String createdAt) {}
        return db.sql("SELECT id, title, owner_id, created_at FROM quizzes WHERE id = ?").param(quizId)
                .query((rs, i) -> new Head(rs.getObject("id", UUID.class), rs.getString("title"),
                        rs.getObject("owner_id", UUID.class), Rules.iso(rs.getTimestamp("created_at").toInstant())))
                .optional()
                .map(h -> new Quiz(h.id(), h.title(), h.ownerId(), h.createdAt(), questions(quizId)));
    }

    private List<Question> questions(UUID quizId) {
        return db.sql("SELECT prompt, options, correct_index, time_limit_sec FROM questions WHERE quiz_id = ? ORDER BY position")
                .param(quizId)
                .query((rs, i) -> {
                    Array options = rs.getArray("options");
                    return new Question(rs.getString("prompt"), Arrays.asList((String[]) options.getArray()),
                            rs.getInt("correct_index"), rs.getInt("time_limit_sec"));
                })
                .list();
    }

    @Transactional
    public UUID create(UUID ownerId, String title, List<Question> questions) {
        UUID id = db.sql("INSERT INTO quizzes (owner_id, title) VALUES (?, ?) RETURNING id").params(ownerId, title)
                .query(UUID.class).single();
        for (int position = 0; position < questions.size(); position++) {
            Question q = questions.get(position).trimmed();
            db.sql("INSERT INTO questions (quiz_id, position, prompt, options, correct_index, time_limit_sec) "
                            + "VALUES (?, ?, ?, ?::text[], ?, ?)")
                    .params(id, position, q.prompt(), toPgArray(q.options()), q.correctIndex(), q.timeLimitSec())
                    .update();
        }
        return id;
    }

    /** Postgres array literal, e.g. {"a","b \"c\""}. */
    static String toPgArray(List<String> values) {
        StringBuilder sb = new StringBuilder("{");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append('"').append(values.get(i).replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
        }
        return sb.append('}').toString();
    }

    public void delete(UUID id) {
        db.sql("DELETE FROM quizzes WHERE id = ?").param(id).update();
    }
}
