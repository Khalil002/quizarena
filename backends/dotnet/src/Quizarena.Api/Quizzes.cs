using Dapper;
using Npgsql;

namespace Quizarena.Api;

public sealed class Question
{
    public string Prompt { get; set; } = "";
    public string[] Options { get; set; } = [];
    public int CorrectIndex { get; set; }
    public int TimeLimitSec { get; set; }
}

public sealed record Quiz(Guid Id, string Title, Guid OwnerId, DateTime CreatedAt, List<Question> Questions);

public sealed class QuizRepository(NpgsqlDataSource db)
{
    private sealed class Head
    {
        public Guid Id { get; set; }
        public string Title { get; set; } = "";
        public Guid OwnerId { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    public async Task<Quiz?> Find(string id)
    {
        if (!Guid.TryParseExact(id, "D", out var quizId)) return null;
        await using var conn = await db.OpenConnectionAsync();
        var head = await conn.QuerySingleOrDefaultAsync<Head>(
            "SELECT id, title, owner_id, created_at FROM quizzes WHERE id = @quizId", new { quizId });
        if (head is null) return null;
        var questions = await conn.QueryAsync<Question>(
            "SELECT prompt, options, correct_index, time_limit_sec FROM questions WHERE quiz_id = @quizId ORDER BY position",
            new { quizId });
        return new Quiz(head.Id, head.Title, head.OwnerId, head.CreatedAt, questions.ToList());
    }

    public async Task<Guid> Create(Guid ownerId, string title, IReadOnlyList<Question> questions)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        var id = await conn.QuerySingleAsync<Guid>(
            "INSERT INTO quizzes (owner_id, title) VALUES (@ownerId, @title) RETURNING id", new { ownerId, title }, tx);
        for (var position = 0; position < questions.Count; position++)
        {
            var q = questions[position];
            await conn.ExecuteAsync(
                """
                INSERT INTO questions (quiz_id, position, prompt, options, correct_index, time_limit_sec)
                VALUES (@id, @position, @prompt, @options, @correctIndex, @timeLimitSec)
                """, new { id, position, prompt = q.Prompt, options = q.Options, correctIndex = q.CorrectIndex, timeLimitSec = q.TimeLimitSec }, tx);
        }
        await tx.CommitAsync();
        return id;
    }

    public async Task Delete(Guid id)
    {
        await using var conn = await db.OpenConnectionAsync();
        await conn.ExecuteAsync("DELETE FROM quizzes WHERE id = @id", new { id });
    }
}

public static class QuizEndpoints
{
    public sealed record QuestionInput(string? Prompt, string?[]? Options, int? CorrectIndex, int? TimeLimitSec);
    public sealed record NewQuiz(string? Title, QuestionInput?[]? Questions);

    private sealed class SummaryRow
    {
        public Guid Id { get; set; }
        public string Title { get; set; } = "";
        public Guid OwnerId { get; set; }
        public int QuestionCount { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    public static void Map(RouteGroupBuilder api)
    {
        var group = api.MapGroup("/quizzes").RequireAuthorization();
        group.MapGet("/", List);
        group.MapPost("/", Create);
        group.MapGet("/{quizId}", Get);
        group.MapDelete("/{quizId}", Delete);
    }

    private static async Task<IResult> List(NpgsqlDataSource db)
    {
        await using var conn = await db.OpenConnectionAsync();
        var rows = await conn.QueryAsync<SummaryRow>(
            """
            SELECT q.id, q.title, q.owner_id, COUNT(qs.id)::int AS question_count, q.created_at
              FROM quizzes q LEFT JOIN questions qs ON qs.quiz_id = q.id
             GROUP BY q.id ORDER BY q.created_at DESC LIMIT 100
            """);
        return Results.Ok(rows);
    }

    internal static List<Question> Validate(NewQuiz body, out string title)
    {
        var problems = new List<string>();
        title = body.Title?.Trim() ?? "";
        if (title.Length is < 1 or > 120) problems.Add("title: must be 1-120 characters");
        var questions = new List<Question>();
        if (body.Questions is not { Length: >= 1 and <= 50 }) problems.Add("questions: must have 1-50 items");
        for (var i = 0; i < (body.Questions?.Length ?? 0); i++)
        {
            var q = body.Questions![i];
            var prompt = q?.Prompt?.Trim() ?? "";
            var options = q?.Options?.Select(o => o?.Trim() ?? "").ToArray() ?? [];
            if (prompt.Length is < 1 or > 300) problems.Add($"questions.{i}.prompt: must be 1-300 characters");
            if (options.Length is < 2 or > 4) problems.Add($"questions.{i}.options: must have 2-4 items");
            if (options.Any(o => o.Length is < 1 or > 100)) problems.Add($"questions.{i}.options: each must be 1-100 characters");
            if (q?.CorrectIndex is not { } ci || ci < 0 || ci >= options.Length) problems.Add($"questions.{i}.correctIndex: must point at an option");
            if (q?.TimeLimitSec is not (>= 5 and <= 120)) problems.Add($"questions.{i}.timeLimitSec: must be 5-120");
            questions.Add(new Question { Prompt = prompt, Options = options, CorrectIndex = q?.CorrectIndex ?? 0, TimeLimitSec = q?.TimeLimitSec ?? 0 });
        }
        if (problems.Count > 0) throw ApiException.Validation(string.Join("; ", problems));
        return questions;
    }

    private static async Task<IResult> Create(NewQuiz body, HttpContext ctx, QuizRepository quizzes)
    {
        var questions = Validate(body, out var title);
        var id = await quizzes.Create(Guid.Parse(CurrentUser.From(ctx.User).Id), title, questions);
        return Results.Json(await quizzes.Find(id.ToString()), statusCode: 201);
    }

    /// <summary>Resource-level authorization: owners and admins only.</summary>
    private static async Task<Quiz> Owned(string quizId, HttpContext ctx, QuizRepository quizzes)
    {
        var quiz = await quizzes.Find(quizId) ?? throw ApiException.NotFound("Quiz");
        var user = CurrentUser.From(ctx.User);
        if (quiz.OwnerId.ToString() != user.Id && !user.IsAdmin)
            throw new ApiException(403, "FORBIDDEN", "Only the owner or an admin can do this");
        return quiz;
    }

    private static async Task<IResult> Get(string quizId, HttpContext ctx, QuizRepository quizzes) =>
        Results.Ok(await Owned(quizId, ctx, quizzes));

    private static async Task<IResult> Delete(string quizId, HttpContext ctx, QuizRepository quizzes)
    {
        await quizzes.Delete((await Owned(quizId, ctx, quizzes)).Id);
        return Results.NoContent();
    }
}
