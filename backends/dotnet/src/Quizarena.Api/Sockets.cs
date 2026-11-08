using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using StackExchange.Redis;

namespace Quizarena.Api;

/// <summary>
/// WebSocket fan-out. Every instance pattern-subscribes to qa:events:* and forwards each room
/// update to the sockets it holds for that room, so players on different instances see the
/// same game.
/// </summary>
public sealed class RoomSockets(IConnectionMultiplexer redis, RoomService rooms, TokenService tokens, JsonSerializerOptions json,
    ILogger<RoomSockets> logger) : IHostedService
{
    private sealed class Client(WebSocket socket)
    {
        public WebSocket Socket { get; } = socket;
        public SemaphoreSlim SendLock { get; } = new(1, 1);
    }

    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Client>> _byRoom = new();

    public async Task StartAsync(CancellationToken ct)
    {
        await redis.GetSubscriber().SubscribeAsync(RedisChannel.Pattern(Keys.EventsPattern), (channel, message) =>
        {
            var name = channel.ToString();
            var code = name[(name.LastIndexOf(':') + 1)..];
            if (!_byRoom.TryGetValue(code, out var clients)) return;
            var frame = Encoding.UTF8.GetBytes($"{{\"type\":\"room.updated\",\"room\":{message}}}");
            foreach (var client in clients.Values) _ = Send(client, frame);
        });
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;

    private async Task Send(Client client, byte[] frame)
    {
        await client.SendLock.WaitAsync();
        try
        {
            if (client.Socket.State == WebSocketState.Open)
                await client.Socket.SendAsync(frame, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (Exception e)
        {
            logger.LogDebug("socket send failed: {Message}", e.Message);
        }
        finally
        {
            client.SendLock.Release();
        }
    }

    public async Task Handle(HttpContext ctx, string code)
    {
        if (!ctx.WebSockets.IsWebSocketRequest)
        {
            ctx.Response.StatusCode = 400;
            return;
        }
        using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
        // Browsers cannot read HTTP errors on an upgrade, so failures are close codes.
        if (!await tokens.IsValid(ctx.Request.Query["token"]))
        {
            await socket.CloseAsync((WebSocketCloseStatus)4401, "unauthorized", CancellationToken.None);
            return;
        }
        object snapshot;
        try
        {
            snapshot = await rooms.View(code);
        }
        catch (ApiException)
        {
            await socket.CloseAsync((WebSocketCloseStatus)4404, "room not found", CancellationToken.None);
            return;
        }

        var id = Guid.NewGuid();
        var client = new Client(socket);
        _byRoom.GetOrAdd(code, _ => new()).TryAdd(id, client);
        try
        {
            await Send(client, JsonSerializer.SerializeToUtf8Bytes(new { type = "room.updated", room = snapshot }, json));
            var buffer = new byte[1024];
            // Clients only listen; read until they close.
            while (socket.State == WebSocketState.Open)
            {
                var result = await socket.ReceiveAsync(buffer, ctx.RequestAborted);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                    break;
                }
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException)
        {
            // client went away
        }
        finally
        {
            if (_byRoom.TryGetValue(code, out var clients))
            {
                clients.TryRemove(id, out _);
                if (clients.IsEmpty) _byRoom.TryRemove(code, out _);
            }
        }
    }
}
