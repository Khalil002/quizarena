package dev.quizarena.quizzes;

import dev.quizarena.auth.CurrentUser;
import dev.quizarena.config.Rules;
import dev.quizarena.web.ApiException;
import dev.quizarena.web.ErrorCode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/quizzes")
public class QuizController {
    private final QuizRepository quizzes;
    private final JdbcClient db;

    public QuizController(QuizRepository quizzes, JdbcClient db) {
        this.quizzes = quizzes;
        this.db = db;
    }

    public record NewQuiz(@NotBlank @Size(max = 120) String title,
                          @NotNull @Size(min = 1, max = 50) List<@Valid @NotNull Question> questions) {}

    @GetMapping
    public List<Map<String, Object>> list() {
        return db.sql("""
                SELECT q.id, q.title, q.owner_id, COUNT(qs.id) AS question_count, q.created_at
                  FROM quizzes q LEFT JOIN questions qs ON qs.quiz_id = q.id
                 GROUP BY q.id ORDER BY q.created_at DESC LIMIT 100""")
                .query((rs, i) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getObject("id", UUID.class));
                    m.put("title", rs.getString("title"));
                    m.put("ownerId", rs.getObject("owner_id", UUID.class));
                    m.put("questionCount", rs.getInt("question_count"));
                    m.put("createdAt", Rules.iso(rs.getTimestamp("created_at").toInstant()));
                    return m;
                })
                .list();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Quiz create(@Valid @RequestBody NewQuiz body, @AuthenticationPrincipal Jwt jwt) {
        for (int i = 0; i < body.questions().size(); i++) {
            Question q = body.questions().get(i);
            if (q.correctIndex() >= q.options().size()) {
                throw new ApiException(400, ErrorCode.VALIDATION_ERROR, "Request validation failed",
                        "questions." + i + ".correctIndex: must point at an option", Map.of());
            }
        }
        UUID id = quizzes.create(UUID.fromString(jwt.getSubject()), body.title().trim(), body.questions());
        return quizzes.find(id.toString()).orElseThrow();
    }

    /** Resource-level authorization: owners and admins only. */
    private Quiz owned(String quizId, Jwt jwt) {
        Quiz quiz = quizzes.find(quizId).orElseThrow(() -> ApiException.notFound("Quiz"));
        CurrentUser user = CurrentUser.of(jwt);
        if (!quiz.ownerId().toString().equals(user.id()) && !user.isAdmin()) {
            throw new ApiException(403, ErrorCode.FORBIDDEN, "Only the owner or an admin can do this");
        }
        return quiz;
    }

    @GetMapping("/{quizId}")
    public Quiz get(@PathVariable String quizId, @AuthenticationPrincipal Jwt jwt) {
        return owned(quizId, jwt);
    }

    @DeleteMapping("/{quizId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String quizId, @AuthenticationPrincipal Jwt jwt) {
        quizzes.delete(owned(quizId, jwt).id());
    }
}
