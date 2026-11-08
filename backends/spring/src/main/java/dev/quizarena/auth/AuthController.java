package dev.quizarena.auth;

import dev.quizarena.config.Rules;
import dev.quizarena.web.ApiException;
import dev.quizarena.web.ErrorCode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuthController {
    private static final String USER_COLUMNS = "id, email, display_name, role";
    private final JdbcClient db;
    private final TokenService tokens;
    private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder(10);

    public AuthController(JdbcClient db, TokenService tokens) {
        this.db = db;
        this.tokens = tokens;
    }

    public record Registration(
            @NotNull @Size(max = 254) @Pattern(regexp = "^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$", message = "must be an email address")
            String email,
            @NotNull @Size(min = 8, max = 72) String password,
            @NotNull @Pattern(regexp = "^\\s*\\S.{0,22}\\S\\s*$", message = "must be 2-24 characters") String displayName) {}

    public record Login(String email, String password) {}

    static UserDto mapUser(ResultSet rs, int i) throws SQLException {
        return new UserDto(rs.getObject("id", UUID.class), rs.getString("email"), rs.getString("display_name"),
                rs.getString("role"));
    }

    @PostMapping("/api/auth/register")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> register(@Valid @RequestBody Registration body) {
        try {
            UserDto user = db.sql("INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?) RETURNING "
                            + USER_COLUMNS)
                    .params(body.email().trim().toLowerCase(Locale.ROOT), body.displayName().trim(),
                            bcrypt.encode(body.password()))
                    .query(AuthController::mapUser).single();
            return Map.of("token", tokens.issue(user), "user", user);
        } catch (DuplicateKeyException e) {
            throw new ApiException(409, ErrorCode.EMAIL_TAKEN, "Email is already registered");
        }
    }

    @PostMapping("/api/auth/login")
    public Map<String, Object> login(@RequestBody Login body) {
        String email = body.email() == null ? "" : body.email().trim().toLowerCase(Locale.ROOT);
        record Found(UserDto user, String hash) {}
        Found found = db.sql("SELECT " + USER_COLUMNS + ", password_hash FROM users WHERE lower(email) = ?").param(email)
                .query((rs, i) -> new Found(mapUser(rs, i), rs.getString("password_hash"))).optional()
                .filter(f -> bcrypt.matches(body.password() == null ? "" : body.password(), f.hash()))
                .orElseThrow(() -> new ApiException(401, ErrorCode.INVALID_CREDENTIALS, "Email or password is incorrect"));
        return Map.of("token", tokens.issue(found.user()), "user", found.user());
    }

    @GetMapping("/api/me")
    public UserDto me(@AuthenticationPrincipal Jwt jwt) {
        return db.sql("SELECT " + USER_COLUMNS + " FROM users WHERE id = ?").param(UUID.fromString(jwt.getSubject()))
                .query(AuthController::mapUser).optional().orElseThrow(() -> ApiException.notFound("User"));
    }

    @GetMapping("/api/me/matches")
    public List<Map<String, Object>> matches(@AuthenticationPrincipal Jwt jwt) {
        return db.sql("""
                SELECT m.id, m.quiz_title, m.code, mp.score, mp.correct_count, mp.rank, m.player_count, m.finished_at
                  FROM match_players mp JOIN matches m ON m.id = mp.match_id
                 WHERE mp.user_id = ? ORDER BY m.finished_at DESC LIMIT 50""")
                .param(UUID.fromString(jwt.getSubject()))
                .query((rs, i) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("matchId", rs.getObject("id", UUID.class));
                    m.put("quizTitle", rs.getString("quiz_title"));
                    m.put("code", rs.getString("code"));
                    m.put("score", rs.getInt("score"));
                    m.put("correctCount", rs.getInt("correct_count"));
                    m.put("rank", rs.getInt("rank"));
                    m.put("playerCount", rs.getInt("player_count"));
                    m.put("finishedAt", Rules.iso(rs.getTimestamp("finished_at").toInstant()));
                    return m;
                })
                .list();
    }
}
