// ScoreGen — runs the C# ScoreComposer and prints its score JSON.
// Used to generate demo/public/gen/csharp-score.json:
//   dotnet run --project dotnet/ScoreGen -- 20261010 > demo/public/gen/csharp-score.json
using System.Text.Json;
using XrEngine.Providers;

int seed = args.Length > 0 && int.TryParse(args[0], out var s) ? s : 20261010;
var composer = new ScoreComposer();
var doc = composer.Compose(seed);
doc.Regenerate = "dotnet run --project dotnet/ScoreGen -- 20261010 > demo/public/gen/csharp-score.json";
Console.Write(JsonSerializer.Serialize(doc, new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = true,
}));
