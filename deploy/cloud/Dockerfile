# syntax=docker/dockerfile:1.7

FROM maven:3.9.11-eclipse-temurin-17 AS build
WORKDIR /workspace

COPY pom.xml ./
COPY framework/pom.xml framework/pom.xml
COPY infra-ai/pom.xml infra-ai/pom.xml
COPY bootstrap/pom.xml bootstrap/pom.xml
COPY mcp-server/pom.xml mcp-server/pom.xml

RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -ntp -pl bootstrap,mcp-server -am dependency:go-offline

COPY resources/format/ resources/format/
COPY framework/src/ framework/src/
COPY infra-ai/src/ infra-ai/src/
COPY bootstrap/src/ bootstrap/src/
COPY mcp-server/src/ mcp-server/src/

RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -ntp -DskipTests -pl bootstrap,mcp-server -am package

FROM eclipse-temurin:17-jre-jammy AS backend
RUN groupadd --system --gid 10001 ragent \
    && useradd --system --uid 10001 --gid ragent --home-dir /app --shell /usr/sbin/nologin ragent
WORKDIR /app
COPY --from=build --chown=ragent:ragent /workspace/bootstrap/target/bootstrap-*.jar /app/app.jar
USER ragent
EXPOSE 9090
ENTRYPOINT ["java", "-jar", "/app/app.jar"]

FROM eclipse-temurin:17-jre-jammy AS mcp-server
RUN groupadd --system --gid 10001 ragent \
    && useradd --system --uid 10001 --gid ragent --home-dir /app --shell /usr/sbin/nologin ragent
WORKDIR /app
COPY --from=build --chown=ragent:ragent /workspace/mcp-server/target/mcp-server-*.jar /app/app.jar
USER ragent
EXPOSE 9099
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
