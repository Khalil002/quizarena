package dev.quizarena.rooms;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.quizarena.config.AppProperties;
import dev.quizarena.config.Keys;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class LeaderboardController {
    private final JdbcClient db;
    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;
    private final AppProperties props;

    public LeaderboardController(JdbcClient db, StringRedisTemplate redis, ObjectMapper mapper, AppProperties props) {
        this.db = db;
        this.redis = redis;
        this.mapper = mapper;
        this.props = props;
    }

    /** Cache-aside: the aggregate query runs at most once per CACHE_TTL_SEC. */
    @GetMapping("/api/leaderboard")
    public ResponseEntity<String> leaderboard() throws JsonProcessingException {
        String cached = redis.opsForValue().get(Keys.LEADERBOARD_CACHE);
        if (cached != null) {
            return ResponseEntity.ok().header("X-Cache", "HIT").contentType(MediaType.APPLICATION_JSON).body(cached);
        }
        List<Map<String, Object>> rows = db.sql("""
                SELECT mp.user_id, u.display_name, SUM(mp.score)::int AS total_score, COUNT(*)::int AS matches
                  FROM match_players mp JOIN users u ON u.id = mp.user_id
                 GROUP BY mp.user_id, u.display_name
                 ORDER BY total_score DESC, u.display_name ASC LIMIT 10""")
                .query((rs, i) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("userId", rs.getObject("user_id", UUID.class));
                    m.put("displayName", rs.getString("display_name"));
                    m.put("totalScore", rs.getInt("total_score"));
                    m.put("matches", rs.getInt("matches"));
                    return m;
                })
                .list();
        String body = mapper.writeValueAsString(rows);
        redis.opsForValue().set(Keys.LEADERBOARD_CACHE, body, Duration.ofSeconds(props.cacheTtlSec()));
        return ResponseEntity.ok().header("X-Cache", "MISS").contentType(MediaType.APPLICATION_JSON).body(body);
    }
}
