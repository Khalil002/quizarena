using System.Security.Claims;
using System.Text;
using Dapper;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

namespace Quizarena.Api;

public sealed class UserDto
{
    public Guid Id { get; set; }
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Role { get; set; } = "";
}

/// <summary>The caller as the game engine sees them, read from JWT claims.</summary>
public sealed record CurrentUser(string Id, string DisplayName, string Role)
{
    public static CurrentUser From(ClaimsPrincipal p) =>
        new(p.FindFirstValue("sub")!, p.FindFirstValue("name") ?? "", p.FindFirstValue("role") ?? "player");

    public bool IsAdmin => Role == "admin";
}

/// <summary>Issues the HS256 token every backend accepts (claims: sub, email, name, role, iss=quizarena).</summary>
public sealed class TokenService(AppOptions options)
{
    public const string Issuer = "quizarena";

    public static SymmetricSecurityKey SigningKey(AppOptions options) => new(Encoding.UTF8.GetBytes(options.JwtSecret));

    public static TokenValidationParameters ValidationParameters(AppOptions options) => new()
    {
        ValidIssuer = Issuer,
        ValidateAudience = false,
        IssuerSigningKey = SigningKey(options),
        ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
        RoleClaimType = "role",
        NameClaimType = "name",
        ClockSkew = TimeSpan.FromSeconds(5),
    };

    public string Issue(UserDto user)
    {
        var now = DateTime.UtcNow;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            IssuedAt = now,
            NotBefore = now,
            Expires = now.AddSeconds(options.JwtTtlSec),
            Claims = new Dictionary<string, object>
            {
                ["sub"] = user.Id.ToString(), ["email"] = user.Email, ["name"] = user.DisplayName, ["role"] = user.Role,
            },
            SigningCredentials = new SigningCredentials(SigningKey(options), SecurityAlgorithms.HmacSha256),
        });
    }

    /// <summary>For the WebSocket handshake, where the token arrives as a query parameter.</summary>
    public async Task<bool> IsValid(string? token)
    {
        if (string.IsNullOrEmpty(token)) return false;
        var result = await new JsonWebTokenHandler().ValidateTokenAsync(token, ValidationParameters(options));
        return result.IsValid;
    }
}

public static class AuthEndpoints
{
    private const string UserColumns = "id, email, display_name, role";

    public sealed record Registration(string? Email, string? Password, string? DisplayName);
    public sealed record Login(string? Email, string? Password);

    private sealed class UserRow
    {
        public Guid Id { get; set; }
        public string Email { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public string Role { get; set; } = "";
        public string PasswordHash { get; set; } = "";
        public UserDto ToDto() => new() { Id = Id, Email = Email, DisplayName = DisplayName, Role = Role };
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapPost("/auth/register", Register);
        api.MapPost("/auth/login", LoginUser);
        api.MapGet("/me", Me).RequireAuthorization();
        api.MapGet("/me/matches", Matches).RequireAuthorization();
    }

    private static async Task<IResult> Register(Registration body, NpgsqlDataSource db, TokenService tokens)
    {
        var email = body.Email?.Trim().ToLowerInvariant() ?? "";
        var displayName = body.DisplayName?.Trim() ?? "";
        var problems = new List<string>();
        if (!Rules.IsEmail(email)) problems.Add("email: must be an email address");
        if (body.Password is not { Length: >= 8 and <= 72 }) problems.Add("password: must be 8-72 characters");
        if (displayName.Length is < 2 or > 24) problems.Add("displayName: must be 2-24 characters");
        if (problems.Count > 0) throw ApiException.Validation(string.Join("; ", problems));

        await using var conn = await db.OpenConnectionAsync();
        try
        {
            var user = await conn.QuerySingleAsync<UserDto>(
                $"INSERT INTO users (email, display_name, password_hash) VALUES (@email, @displayName, @hash) RETURNING {UserColumns}",
                new { email, displayName, hash = BCrypt.Net.BCrypt.HashPassword(body.Password, 10) });
            return Results.Json(new { token = tokens.Issue(user), user }, statusCode: 201);
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new ApiException(409, "EMAIL_TAKEN", "Email is already registered");
        }
    }

    private static async Task<IResult> LoginUser(Login body, NpgsqlDataSource db, TokenService tokens)
    {
        var email = body.Email?.Trim().ToLowerInvariant() ?? "";
        await using var conn = await db.OpenConnectionAsync();
        var row = await conn.QuerySingleOrDefaultAsync<UserRow>(
            $"SELECT {UserColumns}, password_hash FROM users WHERE lower(email) = @email", new { email });
        if (row is null || !BCrypt.Net.BCrypt.Verify(body.Password ?? "", row.PasswordHash))
            throw new ApiException(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
        var user = row.ToDto();
        return Results.Ok(new { token = tokens.Issue(user), user });
    }

    private static async Task<IResult> Me(ClaimsPrincipal principal, NpgsqlDataSource db)
    {
        await using var conn = await db.OpenConnectionAsync();
        var me = await conn.QuerySingleOrDefaultAsync<UserDto>(
            $"SELECT {UserColumns} FROM users WHERE id = @id", new { id = Guid.Parse(principal.FindFirstValue("sub")!) });
        return me is null ? throw ApiException.NotFound("User") : Results.Ok(me);
    }

    private sealed class MatchRow
    {
        public Guid MatchId { get; set; }
        public string QuizTitle { get; set; } = "";
        public string Code { get; set; } = "";
        public int Score { get; set; }
        public int CorrectCount { get; set; }
        public int Rank { get; set; }
        public int PlayerCount { get; set; }
        public DateTime FinishedAt { get; set; }
    }

    private static async Task<IResult> Matches(ClaimsPrincipal principal, NpgsqlDataSource db)
    {
        await using var conn = await db.OpenConnectionAsync();
        var rows = await conn.QueryAsync<MatchRow>(
            """
            SELECT m.id AS match_id, m.quiz_title, m.code, mp.score, mp.correct_count, mp.rank, m.player_count, m.finished_at
              FROM match_players mp JOIN matches m ON m.id = mp.match_id
             WHERE mp.user_id = @id ORDER BY m.finished_at DESC LIMIT 50
            """, new { id = Guid.Parse(principal.FindFirstValue("sub")!) });
        return Results.Ok(rows);
    }
}
