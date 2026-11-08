using Quizarena.Api;
using Xunit;

public class QuizValidationTests
{
    private static QuizEndpoints.QuestionInput Q(int correct, int seconds = 10, params string[] options) =>
        new("Prompt", options.Length == 0 ? ["a", "b"] : options, correct, seconds);

    [Fact]
    public void AcceptsAndTrimsAValidQuiz()
    {
        var questions = QuizEndpoints.Validate(new(" Title ", [new(" Why? ", [" a ", "b"], 1, 30)]), out var title);
        Assert.Equal("Title", title);
        Assert.Equal("Why?", questions[0].Prompt);
        Assert.Equal(["a", "b"], questions[0].Options);
    }

    [Fact]
    public void RejectsACorrectIndexPastTheOptions() =>
        Assert.Throws<ApiException>(() => QuizEndpoints.Validate(new("t", [Q(2)]), out _));

    [Fact]
    public void RejectsTooFewOptionsAndTooShortTimers()
    {
        Assert.Throws<ApiException>(() => QuizEndpoints.Validate(new("t", [Q(0, 10, "only")]), out _));
        Assert.Throws<ApiException>(() => QuizEndpoints.Validate(new("t", [Q(0, 1)]), out _));
        Assert.Throws<ApiException>(() => QuizEndpoints.Validate(new("t", []), out _));
    }
}
