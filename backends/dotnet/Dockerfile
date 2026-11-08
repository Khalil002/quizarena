FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/Quizarena.Api/Quizarena.Api.csproj src/Quizarena.Api/
RUN dotnet restore src/Quizarena.Api/Quizarena.Api.csproj
COPY src/ src/
RUN dotnet publish src/Quizarena.Api -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
USER app
EXPOSE 8000
ENTRYPOINT ["dotnet", "Quizarena.Api.dll"]
