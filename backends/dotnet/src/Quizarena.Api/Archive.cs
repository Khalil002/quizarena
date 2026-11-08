using Dapper;
using Npgsql;
using StackExchange.Redis;

namespace Quizarena.Api;

/// <summary>
/// Consumer-group worker on qa:stream:archive. It first retries this consumer's own
/// unacknowledged jobs ("0"), then takes new ones (">"), and acknowledges a job only after its
/// rows are committed. Inserts are idempotent, so redelivery is harmless.
/// </summary>
public sealed class ArchiveWorker(IConnectionMultiplexer redis, NpgsqlDataSource db, AppOptions options, ILogger<ArchiveWorker> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Tick(); }
            catch (Exception e) when (!ct.IsCancellationRequested) { logger.LogWarning("archive tick failed: {Message}", e.Message); }
            try { await Task.Delay(options.ArchiveIntervalMs, ct); } catch (TaskCanceledException) { }
        }
    }

    private async Task EnsureGroup()
    {
        try
        {
            await redis.GetDatabase().StreamCreateConsumerGroupAsync(Keys.ArchiveStream, Keys.ArchiveGroup, "0", createStream: true);
        }
        catch (RedisServerException e) when (e.Message.Contains("BUSYGROUP")) { }
    }

    public async Task<int> Tick()
    {
        await EnsureGroup();
        var handled = 0;
        foreach (var position in new RedisValue[] { "0", ">" })
        {
            var entries = await redis.GetDatabase().StreamReadGroupAsync(
                Keys.ArchiveStream, Keys.ArchiveGroup, options.ConsumerName, position, count: 10);
            foreach (var entry in entries)
            {
                if (entry.IsNull) continue;
                var fields = entry.Values.ToDictionary(v => v.Name.ToString(), v => v.Value.ToString());
                await Archive(fields["matchId"], fields["code"]);
                await redis.GetDatabase().StreamAcknowledgeAsync(Keys.ArchiveStream, Keys.ArchiveGroup, entry.Id);
                handled++;
            }
        }
        return handled;
    }

    /// <summary>Copies a finished room from Redis into match history.</summary>
    private async Task Archive(string matchId, string code)
    {
        var r = redis.GetDatabase();
        var room = (await r.HashGetAllAsync(Keys.Room(code))).ToDictionary(e => e.Name.ToString(), e => e.Value.ToString());
        if (!room.TryGetValue("matchId", out var current) || current != matchId) return; // expired or reused code
        var names = await r.HashGetAllAsync(Keys.Players(code));
        var correct = (await r.HashGetAllAsync(Keys.Correct(code))).ToDictionary(e => e.Name.ToString(), e => (int)e.Value);
        var scores = (await r.SortedSetRangeByRankWithScoresAsync(Keys.Scores(code)))
            .ToDictionary(e => e.Element.ToString(), e => (long)e.Score);
        var all = names.Select(n => scores.GetValueOrDefault(n.Name.ToString())).ToList();

        await using var conn = await db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await conn.ExecuteAsync(
            """
            INSERT INTO matches (id, quiz_id, quiz_title, host_id, code, player_count)
            VALUES (@id, (SELECT id FROM quizzes WHERE id = @quizId), @title, @hostId, @code, @count) ON CONFLICT (id) DO NOTHING
            """,
            new { id = Guid.Parse(matchId), quizId = Guid.Parse(room["quizId"]), title = room["quizTitle"],
                  hostId = Guid.Parse(room["hostId"]), code, count = names.Length }, tx);
        foreach (var n in names)
        {
            var userId = n.Name.ToString();
            var score = scores.GetValueOrDefault(userId);
            await conn.ExecuteAsync(
                """
                INSERT INTO match_players (match_id, user_id, display_name, score, correct_count, rank)
                VALUES (@matchId, @userId, @name, @score, @correct, @rank) ON CONFLICT DO NOTHING
                """,
                new { matchId = Guid.Parse(matchId), userId = Guid.Parse(userId), name = n.Value.ToString(), score = (int)score,
                      correct = correct.GetValueOrDefault(userId), rank = Rules.RankOf(score, all) }, tx);
        }
        await tx.CommitAsync();
        await r.KeyDeleteAsync(Keys.LeaderboardCache);
    }
}
