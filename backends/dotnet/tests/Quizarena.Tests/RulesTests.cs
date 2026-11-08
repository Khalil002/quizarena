using Quizarena.Api;
using Xunit;

public class RulesTests
{
    [Theory]
    [InlineData(true, 0, 10, 1000)]
    [InlineData(true, 5_000, 10, 750)]
    [InlineData(true, 2_500, 20, 937)]
    [InlineData(true, 10_000, 10, 500)]
    [InlineData(true, 12_000, 10, 500)]
    [InlineData(true, -50, 10, 1000)]
    [InlineData(false, 0, 10, 0)]
    public void ScoresLikeTheOtherBackends(bool correct, long elapsedMs, int limitSec, int expected) =>
        Assert.Equal(expected, Rules.Points(correct, elapsedMs, limitSec));

    [Fact]
    public void RoomCodesUseTheUnambiguousAlphabet()
    {
        Assert.Equal("AAAAAA", Rules.RoomCode(_ => 0));
        Assert.Equal("999999", Rules.RoomCode(n => n - 1));
        Assert.Matches(Rules.CodeRegex(), Rules.RoomCode(System.Security.Cryptography.RandomNumberGenerator.GetInt32));
    }

    [Fact]
    public void PlayersSortByScoreThenNameThenId()
    {
        var sorted = Rules.SortPlayers([
            new("b", "Zed", 10), new("c", "Amy", 10), new("a", "Amy", 10), new("d", "Bob", 900),
        ]);
        Assert.Equal(["d", "a", "c", "b"], sorted.Select(p => p.UserId));
    }

    [Fact]
    public void TiedScoresShareARank()
    {
        long[] all = [900, 500, 500, 0];
        Assert.Equal([1, 2, 2, 4], all.Select(s => Rules.RankOf(s, all)));
    }

    [Fact]
    public void RateWindowsAndTimestamps()
    {
        Assert.Equal(new Rules.RateWindow(2, 60), Rules.RateWindowAt(120_000, 60));
        Assert.Equal(new Rules.RateWindow(2, 1), Rules.RateWindowAt(179_500, 60));
        Assert.Equal("1970-01-01T00:00:05.000Z", Rules.Iso(5_000));
    }
}
