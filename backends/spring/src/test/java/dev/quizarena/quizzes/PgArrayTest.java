package dev.quizarena.quizzes;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

class PgArrayTest {
    @Test
    void escapesQuotesAndBackslashes() {
        assertThat(QuizRepository.toPgArray(List.of("a", "say \"hi\"", "c\\d")))
                .isEqualTo("{\"a\",\"say \\\"hi\\\"\",\"c\\\\d\"}");
    }
}
