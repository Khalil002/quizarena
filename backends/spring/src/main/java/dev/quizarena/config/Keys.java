package dev.quizarena.config;

/** Redis key names shared by all three backends. */
public final class Keys {
    private Keys() {}

    public static String room(String code) { return "qa:room:" + code; }
    public static String players(String code) { return "qa:room:" + code + ":players"; }
    public static String scores(String code) { return "qa:room:" + code + ":scores"; }
    public static String correct(String code) { return "qa:room:" + code + ":correct"; }
    public static String answers(String code, int index) { return "qa:room:" + code + ":answers:" + index; }
    public static String events(String code) { return "qa:events:" + code; }
    public static final String EVENTS_PATTERN = "qa:events:*";
    public static final String ARCHIVE_STREAM = "qa:stream:archive";
    public static final String ARCHIVE_GROUP = "archivers";
    public static final String LEADERBOARD_CACHE = "qa:cache:leaderboard";
    public static String rateLimit(String userId, long window) { return "qa:rl:" + userId + ":" + window; }
}
