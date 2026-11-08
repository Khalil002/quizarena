namespace Quizarena.Api;

/// <summary>Settings read from the same environment variables every backend uses.</summary>
public sealed record AppOptions
{
    public int Port { get; init; } = 8000;
    public string ConnectionString { get; init; } = "";
    public string RedisHost { get; init; } = "localhost";
    public int RedisPort { get; init; } = 6379;
    public string JwtSecret { get; init; } = "change-me-to-a-long-random-secret-of-32-bytes";
    public int JwtTtlSec { get; init; } = 3600;
    public int RoomTtlSec { get; init; } = 21600;
    public int RateLimitMax { get; init; } = 10;
    public int RateLimitWindowSec { get; init; } = 60;
    public int CacheTtlSec { get; init; } = 5;
    public int ArchiveIntervalMs { get; init; } = 1000;
    public string ConsumerName { get; init; } = "local";

    public static AppOptions FromEnvironment()
    {
        static string Str(string name, string fallback) =>
            Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : fallback;
        static int Int(string name, int fallback) => int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : fallback;

        return new AppOptions
        {
            Port = Int("PORT", 8000),
            ConnectionString = $"Host={Str("DB_HOST", "localhost")};Port={Int("DB_PORT", 5432)};Database={Str("DB_NAME", "quizarena")};" +
                               $"Username={Str("DB_USER", "quizarena")};Password={Str("DB_PASSWORD", "quizarena")};Maximum Pool Size=20",
            RedisHost = Str("REDIS_HOST", "localhost"),
            RedisPort = Int("REDIS_PORT", 6379),
            JwtSecret = Str("JWT_SECRET", "change-me-to-a-long-random-secret-of-32-bytes"),
            JwtTtlSec = Int("JWT_TTL_SEC", 3600),
            RoomTtlSec = Int("ROOM_TTL_SEC", 21600),
            RateLimitMax = Int("RATE_LIMIT_MAX", 10),
            RateLimitWindowSec = Int("RATE_LIMIT_WINDOW_SEC", 60),
            CacheTtlSec = Int("CACHE_TTL_SEC", 5),
            ArchiveIntervalMs = Int("ARCHIVE_INTERVAL_MS", 1000),
            // Stable per container, so a restarted worker picks up its own unacknowledged jobs.
            ConsumerName = Str("HOSTNAME", "local"),
        };
    }
}

/// <summary>Redis key names shared by all three backends.</summary>
public static class Keys
{
    public static string Room(string code) => $"qa:room:{code}";
    public static string Players(string code) => $"qa:room:{code}:players";
    public static string Scores(string code) => $"qa:room:{code}:scores";
    public static string Correct(string code) => $"qa:room:{code}:correct";
    public static string Answers(string code, int index) => $"qa:room:{code}:answers:{index}";
    public static string Events(string code) => $"qa:events:{code}";
    public const string EventsPattern = "qa:events:*";
    public const string ArchiveStream = "qa:stream:archive";
    public const string ArchiveGroup = "archivers";
    public const string LeaderboardCache = "qa:cache:leaderboard";
    public static string RateLimit(string userId, long window) => $"qa:rl:{userId}:{window}";
}
