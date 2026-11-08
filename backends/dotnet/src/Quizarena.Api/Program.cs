using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http.Json;
using Npgsql;
using Quizarena.Api;
using StackExchange.Redis;

var options = AppOptions.FromEnvironment();
DefaultTypeMap.MatchNamesWithUnderscores = true;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{options.Port}");
builder.Logging.AddSimpleConsole(o => o.SingleLine = true);

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
json.Converters.Add(new UtcMillisConverter());
builder.Services.Configure<JsonOptions>(o => o.SerializerOptions.Converters.Add(new UtcMillisConverter()));
builder.Services.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true);

builder.Services.AddSingleton(options);
builder.Services.AddSingleton(json);
var dataSourceBuilder = new NpgsqlDataSourceBuilder(options.ConnectionString);
builder.Services.AddSingleton(dataSourceBuilder.Build());
builder.Services.AddSingleton<IConnectionMultiplexer>(
    ConnectionMultiplexer.Connect($"{options.RedisHost}:{options.RedisPort},abortConnect=false"));
builder.Services.AddSingleton<TokenService>();
builder.Services.AddSingleton<QuizRepository>();
builder.Services.AddSingleton<RoomService>();
builder.Services.AddSingleton<RoomSockets>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RoomSockets>());
builder.Services.AddHostedService<ArchiveWorker>();

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.MapInboundClaims = false; // keep "sub", "name" and "role" as-is
        o.TokenValidationParameters = TokenService.ValidationParameters(options);
        o.Events = new JwtBearerEvents
        {
            OnChallenge = ctx =>
            {
                ctx.HandleResponse();
                return Problems.Write(ctx.HttpContext, 401, "UNAUTHORIZED", "Missing, invalid or expired token");
            },
            OnForbidden = ctx => Problems.Write(ctx.HttpContext, 403, "FORBIDDEN", "Your role cannot do this"),
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(25) });
app.Use(Problems.Middleware);
app.UseAuthentication();
app.UseAuthorization();

var api = app.MapGroup("/api");
api.MapGet("/health", async (NpgsqlDataSource db, IConnectionMultiplexer redis) =>
{
    try
    {
        await using var conn = await db.OpenConnectionAsync();
        await conn.ExecuteScalarAsync<int>("SELECT 1");
        await redis.GetDatabase().PingAsync();
        return Results.Ok(new { status = "ok", backend = "dotnet" });
    }
    catch
    {
        return Results.Json(new { status = "degraded", backend = "dotnet" }, statusCode: 503);
    }
});
api.MapGet("/leaderboard", async (HttpContext ctx, NpgsqlDataSource db, IConnectionMultiplexer redis) =>
{
    // Cache-aside: the aggregate query runs at most once per CACHE_TTL_SEC.
    var cache = redis.GetDatabase();
    var cached = await cache.StringGetAsync(Keys.LeaderboardCache);
    if (cached.HasValue)
    {
        ctx.Response.Headers["X-Cache"] = "HIT";
        return Results.Content(cached.ToString(), "application/json");
    }
    await using var conn = await db.OpenConnectionAsync();
    var rows = await conn.QueryAsync<LeaderboardRow>(
        """
        SELECT mp.user_id, u.display_name, SUM(mp.score)::int AS total_score, COUNT(*)::int AS matches
          FROM match_players mp JOIN users u ON u.id = mp.user_id
         GROUP BY mp.user_id, u.display_name
         ORDER BY total_score DESC, u.display_name ASC LIMIT 10
        """);
    var body = JsonSerializer.Serialize(rows, json);
    await cache.StringSetAsync(Keys.LeaderboardCache, body, TimeSpan.FromSeconds(options.CacheTtlSec));
    ctx.Response.Headers["X-Cache"] = "MISS";
    return Results.Content(body, "application/json");
});
api.Map("/rooms/{code}/ws", (HttpContext ctx, string code, RoomSockets sockets) => sockets.Handle(ctx, code));
AuthEndpoints.Map(api);
QuizEndpoints.Map(api);
RoomEndpoints.Map(api);
api.MapFallback(() => { throw ApiException.NotFound("Route"); });

app.Run();

internal sealed class LeaderboardRow
{
    public Guid UserId { get; set; }
    public string DisplayName { get; set; } = "";
    public int TotalScore { get; set; }
    public int Matches { get; set; }
}

/// <summary>Writes timestamps as UTC ISO 8601 with millisecond precision, like the other backends.</summary>
internal sealed class UtcMillisConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTime().ToUniversalTime();

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) =>
        writer.WriteStringValue(Rules.Iso(value));
}
