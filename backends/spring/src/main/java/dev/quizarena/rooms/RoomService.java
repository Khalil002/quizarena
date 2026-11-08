package dev.quizarena.rooms;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.quizarena.auth.CurrentUser;
import dev.quizarena.config.AppProperties;
import dev.quizarena.config.Keys;
import dev.quizarena.config.Rules;
import dev.quizarena.quizzes.Question;
import dev.quizarena.web.ApiException;
import dev.quizarena.web.ErrorCode;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations.TypedTuple;
import org.springframework.stereotype.Service;

/**
 * The live game lives in Redis (same keys as the other backends), so any instance can
 * serve any room. Every change is published on qa:events:{code} for the WebSocket fan-out.
 */
@Service
public class RoomService {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;
    private final AppProperties props;

    public RoomService(StringRedisTemplate redis, ObjectMapper mapper, AppProperties props) {
        this.redis = redis;
        this.mapper = mapper;
        this.props = props;
    }

    record Meta(String code, String matchId, String quizId, String quizTitle, String hostId, String state,
                int questionIndex, long questionStartedAt, List<Question> quiz) {
        Meta with(String newState, int index, long startedAt) {
            return new Meta(code, matchId, quizId, quizTitle, hostId, newState, index, startedAt, quiz);
        }
    }

    Meta load(String code) {
        Map<Object, Object> h = code != null && Rules.CODE_RE.matcher(code).matches()
                ? redis.opsForHash().entries(Keys.room(code)) : Map.of();
        if (!h.containsKey("matchId")) throw ApiException.notFound("Room");
        try {
            List<Question> quiz = mapper.readValue((String) h.get("quiz"), new TypeReference<>() {});
            return new Meta(code, (String) h.get("matchId"), (String) h.get("quizId"), (String) h.get("quizTitle"),
                    (String) h.get("hostId"), (String) h.get("state"), Integer.parseInt((String) h.get("questionIndex")),
                    Long.parseLong((String) h.get("questionStartedAt")), quiz);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private void touch(String code, int questionCount) {
        List<String> keys = new ArrayList<>(List.of(Keys.room(code), Keys.players(code), Keys.scores(code), Keys.correct(code)));
        for (int i = 0; i < questionCount; i++) keys.add(Keys.answers(code, i));
        Duration ttl = Duration.ofSeconds(props.roomTtlSec());
        for (String key : keys) redis.expire(key, ttl);
    }

    public Map<String, Object> view(String code) {
        return view(load(code));
    }

    /** The public view of a room; correct answers appear only once revealed. */
    Map<String, Object> view(Meta m) {
        Map<Object, Object> names = redis.opsForHash().entries(Keys.players(m.code()));
        Map<String, Long> scores = new HashMap<>();
        var tuples = redis.opsForZSet().rangeWithScores(Keys.scores(m.code()), 0, -1);
        if (tuples != null) for (TypedTuple<String> t : tuples) scores.put(t.getValue(), t.getScore().longValue());
        List<Rules.Player> players = Rules.sortPlayers(names.entrySet().stream()
                .map(e -> new Rules.Player((String) e.getKey(), (String) e.getValue(), scores.getOrDefault((String) e.getKey(), 0L)))
                .toList());

        boolean open = m.state().equals("question") || m.state().equals("reveal");
        Map<String, Object> question = null;
        long answered = 0;
        if (open) {
            Question q = m.quiz().get(m.questionIndex());
            question = new LinkedHashMap<>();
            question.put("index", m.questionIndex());
            question.put("prompt", q.prompt());
            question.put("options", q.options());
            question.put("timeLimitSec", q.timeLimitSec());
            question.put("deadline", Rules.iso(Instant.ofEpochMilli(m.questionStartedAt() + q.timeLimitSec() * 1000L)));
            question.put("correctIndex", m.state().equals("reveal") ? q.correctIndex() : null);
            answered = redis.opsForHash().size(Keys.answers(m.code(), m.questionIndex()));
        }
        Map<String, Object> room = new LinkedHashMap<>();
        room.put("code", m.code());
        room.put("matchId", m.matchId());
        room.put("quizId", m.quizId());
        room.put("quizTitle", m.quizTitle());
        room.put("hostId", m.hostId());
        room.put("state", m.state());
        room.put("questionIndex", m.questionIndex());
        room.put("questionCount", m.quiz().size());
        room.put("question", question);
        room.put("answeredCount", answered);
        room.put("players", players);
        return room;
    }

    /** Pushes the new state to every WebSocket, on every instance, via Redis pub/sub. */
    private Map<String, Object> broadcast(Meta m) {
        Map<String, Object> room = view(m);
        try {
            redis.convertAndSend(Keys.events(m.code()), mapper.writeValueAsString(room));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
        return room;
    }

    public Map<String, Object> create(CurrentUser host, UUID quizId, String quizTitle, List<Question> quiz) {
        for (int attempt = 0; attempt < 10; attempt++) {
            String code = Rules.roomCode(RANDOM::nextInt);
            // HSETNX on matchId claims the code atomically.
            if (!Boolean.TRUE.equals(redis.opsForHash().putIfAbsent(Keys.room(code), "matchId", UUID.randomUUID().toString()))) continue;
            Map<String, String> fields = new HashMap<>();
            fields.put("quizId", quizId.toString());
            fields.put("quizTitle", quizTitle);
            fields.put("hostId", host.id());
            fields.put("state", "lobby");
            fields.put("questionIndex", "-1");
            fields.put("questionStartedAt", "0");
            try {
                fields.put("quiz", mapper.writeValueAsString(quiz));
            } catch (JsonProcessingException e) {
                throw new IllegalStateException(e);
            }
            redis.opsForHash().putAll(Keys.room(code), fields);
            touch(code, quiz.size());
            return view(code);
        }
        throw new IllegalStateException("could not allocate a room code");
    }

    public Map<String, Object> join(String code, CurrentUser user) {
        Meta m = load(code);
        if (m.hostId().equals(user.id())) {
            throw new ApiException(409, ErrorCode.HOST_CANNOT_JOIN, "The host runs the game and cannot play");
        }
        if (redis.opsForHash().hasKey(Keys.players(code), user.id())) return view(m);
        if (!m.state().equals("lobby")) throw new ApiException(409, ErrorCode.ROOM_STARTED, "This game has already started");
        redis.opsForHash().put(Keys.players(code), user.id(), user.displayName());
        redis.opsForZSet().addIfAbsent(Keys.scores(code), user.id(), 0);
        touch(code, m.quiz().size());
        return broadcast(m);
    }

    private static void requireHost(Meta m, CurrentUser user) {
        if (!m.hostId().equals(user.id())) throw new ApiException(403, ErrorCode.NOT_HOST, "Only the host can do this");
    }

    public Map<String, Object> start(String code, CurrentUser user) {
        Meta m = load(code);
        requireHost(m, user);
        if (!m.state().equals("lobby")) throw new ApiException(409, ErrorCode.ROOM_STARTED, "This game has already started");
        if (redis.opsForHash().size(Keys.players(code)) == 0) {
            throw new ApiException(409, ErrorCode.NO_PLAYERS, "Wait for at least one player");
        }
        return openQuestion(m, 0);
    }

    private Map<String, Object> openQuestion(Meta m, int index) {
        long startedAt = System.currentTimeMillis();
        redis.opsForHash().putAll(Keys.room(m.code()), Map.of(
                "state", "question", "questionIndex", String.valueOf(index), "questionStartedAt", String.valueOf(startedAt)));
        return broadcast(m.with("question", index, startedAt));
    }

    public Map<String, Object> next(String code, CurrentUser user) {
        Meta m = load(code);
        requireHost(m, user);
        switch (m.state()) {
            case "lobby" -> throw new ApiException(409, ErrorCode.ROOM_NOT_STARTED, "Start the game first");
            case "finished" -> throw new ApiException(409, ErrorCode.ROOM_FINISHED, "This game is over");
            case "question" -> {
                redis.opsForHash().put(Keys.room(code), "state", "reveal");
                return broadcast(m.with("reveal", m.questionIndex(), m.questionStartedAt()));
            }
            default -> {
                if (m.questionIndex() + 1 < m.quiz().size()) return openQuestion(m, m.questionIndex() + 1);
                redis.opsForHash().put(Keys.room(code), "state", "finished");
                // Hand the result to the archive worker (any instance) through a Redis stream.
                redis.opsForStream().add(StreamRecords.string(Map.of("matchId", m.matchId(), "code", code))
                        .withStreamKey(Keys.ARCHIVE_STREAM));
                return broadcast(m.with("finished", m.questionIndex(), m.questionStartedAt()));
            }
        }
    }

    public Map<String, Object> answer(String code, CurrentUser user, int questionIndex, int optionIndex) {
        Meta m = load(code);
        if (!redis.opsForHash().hasKey(Keys.players(code), user.id())) {
            throw new ApiException(403, ErrorCode.NOT_A_PLAYER, "Join the room before answering");
        }
        long elapsed = System.currentTimeMillis() - m.questionStartedAt();
        Question q = questionIndex < m.quiz().size() ? m.quiz().get(questionIndex) : null;
        if (!m.state().equals("question") || questionIndex != m.questionIndex() || q == null
                || elapsed > q.timeLimitSec() * 1000L) {
            throw new ApiException(409, ErrorCode.QUESTION_CLOSED, "That question is not open for answers");
        }
        if (optionIndex >= q.options().size()) {
            throw new ApiException(400, ErrorCode.VALIDATION_ERROR, "Request validation failed",
                    "optionIndex: out of range", Map.of());
        }
        if (!Boolean.TRUE.equals(redis.opsForHash().putIfAbsent(Keys.answers(code, questionIndex), user.id(),
                String.valueOf(optionIndex)))) {
            throw new ApiException(409, ErrorCode.ALREADY_ANSWERED, "You already answered this question");
        }
        int earned = Rules.points(optionIndex == q.correctIndex(), elapsed, q.timeLimitSec());
        if (earned > 0) {
            redis.opsForZSet().incrementScore(Keys.scores(code), user.id(), earned);
            redis.opsForHash().increment(Keys.correct(code), user.id(), 1);
        }
        touch(code, m.quiz().size());
        broadcast(m);
        return Map.of("accepted", true);
    }
}
