package dev.quizarena.rooms;

import dev.quizarena.auth.CurrentUser;
import dev.quizarena.config.AppProperties;
import dev.quizarena.config.Keys;
import dev.quizarena.config.Rules;
import dev.quizarena.quizzes.Quiz;
import dev.quizarena.quizzes.QuizRepository;
import dev.quizarena.web.ApiException;
import dev.quizarena.web.ErrorCode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.time.Duration;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/rooms")
public class RoomController {
    private final RoomService rooms;
    private final QuizRepository quizzes;
    private final StringRedisTemplate redis;
    private final AppProperties props;

    public RoomController(RoomService rooms, QuizRepository quizzes, StringRedisTemplate redis, AppProperties props) {
        this.rooms = rooms;
        this.quizzes = quizzes;
        this.redis = redis;
        this.props = props;
    }

    public record NewRoom(@NotNull @Pattern(regexp = "^[0-9a-fA-F-]{36}$", message = "must be a uuid") String quizId) {}

    public record Answer(@NotNull @Min(0) Integer questionIndex, @NotNull @Min(0) Integer optionIndex) {}

    /** Per-user fixed-window limit on hosting rooms. */
    private void rateLimit(String userId) {
        Rules.RateWindow w = Rules.rateWindow(System.currentTimeMillis(), props.rateLimitWindowSec());
        String key = Keys.rateLimit(userId, w.window());
        Long count = redis.opsForValue().increment(key);
        if (count != null && count == 1) redis.expire(key, Duration.ofSeconds(props.rateLimitWindowSec()));
        if (count != null && count > props.rateLimitMax()) {
            throw new ApiException(429, ErrorCode.RATE_LIMITED, "Too many rooms, slow down", null,
                    Map.of("Retry-After", String.valueOf(w.retryAfterSec())));
        }
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> create(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody NewRoom body) {
        CurrentUser user = CurrentUser.of(jwt);
        rateLimit(user.id());
        Quiz quiz = quizzes.find(body.quizId()).orElseThrow(() -> ApiException.notFound("Quiz"));
        return rooms.create(user, quiz.id(), quiz.title(), quiz.questions());
    }

    @GetMapping("/{code}")
    public Map<String, Object> get(@PathVariable String code) {
        return rooms.view(code);
    }

    @PostMapping("/{code}/join")
    public Map<String, Object> join(@PathVariable String code, @AuthenticationPrincipal Jwt jwt) {
        return rooms.join(code, CurrentUser.of(jwt));
    }

    @PostMapping("/{code}/start")
    public Map<String, Object> start(@PathVariable String code, @AuthenticationPrincipal Jwt jwt) {
        return rooms.start(code, CurrentUser.of(jwt));
    }

    @PostMapping("/{code}/next")
    public Map<String, Object> next(@PathVariable String code, @AuthenticationPrincipal Jwt jwt) {
        return rooms.next(code, CurrentUser.of(jwt));
    }

    @PostMapping("/{code}/answer")
    public Map<String, Object> answer(@PathVariable String code, @AuthenticationPrincipal Jwt jwt,
                                      @Valid @RequestBody Answer body) {
        return rooms.answer(code, CurrentUser.of(jwt), body.questionIndex(), body.optionIndex());
    }
}
