package dev.quizarena.config;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.List;
import java.util.function.IntUnaryOperator;
import java.util.regex.Pattern;

/** Pure game rules, identical in every backend. */
public final class Rules {
    private Rules() {}

    /** Room codes avoid look-alike characters (no I, O, 0, 1). */
    public static final String CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    public static final Pattern CODE_RE = Pattern.compile("^[A-Z2-9]{6}$");
    private static final Pattern UUID_RE =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    private static final DateTimeFormatter ISO_MILLIS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    public static String roomCode(IntUnaryOperator pick) {
        StringBuilder code = new StringBuilder();
        for (int i = 0; i < 6; i++) code.append(CODE_ALPHABET.charAt(pick.applyAsInt(CODE_ALPHABET.length())));
        return code.toString();
    }

    /** 500 for a correct answer plus up to 500 for speed, timed on the server; 0 if wrong. */
    public static int points(boolean correct, long elapsedMs, int timeLimitSec) {
        if (!correct) return 0;
        long limitMs = timeLimitSec * 1000L;
        long left = Math.min(limitMs, Math.max(0, limitMs - elapsedMs));
        return 500 + (int) Math.floorDiv(500 * left, limitMs);
    }

    public record Player(String userId, String displayName, long score) {}

    /** Score descending, then display name, then id (ordinal), the same in every backend. */
    public static List<Player> sortPlayers(List<Player> players) {
        return players.stream()
                .sorted(Comparator.comparingLong(Player::score).reversed()
                        .thenComparing(Player::displayName)
                        .thenComparing(Player::userId))
                .toList();
    }

    /** Competition ranking: 1 + the number of players with a strictly higher score. */
    public static int rankOf(long score, List<Long> all) {
        return 1 + (int) all.stream().filter(s -> s > score).count();
    }

    public record RateWindow(long window, long retryAfterSec) {}

    public static RateWindow rateWindow(long nowMs, int windowSec) {
        long nowSec = Math.floorDiv(nowMs, 1000);
        long window = Math.floorDiv(nowSec, windowSec);
        return new RateWindow(window, Math.max(1, (window + 1) * windowSec - nowSec));
    }

    public static boolean isUuid(String value) {
        return value != null && UUID_RE.matcher(value).matches();
    }

    public static String iso(Instant instant) {
        return ISO_MILLIS.format(instant);
    }
}
