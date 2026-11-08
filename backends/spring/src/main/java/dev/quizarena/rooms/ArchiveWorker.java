package dev.quizarena.rooms;

import dev.quizarena.config.AppProperties;
import dev.quizarena.config.Keys;
import dev.quizarena.config.Rules;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations.TypedTuple;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Consumer-group worker on qa:stream:archive. It first retries this consumer's own
 * unacknowledged jobs ("0"), then takes new ones (">"), and acknowledges a job only
 * after its rows are committed. Inserts are idempotent, so redelivery is harmless.
 */
@Component
public class ArchiveWorker {
    private static final Logger log = LoggerFactory.getLogger(ArchiveWorker.class);
    private final StringRedisTemplate redis;
    private final JdbcClient db;
    private final TransactionTemplate tx;
    private final AppProperties props;

    public ArchiveWorker(StringRedisTemplate redis, JdbcClient db, TransactionTemplate tx, AppProperties props) {
        this.redis = redis;
        this.db = db;
        this.tx = tx;
        this.props = props;
    }

    private void ensureGroup() {
        try {
            redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) c -> c.streamCommands().xGroupCreate(
                    Keys.ARCHIVE_STREAM.getBytes(StandardCharsets.UTF_8), Keys.ARCHIVE_GROUP, ReadOffset.from("0"), true));
        } catch (Exception e) {
            if (!String.valueOf(e.getMessage()).contains("BUSYGROUP")
                    && !(e.getCause() != null && String.valueOf(e.getCause().getMessage()).contains("BUSYGROUP"))) {
                throw e;
            }
        }
    }

    @Scheduled(fixedDelayString = "${app.archive-interval-ms}")
    public void tick() {
        try {
            ensureGroup();
            Consumer consumer = Consumer.from(Keys.ARCHIVE_GROUP, props.consumerName());
            for (ReadOffset offset : List.of(ReadOffset.from("0"), ReadOffset.lastConsumed())) {
                List<MapRecord<String, Object, Object>> records = redis.opsForStream().read(consumer,
                        StreamReadOptions.empty().count(10), StreamOffset.create(Keys.ARCHIVE_STREAM, offset));
                if (records == null) continue;
                for (MapRecord<String, Object, Object> record : records) {
                    Map<Object, Object> f = record.getValue();
                    archive((String) f.get("matchId"), (String) f.get("code"));
                    redis.opsForStream().acknowledge(Keys.ARCHIVE_STREAM, Keys.ARCHIVE_GROUP, record.getId());
                }
            }
        } catch (Exception e) {
            log.warn("archive tick failed: {}", e.getMessage());
        }
    }

    /** Copies a finished room from Redis into match history. */
    void archive(String matchId, String code) {
        Map<Object, Object> room = redis.opsForHash().entries(Keys.room(code));
        if (!matchId.equals(room.get("matchId"))) return; // expired or reused code
        Map<Object, Object> names = redis.opsForHash().entries(Keys.players(code));
        Map<Object, Object> correct = redis.opsForHash().entries(Keys.correct(code));
        Map<String, Long> scores = new HashMap<>();
        var tuples = redis.opsForZSet().rangeWithScores(Keys.scores(code), 0, -1);
        if (tuples != null) for (TypedTuple<String> t : tuples) scores.put(t.getValue(), t.getScore().longValue());
        List<Long> all = new ArrayList<>();
        for (Object id : names.keySet()) all.add(scores.getOrDefault((String) id, 0L));

        tx.executeWithoutResult(status -> {
            db.sql("""
                    INSERT INTO matches (id, quiz_id, quiz_title, host_id, code, player_count)
                    VALUES (?, (SELECT id FROM quizzes WHERE id = ?), ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING""")
                    .params(UUID.fromString(matchId), UUID.fromString((String) room.get("quizId")), room.get("quizTitle"),
                            UUID.fromString((String) room.get("hostId")), code, names.size())
                    .update();
            for (var e : names.entrySet()) {
                String userId = (String) e.getKey();
                long score = scores.getOrDefault(userId, 0L);
                db.sql("""
                        INSERT INTO match_players (match_id, user_id, display_name, score, correct_count, rank)
                        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING""")
                        .params(UUID.fromString(matchId), UUID.fromString(userId), e.getValue(), score,
                                Integer.parseInt((String) correct.getOrDefault(userId, "0")), Rules.rankOf(score, all))
                        .update();
            }
        });
        redis.delete(Keys.LEADERBOARD_CACHE);
    }
}
