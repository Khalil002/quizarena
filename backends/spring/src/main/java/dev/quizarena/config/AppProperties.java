package dev.quizarena.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String jwtSecret,
        long jwtTtlSec,
        long roomTtlSec,
        int rateLimitMax,
        int rateLimitWindowSec,
        long cacheTtlSec,
        long archiveIntervalMs,
        String consumerName) {}
