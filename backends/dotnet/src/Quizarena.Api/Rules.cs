using System.Text.RegularExpressions;

namespace Quizarena.Api;

/// <summary>Pure game rules, identical in every backend.</summary>
public static partial class Rules
{
    /// <summary>Room codes avoid look-alike characters (no I, O, 0, 1).</summary>
    public const string CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    [GeneratedRegex("^[A-Z2-9]{6}$")]
    public static partial Regex CodeRegex();

    [GeneratedRegex(@"^[^\s@]+@[^\s@]+\.[^\s@]+$")]
    private static partial Regex EmailRegex();

    public static string RoomCode(Func<int, int> pick)
    {
        var chars = new char[6];
        for (var i = 0; i < 6; i++) chars[i] = CodeAlphabet[pick(CodeAlphabet.Length)];
        return new string(chars);
    }

    /// <summary>500 for a correct answer plus up to 500 for speed, timed on the server; 0 if wrong.</summary>
    public static int Points(bool correct, long elapsedMs, int timeLimitSec)
    {
        if (!correct) return 0;
        long limitMs = timeLimitSec * 1000L;
        var left = Math.Min(limitMs, Math.Max(0, limitMs - elapsedMs));
        return 500 + (int)(500 * left / limitMs);
    }

    public sealed record Player(string UserId, string DisplayName, long Score);

    /// <summary>Score descending, then display name, then id (ordinal), the same in every backend.</summary>
    public static List<Player> SortPlayers(IEnumerable<Player> players) =>
        players.OrderByDescending(p => p.Score)
            .ThenBy(p => p.DisplayName, StringComparer.Ordinal)
            .ThenBy(p => p.UserId, StringComparer.Ordinal)
            .ToList();

    /// <summary>Competition ranking: 1 + the number of players with a strictly higher score.</summary>
    public static int RankOf(long score, IReadOnlyCollection<long> all) => 1 + all.Count(s => s > score);

    public readonly record struct RateWindow(long Window, long RetryAfterSec);

    public static RateWindow RateWindowAt(long nowMs, int windowSec)
    {
        var nowSec = nowMs / 1000;
        var window = nowSec / windowSec;
        return new RateWindow(window, Math.Max(1, (window + 1) * windowSec - nowSec));
    }

    public static bool IsEmail(string value) => value.Length <= 254 && EmailRegex().IsMatch(value);

    public static string Iso(DateTime utc) => utc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    public static string Iso(long epochMs) => Iso(DateTimeOffset.FromUnixTimeMilliseconds(epochMs).UtcDateTime);
}
