package dev.quizarena.auth;

import dev.quizarena.config.AppProperties;
import java.time.Instant;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Service;

/** Issues the HS256 token every backend accepts (claims: sub, email, name, role, iss=quizarena). */
@Service
public class TokenService {
    public static final String ISSUER = "quizarena";
    private final JwtEncoder encoder;
    private final JwtDecoder decoder;
    private final AppProperties props;

    public TokenService(JwtEncoder encoder, JwtDecoder decoder, AppProperties props) {
        this.encoder = encoder;
        this.decoder = decoder;
        this.props = props;
    }

    public String issue(UserDto user) {
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(ISSUER)
                .subject(user.id().toString())
                .issuedAt(now)
                .expiresAt(now.plusSeconds(props.jwtTtlSec()))
                .claim("email", user.email())
                .claim("name", user.displayName())
                .claim("role", user.role())
                .build();
        JwsHeader header = JwsHeader.with(MacAlgorithm.HS256).type("JWT").build();
        return encoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
    }

    /** For the WebSocket handshake, where the token arrives as a query parameter. */
    public Jwt verify(String token) {
        if (token == null || token.isBlank()) return null;
        try {
            return decoder.decode(token);
        } catch (JwtException e) {
            return null;
        }
    }
}
