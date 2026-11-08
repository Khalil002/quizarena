package dev.quizarena.quizzes;

import java.util.List;
import java.util.UUID;

public record Quiz(UUID id, String title, UUID ownerId, String createdAt, List<Question> questions) {}
