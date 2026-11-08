package dev.quizarena;

import static org.assertj.core.api.Assertions.assertThat;

import dev.quizarena.config.Rules;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

class RulesTest {
    @Test
    void correctAnswersEarn500PlusSpeedBonus() {
        assertThat(Rules.points(true, 0, 10)).isEqualTo(1000);
        assertThat(Rules.points(true, 5_000, 10)).isEqualTo(750);
        assertThat(Rules.points(true, 2_500, 20)).isEqualTo(937);
        assertThat(Rules.points(true, 10_000, 10)).isEqualTo(500);
        assertThat(Rules.points(true, 12_000, 10)).isEqualTo(500);
        assertThat(Rules.points(true, -50, 10)).isEqualTo(1000);
        assertThat(Rules.points(false, 0, 10)).isZero();
    }

    @Test
    void roomCodesUseTheUnambiguousAlphabet() {
        assertThat(Rules.roomCode(n -> 0)).isEqualTo("AAAAAA");
        assertThat(Rules.roomCode(n -> n - 1)).isEqualTo("999999");
    }

    @Test
    void playersSortByScoreThenNameThenId() {
        List<Rules.Player> sorted = Rules.sortPlayers(List.of(
                new Rules.Player("b", "Zed", 10), new Rules.Player("c", "Amy", 10),
                new Rules.Player("a", "Amy", 10), new Rules.Player("d", "Bob", 900)));
        assertThat(sorted).extracting(Rules.Player::userId).containsExactly("d", "a", "c", "b");
    }

    @Test
    void tiedScoresShareARank() {
        List<Long> all = List.of(900L, 500L, 500L, 0L);
        assertThat(all.stream().map(s -> Rules.rankOf(s, all)).toList()).containsExactly(1, 2, 2, 4);
    }

    @Test
    void rateWindowsAndTimestamps() {
        assertThat(Rules.rateWindow(120_000, 60)).isEqualTo(new Rules.RateWindow(2, 60));
        assertThat(Rules.rateWindow(179_500, 60)).isEqualTo(new Rules.RateWindow(2, 1));
        assertThat(Rules.iso(Instant.parse("2026-01-01T00:00:05Z"))).isEqualTo("2026-01-01T00:00:05.000Z");
    }
}
