package dev.quizarena.rooms;

import dev.quizarena.auth.TokenService;
import dev.quizarena.config.Keys;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * WebSocket fan-out. Every instance pattern-subscribes to qa:events:* and forwards each
 * room update to the sockets it holds for that room, so players on different instances
 * see the same game.
 */
@Component
public class RoomSocketHandler extends TextWebSocketHandler implements MessageListener {
    private static final Pattern PATH = Pattern.compile("^/api/rooms/([A-Z2-9]{6})/ws$");
    private final TokenService tokens;
    private final RoomService rooms;
    private final ObjectMapper mapper;
    private final Map<String, Set<WebSocketSession>> byRoom = new ConcurrentHashMap<>();

    public RoomSocketHandler(TokenService tokens, RoomService rooms, ObjectMapper mapper) {
        this.tokens = tokens;
        this.rooms = rooms;
        this.mapper = mapper;
    }

    @Override
    public void afterConnectionEstablished(@NonNull WebSocketSession raw) throws IOException {
        URI uri = raw.getUri();
        Matcher match = uri == null ? null : PATH.matcher(uri.getPath());
        if (match == null || !match.matches()) {
            raw.close(new CloseStatus(4404, "room not found"));
            return;
        }
        String token = UriComponentsBuilder.fromUri(uri).build().getQueryParams().getFirst("token");
        // Browsers cannot read HTTP errors on an upgrade, so failures are close codes.
        if (tokens.verify(token == null ? null : java.net.URLDecoder.decode(token, StandardCharsets.UTF_8)) == null) {
            raw.close(new CloseStatus(4401, "unauthorized"));
            return;
        }
        String code = match.group(1);
        Map<String, Object> snapshot;
        try {
            snapshot = rooms.view(code);
        } catch (RuntimeException e) {
            raw.close(new CloseStatus(4404, "room not found"));
            return;
        }
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(raw, 5_000, 512 * 1024);
        session.getAttributes().put("code", code);
        byRoom.computeIfAbsent(code, k -> ConcurrentHashMap.newKeySet()).add(session);
        session.sendMessage(new TextMessage(mapper.writeValueAsString(Map.of("type", "room.updated", "room", snapshot))));
    }

    @Override
    public void afterConnectionClosed(@NonNull WebSocketSession session, @NonNull CloseStatus status) {
        Object code = session.getAttributes().get("code");
        if (code == null) return;
        Set<WebSocketSession> set = byRoom.get(code.toString());
        if (set == null) return;
        set.removeIf(s -> s.getId().equals(session.getId()));
        if (set.isEmpty()) byRoom.remove(code.toString());
    }

    /** Redis pub/sub callback for qa:events:{code}. */
    @Override
    public void onMessage(@NonNull Message message, byte[] pattern) {
        String channel = new String(message.getChannel(), StandardCharsets.UTF_8);
        String code = channel.substring(channel.lastIndexOf(':') + 1);
        Set<WebSocketSession> sessions = byRoom.get(code);
        if (sessions == null) return;
        TextMessage frame = new TextMessage("{\"type\":\"room.updated\",\"room\":"
                + new String(message.getBody(), StandardCharsets.UTF_8) + "}");
        for (WebSocketSession s : sessions) {
            try {
                if (s.isOpen()) s.sendMessage(frame);
            } catch (IOException | IllegalStateException ignored) {
                // a slow or dead client; it will be removed when it closes
            }
        }
    }

    public static String pattern() {
        return Keys.EVENTS_PATTERN;
    }
}
