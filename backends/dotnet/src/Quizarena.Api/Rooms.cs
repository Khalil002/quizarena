using System.Security.Cryptography;
using System.Text.Json;
using StackExchange.Redis;

namespace Quizarena.Api;

/// <summary>
/// The live game lives in Redis (same keys as the other backends), so any instance can serve
/// any room. Every change is published on qa:events:{code} for the WebSocket fan-out.
/// </summary>
public sealed class RoomService(IConnectionMultiplexer redis, AppOptions options, JsonSerializerOptions json)
{
    private IDatabase Db => redis.GetDatabase();

    public sealed record Meta(string Code, string MatchId, string QuizId, string QuizTitle, string HostId, string State,
        int QuestionIndex, long QuestionStartedAt, List<Question> Quiz);

    public async Task<Meta> Load(string code)
    {
        var h = Rules.CodeRegex().IsMatch(code)
            ? (await Db.HashGetAllAsync(Keys.Room(code))).ToDictionary(e => e.Name.ToString(), e => e.Value.ToString())
            : [];
        if (!h.TryGetValue("matchId", out var matchId)) throw ApiException.NotFound("Room");
        return new Meta(code, matchId, h["quizId"], h["quizTitle"], h["hostId"], h["state"],
            int.Parse(h["questionIndex"]), long.Parse(h["questionStartedAt"]),
            JsonSerializer.Deserialize<List<Question>>(h["quiz"], json)!);
    }

    private async Task Touch(string code, int questionCount)
    {
        var ttl = TimeSpan.FromSeconds(options.RoomTtlSec);
        var keys = new List<string> { Keys.Room(code), Keys.Players(code), Keys.Scores(code), Keys.Correct(code) };
        for (var i = 0; i < questionCount; i++) keys.Add(Keys.Answers(code, i));
        await Task.WhenAll(keys.Select(k => Db.KeyExpireAsync(k, ttl)));
    }

    public async Task<object> View(string code) => await View(await Load(code));

    /// <summary>The public view of a room; correct answers appear only once revealed.</summary>
    public async Task<object> View(Meta m)
    {
        var names = await Db.HashGetAllAsync(Keys.Players(m.Code));
        var scores = (await Db.SortedSetRangeByRankWithScoresAsync(Keys.Scores(m.Code)))
            .ToDictionary(e => e.Element.ToString(), e => (long)e.Score);
        var players = Rules.SortPlayers(names.Select(n =>
            new Rules.Player(n.Name!, n.Value!, scores.GetValueOrDefault(n.Name.ToString()))));

        var open = m.State is "question" or "reveal";
        object? question = null;
        long answered = 0;
        if (open)
        {
            var q = m.Quiz[m.QuestionIndex];
            question = new
            {
                index = m.QuestionIndex,
                prompt = q.Prompt,
                options = q.Options,
                timeLimitSec = q.TimeLimitSec,
                deadline = Rules.Iso(m.QuestionStartedAt + q.TimeLimitSec * 1000L),
                correctIndex = m.State == "reveal" ? q.CorrectIndex : (int?)null,
            };
            answered = await Db.HashLengthAsync(Keys.Answers(m.Code, m.QuestionIndex));
        }
        return new
        {
            code = m.Code, matchId = m.MatchId, quizId = m.QuizId, quizTitle = m.QuizTitle, hostId = m.HostId,
            state = m.State, questionIndex = m.QuestionIndex, questionCount = m.Quiz.Count,
            question, answeredCount = answered, players,
        };
    }

    /// <summary>Pushes the new state to every WebSocket, on every instance, via Redis pub/sub.</summary>
    private async Task<object> Broadcast(Meta m)
    {
        var room = await View(m);
        await redis.GetSubscriber().PublishAsync(RedisChannel.Literal(Keys.Events(m.Code)), JsonSerializer.Serialize(room, json));
        return room;
    }

    public async Task<object> Create(CurrentUser host, Quiz quiz)
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            var code = Rules.RoomCode(RandomNumberGenerator.GetInt32);
            // HSETNX on matchId claims the code atomically.
            if (!await Db.HashSetAsync(Keys.Room(code), "matchId", Guid.NewGuid().ToString(), When.NotExists)) continue;
            await Db.HashSetAsync(Keys.Room(code), [
                new("quizId", quiz.Id.ToString()), new("quizTitle", quiz.Title), new("hostId", host.Id),
                new("state", "lobby"), new("questionIndex", -1), new("questionStartedAt", 0),
                new("quiz", JsonSerializer.Serialize(quiz.Questions, json)),
            ]);
            await Touch(code, quiz.Questions.Count);
            return await View(code);
        }
        throw new InvalidOperationException("could not allocate a room code");
    }

    public async Task<object> Join(string code, CurrentUser user)
    {
        var m = await Load(code);
        if (m.HostId == user.Id) throw new ApiException(409, "HOST_CANNOT_JOIN", "The host runs the game and cannot play");
        if (await Db.HashExistsAsync(Keys.Players(code), user.Id)) return await View(m);
        if (m.State != "lobby") throw new ApiException(409, "ROOM_STARTED", "This game has already started");
        await Db.HashSetAsync(Keys.Players(code), user.Id, user.DisplayName);
        await Db.SortedSetAddAsync(Keys.Scores(code), user.Id, 0, When.NotExists);
        await Touch(code, m.Quiz.Count);
        return await Broadcast(m);
    }

    private static void RequireHost(Meta m, CurrentUser user)
    {
        if (m.HostId != user.Id) throw new ApiException(403, "NOT_HOST", "Only the host can do this");
    }

    public async Task<object> Start(string code, CurrentUser user)
    {
        var m = await Load(code);
        RequireHost(m, user);
        if (m.State != "lobby") throw new ApiException(409, "ROOM_STARTED", "This game has already started");
        if (await Db.HashLengthAsync(Keys.Players(code)) == 0) throw new ApiException(409, "NO_PLAYERS", "Wait for at least one player");
        return await OpenQuestion(m, 0);
    }

    private async Task<object> OpenQuestion(Meta m, int index)
    {
        var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await Db.HashSetAsync(Keys.Room(m.Code), [new("state", "question"), new("questionIndex", index), new("questionStartedAt", startedAt)]);
        return await Broadcast(m with { State = "question", QuestionIndex = index, QuestionStartedAt = startedAt });
    }

    public async Task<object> Next(string code, CurrentUser user)
    {
        var m = await Load(code);
        RequireHost(m, user);
        switch (m.State)
        {
            case "lobby": throw new ApiException(409, "ROOM_NOT_STARTED", "Start the game first");
            case "finished": throw new ApiException(409, "ROOM_FINISHED", "This game is over");
            case "question":
                await Db.HashSetAsync(Keys.Room(code), "state", "reveal");
                return await Broadcast(m with { State = "reveal" });
            default:
                if (m.QuestionIndex + 1 < m.Quiz.Count) return await OpenQuestion(m, m.QuestionIndex + 1);
                await Db.HashSetAsync(Keys.Room(code), "state", "finished");
                // Hand the result to the archive worker (any instance) through a Redis stream.
                await Db.StreamAddAsync(Keys.ArchiveStream, [new("matchId", m.MatchId), new("code", code)]);
                return await Broadcast(m with { State = "finished" });
        }
    }

    public async Task<object> Answer(string code, CurrentUser user, int questionIndex, int optionIndex)
    {
        var m = await Load(code);
        if (!await Db.HashExistsAsync(Keys.Players(code), user.Id))
            throw new ApiException(403, "NOT_A_PLAYER", "Join the room before answering");
        var elapsed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - m.QuestionStartedAt;
        var q = questionIndex < m.Quiz.Count ? m.Quiz[questionIndex] : null;
        if (m.State != "question" || questionIndex != m.QuestionIndex || q is null || elapsed > q.TimeLimitSec * 1000L)
            throw new ApiException(409, "QUESTION_CLOSED", "That question is not open for answers");
        if (optionIndex >= q.Options.Length)
            throw ApiException.Validation("optionIndex: out of range");
        if (!await Db.HashSetAsync(Keys.Answers(code, questionIndex), user.Id, optionIndex, When.NotExists))
            throw new ApiException(409, "ALREADY_ANSWERED", "You already answered this question");
        var earned = Rules.Points(optionIndex == q.CorrectIndex, elapsed, q.TimeLimitSec);
        if (earned > 0)
        {
            await Db.SortedSetIncrementAsync(Keys.Scores(code), user.Id, earned);
            await Db.HashIncrementAsync(Keys.Correct(code), user.Id);
        }
        await Touch(code, m.Quiz.Count);
        await Broadcast(m);
        return new { accepted = true };
    }
}

public static class RoomEndpoints
{
    public sealed record NewRoom(string? QuizId);
    public sealed record AnswerBody(int? QuestionIndex, int? OptionIndex);

    public static void Map(RouteGroupBuilder api)
    {
        var rooms = api.MapGroup("/rooms").RequireAuthorization();
        rooms.MapPost("/", Create);
        rooms.MapGet("/{code}", (string code, RoomService s) => s.View(code));
        rooms.MapPost("/{code}/join", (string code, HttpContext ctx, RoomService s) => s.Join(code, CurrentUser.From(ctx.User)));
        rooms.MapPost("/{code}/start", (string code, HttpContext ctx, RoomService s) => s.Start(code, CurrentUser.From(ctx.User)));
        rooms.MapPost("/{code}/next", (string code, HttpContext ctx, RoomService s) => s.Next(code, CurrentUser.From(ctx.User)));
        rooms.MapPost("/{code}/answer", (string code, AnswerBody body, HttpContext ctx, RoomService s) =>
        {
            if (body.QuestionIndex is not >= 0 || body.OptionIndex is not >= 0)
                throw ApiException.Validation("questionIndex and optionIndex: required, 0 or more");
            return s.Answer(code, CurrentUser.From(ctx.User), body.QuestionIndex.Value, body.OptionIndex.Value);
        });
    }

    private static async Task<IResult> Create(NewRoom body, HttpContext ctx, RoomService rooms, QuizRepository quizzes,
        IConnectionMultiplexer redis, AppOptions options)
    {
        var user = CurrentUser.From(ctx.User);
        // Per-user fixed-window limit on hosting rooms.
        var w = Rules.RateWindowAt(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), options.RateLimitWindowSec);
        var key = Keys.RateLimit(user.Id, w.Window);
        var count = await redis.GetDatabase().StringIncrementAsync(key);
        if (count == 1) await redis.GetDatabase().KeyExpireAsync(key, TimeSpan.FromSeconds(options.RateLimitWindowSec));
        if (count > options.RateLimitMax)
            throw new ApiException(429, "RATE_LIMITED", "Too many rooms, slow down", null,
                new Dictionary<string, string> { ["Retry-After"] = w.RetryAfterSec.ToString() });

        if (!Guid.TryParse(body.QuizId, out _)) throw ApiException.Validation("quizId: must be a uuid");
        var quiz = await quizzes.Find(body.QuizId!) ?? throw ApiException.NotFound("Quiz");
        return Results.Json(await rooms.Create(user, quiz), statusCode: 201);
    }
}
