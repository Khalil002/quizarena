package dev.quizarena.quizzes;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

public record Question(
        @NotBlank @Size(max = 300) String prompt,
        @NotNull @Size(min = 2, max = 4) List<@NotBlank @Size(max = 100) String> options,
        @NotNull @Min(0) Integer correctIndex,
        @NotNull @Min(5) @Max(120) Integer timeLimitSec) {

    Question trimmed() {
        return new Question(prompt.trim(), options.stream().map(String::trim).toList(), correctIndex, timeLimitSec);
    }
}
