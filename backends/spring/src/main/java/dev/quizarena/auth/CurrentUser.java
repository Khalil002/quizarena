package dev.quizarena.auth;

import org.springframework.security.oauth2.jwt.Jwt;

/** The caller as the game engine sees them, read from JWT claims. */
public record CurrentUser(String id, String displayName, String role) {
    public static CurrentUser of(Jwt jwt) {
        return new CurrentUser(jwt.getSubject(), jwt.getClaimAsString("name"), jwt.getClaimAsString("role"));
    }

    public boolean isAdmin() {
        return "admin".equals(role);
    }
}
