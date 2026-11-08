package dev.quizarena;

import dev.quizarena.config.AppProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(AppProperties.class)
public class QuizarenaApplication {
    public static void main(String[] args) {
        SpringApplication.run(QuizarenaApplication.class, args);
    }
}
